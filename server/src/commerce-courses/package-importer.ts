import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { PackageManifest, PackageExhibit } from './contracts/manifest';
import { CourseStorageService } from './storage.service';
import { COMMERCE_CONFIG, type CommerceCourseConfig } from './commerce.config';
import { validateMediaFile } from './media-validate';

export interface ImportOptions {
  onConflict: 'ABORT' | 'CREATE_NEW_COURSE' | 'NEW_VERSION';
  reassignCodes: boolean;
  actorEmployeeId: string | null;
}

export class ImportError extends Error {
  constructor(public code: string, public status: number, message: string) {
    super(message);
  }
}

/**
 * 把已校验的课程包写入数据库（媒体先转存再到 DB，失败回滚）。
 * 结果固定创建 Working copy / HIDDEN（跨环境状态不搬运，见 §17.2）。
 */
@Injectable()
export class PackageImporter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: CourseStorageService,
    @Inject(COMMERCE_CONFIG) private readonly config: CommerceCourseConfig,
  ) {}

  async importPackage(
    manifest: PackageManifest,
    files: Map<string, Buffer>,
    options: ImportOptions,
  ): Promise<{ courseId: string }> {
    const { course } = manifest;

    // 冲突检测
    const existing = await this.prisma.commerceCourse.findFirst({
      where: { OR: [{ code: course.code }, { slug: course.slug }] },
      select: { id: true, code: true, slug: true },
    });
    let targetCode = course.code;
    let targetSlug = course.slug;
    if (existing) {
      if (options.onConflict === 'ABORT') {
        throw new ImportError('PACKAGE_CONFLICT', 409, `Course ${existing.code} already exists.`);
      }
      if (options.onConflict === 'CREATE_NEW_COURSE') {
        const suffix = `-imported-${Date.now().toString(36)}`;
        targetCode = await uniqueCode(this.prisma, course.code);
        targetSlug = `${course.slug}${suffix}`;
      }
      // NEW_VERSION 在 P1a 暂以“覆盖更新已有课程的工作副本”未实现，按冲突处理
      if (options.onConflict === 'NEW_VERSION') {
        throw new ImportError('PACKAGE_CONFLICT', 409, 'NEW_VERSION import not implemented yet.');
      }
    }

    // 分类（自动创建/复用，大小写不敏感）
    const categoryId = await this.resolveCategory(course.category);

    const courseId = randomUUID();
    const mediaKeyMap = new Map<string, { assetId: string; kind: string; extension: string; storageKey: string }>();

    // 1) 媒体转存
    try {
      await this.transferMedia(courseId, manifest, files, mediaKeyMap);
    } catch (error) {
      await this.rollbackMedia(courseId, mediaKeyMap);
      throw error;
    }

    // 2) DB 写入
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.writeCourse(tx, courseId, { targetCode, targetSlug, categoryId }, manifest, mediaKeyMap);
      });
    } catch (error) {
      await this.rollbackMedia(courseId, mediaKeyMap);
      throw error;
    }

    return { courseId };
  }

  private async resolveCategory(name: string): Promise<string | null> {
    const trimmed = (name ?? '').trim();
    if (!trimmed) return null;
    const existing = await this.prisma.courseCatalogueEntry.findFirst({
      where: { parentId: null, name: { equals: trimmed, mode: 'insensitive' } },
      select: { id: true },
    });
    if (existing) return existing.id;
    const max = await this.prisma.courseCatalogueEntry.aggregate({
      where: { parentId: null },
      _max: { sortOrder: true },
    });
    try {
      const created = await this.prisma.courseCatalogueEntry.create({
        data: { name: trimmed, description: '', status: 'ACTIVE', sortOrder: (max._max.sortOrder ?? 0) + 1 },
        select: { id: true },
      });
      return created.id;
    } catch {
      const again = await this.prisma.courseCatalogueEntry.findFirst({
        where: { parentId: null, name: { equals: trimmed, mode: 'insensitive' } },
        select: { id: true },
      });
      return again?.id ?? null;
    }
  }

  private async transferMedia(
    courseId: string,
    manifest: PackageManifest,
    files: Map<string, Buffer>,
    map: Map<string, { assetId: string; kind: string; extension: string; storageKey: string }>,
  ): Promise<void> {
    const { course } = manifest;
    const store = async (relPath: string) => {
      const bytes = files.get(relPath);
      if (!bytes) throw new ImportError('PACKAGE_MEDIA_INVALID', 422, `Missing media: ${relPath}`);
      let validated;
      try {
        validated = validateMediaFile({ name: relPath.split('/').pop() ?? relPath, bytes }, this.config);
      } catch {
        throw new ImportError('PACKAGE_MEDIA_INVALID', 422, `Invalid media: ${relPath}`);
      }
      const assetId = randomUUID();
      const storageKey = this.storage.mediaKey(courseId, assetId, validated.extension);
      await this.storage.putMedia(storageKey, bytes);
      map.set(relPath, { assetId, kind: validated.kind, extension: validated.extension, storageKey });
      return { assetId, validated };
    };

    if (course.cover) await store(course.cover);
    for (const lesson of course.lessons ?? []) {
      for (const [, loc] of Object.entries(lesson.localized ?? {})) {
        if (loc.video?.file) await store(loc.video.file);
      }
      for (const ex of lesson.exhibits ?? []) {
        if (ex.file) await store(ex.file);
        if (ex.thumbnail) await store(ex.thumbnail);
      }
    }
  }

  private async rollbackMedia(
    courseId: string,
    map: Map<string, { assetId: string; kind: string; extension: string; storageKey: string }>,
  ): Promise<void> {
    await Promise.all(
      [...map.values()].map((m) => this.storage.removeMedia(m.storageKey)),
    );
    void courseId;
  }

  private async writeCourse(
    tx: Prisma.TransactionClient,
    courseId: string,
    ids: { targetCode: string; targetSlug: string; categoryId: string | null },
    manifest: PackageManifest,
    mediaKeyMap: Map<string, { assetId: string; kind: string; extension: string; storageKey: string }>,
  ): Promise<void> {
    const { course } = manifest;

    const coverAssetId = course.cover ? mediaKeyMap.get(course.cover)?.assetId ?? null : null;

    await tx.commerceCourse.create({
      data: {
        id: courseId,
        code: ids.targetCode,
        slug: ids.targetSlug,
        categoryId: ids.categoryId,
        learningMode: course.learningMode,
        defaultContentLanguage: course.defaultContentLanguage,
        learningLanguages: course.learningLanguages,
        coverAssetId: null,
        lifecycleStatus: 'WORKING',
        liveStatus: 'HIDDEN',
        localizations: {
          create: Object.entries(course.localized).map(([language, loc]) => ({
            language,
            title: loc.title,
            shortDescription: loc.shortDescription ?? null,
            overview: loc.overview ?? null,
            whatYouLearn: (loc.whatYouLearn ?? []) as unknown as Prisma.InputJsonValue,
            provides: (loc.provides ?? []) as unknown as Prisma.InputJsonValue,
          })),
        },
      },
    });

    // 媒体资产行（须在 CommerceCourse 之后，因 courseId 外键指向它）
    for (const [rel, meta] of mediaKeyMap) {
      await tx.courseMediaAsset.create({
        data: {
          id: meta.assetId,
          courseId,
          kind: meta.kind as never,
          originalName: rel.split('/').pop() ?? rel,
          mimeType: '',
          extension: meta.extension,
          size: 0,
          storageKey: meta.storageKey,
        },
      });
    }

    if (coverAssetId) {
      await tx.commerceCourse.update({ where: { id: courseId }, data: { coverAssetId } });
    }

    // 课时
    const lessonIdByCode = new Map<string, string>();
    for (const lesson of [...(course.lessons ?? [])].sort((a, b) => a.order - b.order)) {
      const lessonId = randomUUID();
      lessonIdByCode.set(lesson.code, lessonId);
      await tx.lesson.create({
        data: {
          id: lessonId,
          courseId,
          code: lesson.code,
          sortOrder: lesson.order,
          localizations: {
            create: Object.entries(lesson.localized).map(([language, loc]) => ({
              language,
              title: loc.title,
              description: loc.description ?? null,
              videoAssetId: loc.video?.file ? mediaKeyMap.get(loc.video.file)?.assetId ?? null : null,
              videoDurationSeconds: loc.video?.durationSeconds ?? null,
              textHtml: loc.text?.html ?? null,
              textLearningPoints: (loc.text?.learningPoints ?? []) as unknown as Prisma.InputJsonValue,
            })),
          },
        },
      });

      // 展品
      const exhibitIdByCode = new Map<string, string>();
      for (const ex of lesson.exhibits ?? []) {
        const exhibitId = await this.createExhibit(tx, lessonId, ex, mediaKeyMap);
        exhibitIdByCode.set(ex.code, exhibitId);
      }

      // 学习点 + 触发器
      for (const [language, loc] of Object.entries(lesson.localized)) {
        const videoLps = loc.video?.learningPoints ?? [];
        const textLps = loc.text?.learningPoints ?? [];
        let order = 0;
        for (const lp of videoLps) {
          await tx.learningPoint.create({
            data: { lessonId, language, code: lp.code, title: lp.title, source: 'VIDEO', timeSeconds: lp.timeSeconds, sortOrder: order++ },
          });
        }
        for (const lp of textLps) {
          await tx.learningPoint.create({
            data: { lessonId, language, code: lp.code, title: lp.heading, source: 'TEXT', anchorHeading: lp.heading, sortOrder: order++ },
          });
        }
        for (const trigger of loc.video?.exhibitTriggers ?? []) {
          const exId = exhibitIdByCode.get(trigger.exhibitRef);
          if (exId) {
            await tx.exhibitTrigger.create({
              data: { lessonId, exhibitId: exId, language, timeSeconds: trigger.timeSeconds },
            });
          }
        }
      }

      // 推荐阅读
      for (const [language, readings] of Object.entries(lesson.recommendedReading ?? {})) {
        let order = 0;
        for (const r of readings ?? []) {
          await tx.recommendedReading.create({
            data: { lessonId, language, type: r.type, title: r.title, author: r.author ?? null, whyRecommended: r.why ?? null, sortOrder: order++ },
          });
        }
      }

      // 知识测试
      if (lesson.knowledgeTest?.questions?.length) {
        let order = 0;
        for (const q of lesson.knowledgeTest.questions) {
          await tx.knowledgeQuestion.create({
            data: { lessonId, code: q.code, question: q.question, referenceAnswer: q.referenceAnswer ?? null, sortOrder: order++ },
          });
        }
      }
      // 应用测试
      if (lesson.applicationTest?.enabled) {
        await tx.applicationTest.create({
          data: {
            lessonId,
            scenario: lesson.applicationTest.scenario,
            referenceAnswer: lesson.applicationTest.referenceAnswer ?? null,
            enabled: true,
          },
        });
      }
    }

    // 试用
    if (course.trial?.enabled) {
      for (const row of course.trial.lessons ?? []) {
        const lessonId = lessonIdByCode.get(row.lessonRef);
        if (!lessonId) continue;
        await tx.trialSetting.create({
          data: {
            courseId,
            lessonId,
            videoCutoffSeconds: row.videoCutoffSeconds ?? null,
            textCutoffLearningPointId: row.textCutoffLearningPoint ?? null,
            status: (row.status ?? 'READY') as never,
          },
        });
      }
    }

    // 审计
    await tx.courseAuthoringActivity.create({
      data: {
        courseId,
        action: 'IMPORT',
        detail: { manifestFormat: manifest.formatVersion, packageId: manifest.packageId } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private async createExhibit(
    tx: Prisma.TransactionClient,
    lessonId: string,
    ex: PackageExhibit,
    mediaKeyMap: Map<string, { assetId: string }>,
  ): Promise<string> {
    const exhibitId = randomUUID();
    await tx.exhibit.create({
      data: {
        id: exhibitId,
        lessonId,
        code: ex.code,
        type: ex.type,
        mediaAssetId: ex.file ? mediaKeyMap.get(ex.file)?.assetId ?? null : null,
        thumbnailAssetId: ex.thumbnail ? mediaKeyMap.get(ex.thumbnail)?.assetId ?? null : null,
        sourceText: ex.source ?? null,
        localized: ex.localized as unknown as Prisma.InputJsonValue,
      },
    });
    return exhibitId;
  }
}

async function uniqueCode(prisma: PrismaService, base: string): Promise<string> {
  const match = /^([A-Za-z]+)(\d+)$/.exec(base);
  if (!match) return `${base}-imported`;
  const prefix = match[1];
  const all = await prisma.commerceCourse.findMany({
    where: { code: { startsWith: prefix } },
    select: { code: true },
  });
  let max = 0;
  for (const row of all) {
    const m = /^([A-Za-z]+)(\d+)$/.exec(row.code);
    if (m && m[1] === prefix) max = Math.max(max, Number(m[2]));
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}
