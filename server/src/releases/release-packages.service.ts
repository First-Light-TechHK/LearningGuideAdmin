import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { FilesService } from '../files/files.service';
import {
  prepareKnowledgeImage,
  MAX_IMAGE_UPLOAD_BYTES,
} from '../files/knowledge-image';
import { IndexingService } from '../knowledge/indexing.service';
import { PrismaService } from '../prisma/prisma.service';
import { lockCourseRow } from '../prisma/course-lock';
import {
  TEACHING_PACKAGE_COMPILER,
  type TeachingPackageCompiler,
} from '../ks/contract/teaching-package-compiler';
import { teachingReferenceCatalogue } from '../ks/contract/teaching-references';
import {
  mergeApprovedCards,
  teachingPackageBase,
} from './teaching-card-publication';
import { AI_CONFIG_COPY_FIELDS } from './releases.service';
import {
  canonical,
  contentOf,
  fileSummary,
  invalid,
  makeMapping,
  pack,
  PACKAGE_BYTES,
  published,
  rebuild,
  reverseMapping,
  sha256,
  translate,
  unpack,
  type Manifest,
  type Transfer,
} from './release-package';

const binding = {
  externalId: true,
  commerceCourse: { select: { code: true } },
} as const;

@Injectable()
export class ReleasePackagesService {
  constructor(
    private readonly db: PrismaService,
    private readonly files: FilesService,
    private readonly indexing: IndexingService,
    @Inject(TEACHING_PACKAGE_COMPILER)
    private readonly compile: TeachingPackageCompiler,
  ) {}

  async download(id: string) {
    const r = await this.db.release.findUnique({
      where: { id },
      include: { course: { select: binding } },
    });
    if (!r) throw new NotFoundException('版本不存在');
    const snapshot = r.snapshotData as Prisma.JsonObject;
    const content = contentOf(snapshot);
    if (canonical(published(content)) !== canonical(snapshot.pages))
      invalid('发布页面与编辑快照不一致');
    if (snapshot.teachingPackage && !content.teachingPackageInput)
      invalid('此版本缺少教学包原始输入');
    const restored = snapshot.knowledgePackage as unknown as
      Transfer | undefined;
    const origin = restored?.origin ?? {
      courseId: r.courseId,
      releaseId: r.id,
      externalId: r.course.externalId,
      commerceCode: r.course.commerceCourse?.code ?? null,
    };
    const mapping = restored
      ? reverseMapping(restored.mapping)
      : makeMapping(content, origin, r.courseId);
    const assets = new Set<string>();
    const portable = translate(
      content,
      r.courseId,
      origin.courseId,
      mapping,
      assets,
    );
    rebuild(portable, origin.courseId, origin.releaseId, this.compile);
    const images = new Map<string, Buffer>();
    let total = 0;
    if (assets.size > 4094) throw new PayloadTooLargeException();
    for (const name of assets) {
      const asset = await this.files.getImage(r.courseId, name);
      if (!asset) invalid('版本图片不存在：' + name);
      total += asset.bytes.length;
      if (asset.bytes.length > MAX_IMAGE_UPLOAD_BYTES || total > PACKAGE_BYTES)
        throw new PayloadTooLargeException();
      await this.verifyImage(name, asset.bytes);
      images.set(mapping.images[name] ?? name, asset.bytes);
    }
    const manifest: Manifest = {
      format: 'knowledge-release-v1',
      origin,
      versionTag: r.versionTag,
      revisionNotes: r.revisionNotes,
      content: portable,
      images: fileSummary(images),
    };
    return {
      buffer: await pack(manifest, images),
      filename:
        r.versionTag.replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 100) +
        '.lgknowledge.zip',
    };
  }

  private async verifyImage(name: string, bytes: Buffer) {
    const checked = await prepareKnowledgeImage(bytes);
    if (!name.endsWith('.' + checked.extension) || !bytes.equals(checked.bytes))
      invalid('图片格式与文件名不符：' + name);
    return checked.extension;
  }

  async import(courseId: string, bytes: Buffer, apply: boolean) {
    const { manifest, images } = await unpack(bytes);
    const course = await this.db.course.findUnique({
      where: { id: courseId },
      select: { ...binding, editingReleaseId: true },
    });
    if (!course) throw new NotFoundException('目标课程不存在');
    if (course.externalId !== manifest.origin.externalId)
      throw new ConflictException('目标课程的外部课程标识与源课程不一致');
    if ((course.commerceCourse?.code ?? null) !== manifest.origin.commerceCode)
      throw new ConflictException('目标课程绑定的商品课程编号与源课程不一致');
    const mapping = makeMapping(manifest.content, manifest.origin, courseId);
    for (const [name, image] of images) {
      mapping.images[name] =
        randomUUID() + '.' + (await this.verifyImage(name, image));
    }
    const used = new Set<string>();
    const content = translate(
      manifest.content,
      manifest.origin.courseId,
      courseId,
      mapping,
      used,
    );
    for (const name of used)
      if (!images.has(name)) invalid('版本引用的图片缺失：' + name);
    if (used.size !== images.size) invalid('存在未引用的图片');
    const releaseId = randomUUID();
    const snapshot = rebuild(content, courseId, releaseId, this.compile);
    const digest = sha256(canonical(manifest));
    const where = {
      courseId,
      snapshotData: { path: ['knowledgePackage', 'digest'], equals: digest },
    };
    const existing = await this.db.release.findFirst({
      where,
      select: { id: true },
    });
    const summary = {
      versionTag: manifest.versionTag,
      sourceCourse: manifest.origin.externalId ?? manifest.origin.courseId,
      pages: content.editor.pages.length,
      cards: content.editor.cards.length,
      types: [
        ...content.editor.cards.reduce((counts, c) => {
          const type = c.deletedAt
            ? 'deleted'
            : typeof c.draft.type === 'string'
              ? c.draft.type
              : 'other';
          return counts.set(type, (counts.get(type) ?? 0) + 1);
        }, new Map<string, number>()),
      ].map(([type, count]) => ({ type, count })),
      images: images.size,
      conflicts: [] as string[],
    };
    if (existing) return { ...summary, id: existing.id, duplicate: true };

    const current = course.editingReleaseId
      ? await this.db.release.findUnique({
          where: { id: course.editingReleaseId },
          select: { snapshotData: true },
        })
      : null;
    const managed = await this.db.tutorTeachingCard.findMany({
      where: { courseId },
      select: { id: true, approved: true, reviewerId: true, deletedAt: true },
    });
    const currentRefs = teachingReferenceCatalogue(
      mergeApprovedCards(teachingPackageBase(current?.snapshotData), managed),
    );
    const byCode = new Map(
      [...currentRefs.values()]
        .filter((ref) => ref.code)
        .map((ref) => [ref.code!.normalize('NFKC').toLowerCase(), ref]),
    );
    for (const ref of teachingReferenceCatalogue(
      manifest.content.teachingPackageInput ?? undefined,
    ).values()) {
      if (!ref.code) continue;
      const local = byCode.get(ref.code.normalize('NFKC').toLowerCase());
      if (!local) continue;
      const same =
        local.kind === ref.kind &&
        (local.kind === 'latex'
          ? local.value === ref.value
          : (await this.files.getImage(courseId, local.value))?.bytes.equals(
              images.get(ref.value) ?? Buffer.alloc(0),
            ));
      if (!same) summary.conflicts.push(ref.code);
    }
    const checkIds = async (db: Prisma.TransactionClient) => {
      const pages = await db.page.count({
        where: {
          courseId: { not: courseId },
          id: { in: Object.values(mapping.pages) },
        },
      });
      const cards = await db.tutorTeachingCard.count({
        where: {
          courseId: { not: courseId },
          id: { in: Object.values(mapping.cards) },
        },
      });
      if (pages || cards)
        throw new ConflictException('版本内容 ID 与其他课程冲突');
    };
    await checkIds(this.db);
    if (!apply) return { ...summary, id: null, duplicate: false };

    // 每次尝试使用独立的资源名；重复提交或回滚只回收本次暂存的文件。
    const staged: string[] = [];
    try {
      for (const [name, image] of images) {
        await this.files.stageReleaseImage(
          courseId,
          mapping.images[name],
          image,
        );
        staged.push(mapping.images[name]);
      }
      const imported = await this.db.$transaction(async (tx) => {
        await lockCourseRow(tx, courseId);
        const target = await tx.course.findUniqueOrThrow({
          where: { id: courseId },
          select: {
            ...binding,
            currentReleaseId: true,
            aiTestReleaseId: true,
          },
        });
        if (
          target.externalId !== manifest.origin.externalId ||
          (target.commerceCourse?.code ?? null) !== manifest.origin.commerceCode
        )
          throw new ConflictException('目标课程绑定已改变');
        const repeated = await tx.release.findFirst({
          where,
          select: { id: true },
        });
        if (repeated) return repeated.id;
        await checkIds(tx);
        const transfer: Transfer = { origin: manifest.origin, mapping };
        await tx.release.create({
          data: {
            id: releaseId,
            courseId,
            versionTag: manifest.versionTag,
            revisionNotes: manifest.revisionNotes,
            snapshotData: JSON.parse(
              JSON.stringify({
                ...snapshot,
                knowledgePackage: { ...transfer, digest },
              }),
            ) as Prisma.InputJsonObject,
          },
        });
        const configSource = target.currentReleaseId ?? target.aiTestReleaseId;
        if (configSource) {
          const config = await tx.courseAiConfig.findUnique({
            where: {
              courseId_releaseId: { courseId, releaseId: configSource },
            },
            select: AI_CONFIG_COPY_FIELDS,
          });
          if (config)
            await tx.courseAiConfig.create({
              data: { ...config, courseId, releaseId },
            });
        }
        return releaseId;
      });
      if (imported === releaseId) {
        staged.length = 0;
        void this.indexing.indexRelease(releaseId).catch(() => undefined);
      }
      return { ...summary, id: imported, duplicate: imported !== releaseId };
    } finally {
      // 提交结果不明时保留资源，由既有未引用图片清理任务处理。
      if (
        staged.length &&
        (await this.db.release
          .count({ where: { id: releaseId } })
          .catch(() => 1)) === 0
      ) {
        for (const name of staged)
          await this.files.discardReleaseImage(courseId, name);
      }
    }
  }
}
