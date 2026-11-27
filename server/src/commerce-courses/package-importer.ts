import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  PackageManifest,
  PackageExhibit,
  PackageValidationIssue,
} from './contracts/manifest';
import { CourseStorageService } from './storage.service';
import { COMMERCE_CONFIG, type CommerceCourseConfig } from './commerce.config';
import {
  formatApplicationCode,
  formatKnowledgeCode,
  lessonNumber,
} from './code-allocator';
import { validateMediaFile } from './media-validate';
import { mp4DurationSeconds } from './media-duration';
import { applyVersionSnapshot, applyVersionSnapshotInTx, type VersionSnapshot } from './version-snapshot';
import { HISTORY_ACTIONS } from './publishing.service';

export interface ImportOptions {
  onConflict: 'ABORT' | 'CREATE_NEW_COURSE' | 'NEW_VERSION';
  reassignCodes: boolean;
  actorEmployeeId: string | null;
  /** 上传的原始文件名（PRD §16.3 History 显示）。 */
  sourceFileName?: string | null;
}

export class ImportError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Called inside the import transaction; serializes recovery against publishing. */
export async function assertRecoverableLivePointer(tx: Prisma.TransactionClient, courseId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ liveVersionId: string | null }>>`
    SELECT "liveVersionId" FROM "CommerceCourse" WHERE id = ${courseId} FOR UPDATE
  `;
  const id = rows[0]?.liveVersionId;
  if (!id || await tx.courseVersion.findFirst({ where: { id, courseId }, select: { id: true } })) {
    throw new ImportError('RECOVERY_NOT_APPLICABLE', 409, 'Recovery requires a missing or foreign live version. A healthy or unpublished course cannot use this operation.');
  }
}

/**
 * 学习点身份 key：`lesson|language|source|code`（与 schema 的 @@unique 顺序一致）。
 * 同一编号在 VIDEO / TEXT 下是两行，查找时必须带上 source，不能只用 lesson|code。
 */
function learningPointKey(
  lessonCode: string,
  language: string,
  source: 'VIDEO' | 'TEXT',
  code: string,
): string {
  return `${lessonCode}|${language}|${source}|${code}`;
}

interface ImportedMediaMeta {
  assetId: string;
  kind: string;
  extension: string;
  storageKey: string;
  mimeType: string;
  size: number;
  originalName: string;
  /** 视频文件从容器 mvhd 探测到的时长（秒）；非视频或探测失败为 null。 */
  durationSeconds?: number | null;
}

/**
 * 视频时长：包内声明优先；省略（或非法）时用真实文件的 mvhd 探测。
 * 探测只支持 mp4/mov（ISO BMFF），其他容器返回 null（不猜测）。
 */
export function probeVideoDurationSeconds(
  extension: string,
  bytes: Buffer,
): number | null {
  if (extension !== 'mp4' && extension !== 'mov') return null;
  const seconds = mp4DurationSeconds(bytes);
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const rounded = Math.round(seconds);
  return rounded > 0 ? rounded : null;
}

/** 包内 durationSeconds 合法（正数）就用它；否则用探测值（没有就是 null）。 */
function effectiveVideoDuration(
  declared: number | undefined,
  probed: number | null | undefined,
): number | null {
  if (
    typeof declared === 'number' &&
    Number.isFinite(declared) &&
    declared > 0
  ) {
    return Math.round(declared);
  }
  return probed ?? null;
}

export interface PackageImportResult {
  courseId: string;
  /** 导入报告里追加的 warning（例如视频时长探测失败）。 */
  warnings: PackageValidationIssue[];
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
  ): Promise<PackageImportResult> {
    const { course } = manifest;

    // 冲突检测：Course ID（课程身份）与 slug（URL 标识）要分开判断。
    // - Course ID 已存在 → 按冲突策略处理（拒绝 / NEW_VERSION 未实现）；
    // - 仅 slug 撞车（Course ID 唯一）→ 自动追加序号生成唯一 slug，
    //   绝不能把「标题 slug 相同」误报成「Course ID 已存在」而拒绝导入。
    const targetCode = course.code;
    let targetSlug = course.slug;
    const existingByCode = await this.prisma.commerceCourse.findFirst({
      where: { code: course.code },
      select: { id: true, code: true },
    });
    if (existingByCode) {
      // PRD §9.2 / §16.3：Course ID 已存在时必须拒绝导入；已有课程请使用 Import package。
      // 正常路径由 package-jobs.service 先做冲突判定；这里只处理「确认后、写库前」的竞态。
      if (options.onConflict === 'ABORT') {
        throw new ImportError(
          'PACKAGE_CONFLICT',
          409,
          `Course ${existingByCode.code} already exists. The Course ID must not already exist in this Admin, or the import is refused.`,
        );
      }
      // CREATE_NEW_COURSE / NEW_VERSION 均未实现：按契约返回 422，而不是 409 PACKAGE_CONFLICT。
      throw new ImportError(
        'PACKAGE_CONFLICT_STRATEGY_UNSUPPORTED',
        422,
        `onConflict=${options.onConflict} is not implemented yet.`,
      );
    }
    const slugOwner = await this.prisma.commerceCourse.findFirst({
      where: { slug: targetSlug },
      select: { id: true },
    });
    if (slugOwner) {
      targetSlug = await this.uniqueSlug(targetSlug);
    }

    // 分类（自动创建/复用，大小写不敏感）
    const categoryId = await this.resolveCategory(course.category);

    const courseId = randomUUID();
    const mediaKeyMap = new Map<string, ImportedMediaMeta>();

    // 1) 媒体转存（视频顺手按 mvhd 探测时长；探测失败只产生 warning）
    let warnings: PackageValidationIssue[];
    try {
      warnings = await this.transferMedia(
        courseId,
        manifest,
        files,
        mediaKeyMap,
      );
    } catch (error) {
      await this.rollbackMedia(courseId, mediaKeyMap);
      throw error;
    }

    // 2) DB 写入
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.writeCourse(
          tx,
          courseId,
          { targetCode, targetSlug, categoryId },
          manifest,
          mediaKeyMap,
        );
      });
    } catch (error) {
      await this.rollbackMedia(courseId, mediaKeyMap);
      throw error;
    }

    return { courseId, warnings };
  }

  /**
   * 导入到已有课程（PRD §16，CM16）：只替换草稿，线上版本不变。
   * Course ID 必须一致；试看与价格按包更新；价格稍后由调用方在本环境 Stripe 重新创建。
   */
  async importIntoExistingCourse(
    courseId: string,
    manifest: PackageManifest,
    files: Map<string, Buffer>,
    actorEmployeeId: string | null,
    sourceFileName?: string | null,
    recoverInvalidLive = false,
  ): Promise<PackageImportResult> {
    const existing = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: { id: true, code: true },
    });
    if (!existing)
      throw new ImportError('COURSE_NOT_FOUND', 404, 'Course not found.');
    if (existing.code !== manifest.course.code) {
      throw new ImportError(
        'PACKAGE_COURSE_ID_MISMATCH',
        422,
        'The Course ID in the package must match this course, or the import is refused.',
      );
    }

    const categoryId = await this.resolveCategory(manifest.course.category);
    const mediaKeyMap = new Map<string, ImportedMediaMeta>();
    let warnings: PackageValidationIssue[];
    try {
      warnings = await this.transferMedia(
        courseId,
        manifest,
        files,
        mediaKeyMap,
      );
      // 媒体资产必须先落库，applyVersionSnapshot 才能写入视频/展品外键。
      await this.createMediaRows(courseId, mediaKeyMap);
    } catch (error) {
      await this.rollbackMedia(courseId, mediaKeyMap);
      throw error;
    }

    try {
      const snapshot = this.snapshotFromPackage(
        manifest,
        categoryId,
        mediaKeyMap,
      );
      if (!recoverInvalidLive) await applyVersionSnapshot(this.prisma, courseId, snapshot);
      await this.prisma.$transaction(async (tx) => {
        if (recoverInvalidLive) {
          await assertRecoverableLivePointer(tx, courseId);
          await applyVersionSnapshotInTx(tx, courseId, snapshot);
        }
        await tx.commerceCourse.update({
          where: { id: courseId },
          data: {
            hasDraft: true,
            ...(recoverInvalidLive ? { liveVersionId: null, liveStatus: 'OFFLINE' as const } : {}),
            lifecycleStatus: 'WORKING',
            // 导入整包覆盖草稿：已打开的编辑页再保存会收到 409，而不是覆盖导入结果
            revision: { increment: 1 },
            revisionBy: null,
            trialEnabled: Boolean(manifest.course.trial?.enabled),
            draftSourceType: 'IMPORT',
            draftSourceEnvironment: manifest.source.environment ?? null,
            draftSourceVersionLabel: manifest.source.sourceVersion ?? null,
          },
        });

        // applyVersionSnapshot 可能复用/重建 Lesson 与 LP 行，必须重新从数据库取实际 ID。
        const actualLessons = await tx.lesson.findMany({
          where: { courseId, archivedAt: null },
          select: { id: true, code: true },
        });
        const lessonIdByCode = new Map(
          actualLessons.map((lesson) => [lesson.code, lesson.id]),
        );
        const lessonCodeById = new Map(
          actualLessons.map((lesson) => [lesson.id, lesson.code]),
        );
        // 学习点身份 = (lesson, language, source, code)：同一编号在 VIDEO / TEXT 下各有一行，
        // 试看的文本截止点只能落到 TEXT 行（包规范 §4.2、§14），不能落到同编号的 VIDEO 行。
        const learningPoints = await tx.learningPoint.findMany({
          where: { lesson: { courseId } },
          select: {
            id: true,
            lessonId: true,
            language: true,
            code: true,
            source: true,
          },
        });
        const lpIdByKey = new Map<string, string>();
        const textPoints: Array<{
          lessonCode: string;
          code: string;
          id: string;
        }> = [];
        const textPointIds = new Set<string>();
        for (const lp of learningPoints) {
          const lessonCode = lessonCodeById.get(lp.lessonId);
          if (!lessonCode) continue;
          lpIdByKey.set(
            learningPointKey(lessonCode, lp.language, lp.source, lp.code),
            lp.id,
          );
          if (lp.source === 'TEXT') {
            textPoints.push({ lessonCode, code: lp.code, id: lp.id });
            textPointIds.add(lp.id);
          }
        }
        // 包里的 trial 行没有语言字段：优先默认内容语言，否则接受该课时唯一一个
        // 同编号的 TEXT 行；两种都不成立时返回 null，绝不回退到 VIDEO 行。
        const resolveCutoff = (lessonCode: string, ref?: string | null) => {
          if (!ref) return null;
          const preferred = lpIdByKey.get(
            learningPointKey(
              lessonCode,
              manifest.course.defaultContentLanguage,
              'TEXT',
              ref,
            ),
          );
          if (preferred) return preferred;
          const matches = textPoints.filter(
            (point) => point.lessonCode === lessonCode && point.code === ref,
          );
          if (matches.length === 1) return matches[0].id;
          if (matches.length > 1) return null;
          return textPointIds.has(ref) ? ref : null;
        };

        await tx.trialSetting.deleteMany({ where: { courseId } });
        if (manifest.course.trial?.enabled) {
          for (const row of manifest.course.trial.lessons ?? []) {
            const lessonId = lessonIdByCode.get(row.lessonRef);
            if (!lessonId) continue;
            // Design §17.5：包引用的文本截止点在本课程里找不到时降级 RE_CONFIRM，
            // 不能假装 READY（管理员需要在试看页重新确认截止点）。
            const textCutoff = resolveCutoff(
              row.lessonRef,
              row.textCutoffLearningPoint,
            );
            const status =
              row.textCutoffLearningPoint && !textCutoff
                ? 'RE_CONFIRM'
                : (row.status ?? 'READY');
            await tx.trialSetting.create({
              data: {
                courseId,
                lessonId,
                videoCutoffSeconds: row.videoCutoffSeconds ?? null,
                textCutoffLearningPointId: textCutoff,
                status: status as never,
              },
            });
          }
        }

        await tx.coursePlan.updateMany({
          where: { courseId, active: true },
          data: { active: false },
        });
        for (const [index, plan] of (manifest.course.pricing ?? []).entries()) {
          await tx.coursePlan.create({
            data: {
              id: randomUUID(),
              courseId,
              name: plan.name,
              scope: 'COURSE',
              scopeId: courseId,
              termMonths: plan.termMonths,
              device: 'WEB',
              amountMinor: plan.amountMinor,
              currency: (plan.currency || 'usd').toLowerCase(),
              stripeLookupKey: plan.lookupKey,
              sortOrder: index,
              active: true,
            },
          });
        }

        await tx.courseAuthoringActivity.create({
          data: {
            courseId,
            actorEmployeeId,
            action: HISTORY_ACTIONS.IMPORT_PACKAGE,
            detail: {
              packageId: manifest.packageId,
              fileName: sourceFileName ?? null,
              sourceEnvironment: manifest.source.environment ?? null,
              sourceVersionLabel: manifest.source.sourceVersion ?? null,
            },
          },
        });
      }, { timeout: 60_000 });
      return { courseId, warnings };
    } catch (error) {
      await this.rollbackMedia(courseId, mediaKeyMap);
      throw error;
    }
  }

  private snapshotFromPackage(
    manifest: PackageManifest,
    categoryId: string | null,
    mediaKeyMap: Map<string, ImportedMediaMeta>,
  ): VersionSnapshot {
    const { course } = manifest;
    const capturedAt = new Date().toISOString();
    return {
      formatVersion: 2,
      capturedAt,
      course: {
        code: course.code,
        slug: course.slug,
        categoryId,
        coverAssetId: course.cover
          ? (mediaKeyMap.get(course.cover)?.assetId ?? null)
          : null,
        learningMode: course.learningMode,
        defaultContentLanguage: course.defaultContentLanguage,
        learningLanguages: course.learningLanguages,
        localizations: Object.entries(course.localized).map(
          ([language, loc]) => ({
            language,
            title: loc.title,
            shortDescription: loc.shortDescription ?? null,
            overview: loc.overview ?? null,
            whatYouLearn: loc.whatYouLearn ?? [],
            provides: loc.provides ?? [],
          }),
        ),
        lessons: [...(course.lessons ?? [])]
          .sort((a, b) => a.order - b.order)
          .map((lesson) => {
            const exhibits = (lesson.exhibits ?? []).map((exhibit) => ({
              code: exhibit.code,
              type: exhibit.type,
              mediaAssetId: exhibit.file
                ? (mediaKeyMap.get(exhibit.file)?.assetId ?? null)
                : null,
              thumbnailAssetId: exhibit.thumbnail
                ? (mediaKeyMap.get(exhibit.thumbnail)?.assetId ?? null)
                : null,
              sourceText: exhibit.source ?? null,
              localized: exhibit.localized,
            }));
            return {
              id: randomUUID(),
              code: lesson.code,
              sortOrder: lesson.order,
              localizations: Object.entries(lesson.localized).map(
                ([language, loc]) => ({
                  language,
                  title: loc.title,
                  description: loc.description ?? null,
                  videoAssetId: loc.video?.file
                    ? (mediaKeyMap.get(loc.video.file)?.assetId ?? null)
                    : null,
                  videoDurationSeconds: effectiveVideoDuration(
                    loc.video?.durationSeconds,
                    loc.video?.file
                      ? mediaKeyMap.get(loc.video.file)?.durationSeconds
                      : undefined,
                  ),
                  textHtml: loc.text?.html ?? null,
                  textLearningPoints: loc.text?.learningPoints ?? [],
                }),
              ),
              exhibits,
              learningPoints: Object.entries(lesson.localized).flatMap(
                ([language, loc]) => [
                  ...(loc.video?.learningPoints ?? []).map((lp, index) => ({
                    language,
                    code: lp.code,
                    title: lp.title,
                    source: 'VIDEO',
                    timeSeconds: lp.timeSeconds,
                    anchorHeading: null,
                    sortOrder: index,
                  })),
                  ...(loc.text?.learningPoints ?? []).map((lp, index) => ({
                    language,
                    code: lp.code,
                    title: lp.heading,
                    source: 'TEXT',
                    timeSeconds: null,
                    anchorHeading: lp.heading,
                    sortOrder: (loc.video?.learningPoints?.length ?? 0) + index,
                  })),
                ],
              ),
              triggers: Object.entries(lesson.localized).flatMap(
                ([language, loc]) =>
                  (loc.video?.exhibitTriggers ?? []).map((trigger) => ({
                    exhibitCode: trigger.exhibitRef,
                    language,
                    timeSeconds: trigger.timeSeconds,
                  })),
              ),
              readings: Object.entries(lesson.recommendedReading ?? {}).flatMap(
                ([language, rows]) =>
                  (rows ?? []).map((row, index) => ({
                    language,
                    type: row.type,
                    title: row.title,
                    author: row.author ?? null,
                    whyRecommended: row.why ?? null,
                    sortOrder: index,
                  })),
              ),
              questions: (lesson.knowledgeTest?.questions ?? []).map(
                (question, index) => ({
                  code: question.code,
                  question: question.question,
                  referenceAnswer: question.referenceAnswer ?? null,
                  sortOrder: index,
                  enabled: true,
                }),
              ),
              applicationTest: lesson.applicationTest?.enabled
                ? {
                    scenario: lesson.applicationTest.scenario,
                    referenceAnswer:
                      lesson.applicationTest.referenceAnswer ?? null,
                    enabled: true,
                  }
                : null,
            };
          }),
      },
    };
  }

  /** 生成未被占用的 slug：base、base-2、base-3…（slug 仅要求唯一，非课程身份）。 */
  private async uniqueSlug(base: string): Promise<string> {
    const root = (base || 'course').trim().toLowerCase() || 'course';
    for (let i = 2; i < 1000; i++) {
      const candidate = `${root}-${i}`;
      const taken = await this.prisma.commerceCourse.findFirst({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!taken) return candidate;
    }
    return `${root}-${Date.now().toString(36)}`;
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
        data: {
          name: trimmed,
          description: '',
          status: 'ACTIVE',
          sortOrder: (max._max.sortOrder ?? 0) + 1,
        },
        select: { id: true },
      });
      return created.id;
    } catch {
      const again = await this.prisma.courseCatalogueEntry.findFirst({
        where: {
          parentId: null,
          name: { equals: trimmed, mode: 'insensitive' },
        },
        select: { id: true },
      });
      return again?.id ?? null;
    }
  }

  private async transferMedia(
    courseId: string,
    manifest: PackageManifest,
    files: Map<string, Buffer>,
    map: Map<string, ImportedMediaMeta>,
  ): Promise<PackageValidationIssue[]> {
    const { course } = manifest;
    const store = async (relPath: string) => {
      const bytes = files.get(relPath);
      if (!bytes)
        throw new ImportError(
          'PACKAGE_MEDIA_INVALID',
          422,
          `Missing media: ${relPath}`,
        );
      let validated;
      try {
        validated = validateMediaFile(
          { name: relPath.split('/').pop() ?? relPath, bytes },
          this.config,
        );
      } catch {
        throw new ImportError(
          'PACKAGE_MEDIA_INVALID',
          422,
          `Invalid media: ${relPath}`,
        );
      }
      // 视频时长只从真实文件的容器头读取（mp4/mov 的 mvhd），不猜测其他格式。
      const durationSeconds =
        validated.kind === 'VIDEO'
          ? probeVideoDurationSeconds(validated.extension, bytes)
          : null;
      const assetId = randomUUID();
      const storageKey = this.storage.mediaKey(
        courseId,
        assetId,
        validated.extension,
      );
      await this.storage.putMedia(storageKey, bytes);
      map.set(relPath, {
        assetId,
        kind: validated.kind,
        extension: validated.extension,
        storageKey,
        mimeType: validated.mimeType,
        size: validated.size,
        originalName: validated.originalName,
        durationSeconds,
      });
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

    // 包内省略可选 durationSeconds 且文件里读不到时长：导入继续（时长落 null），
    // 但在导入报告里明确 warning；该课时在补齐时长前不能发布（completeness）。
    const warnings: PackageValidationIssue[] = [];
    const warned = new Set<string>();
    for (const lesson of course.lessons ?? []) {
      for (const [language, loc] of Object.entries(lesson.localized ?? {})) {
        const file = loc.video?.file;
        if (!file) continue;
        const declared = loc.video?.durationSeconds;
        const declaredValid =
          typeof declared === 'number' &&
          Number.isFinite(declared) &&
          declared > 0;
        if (declaredValid) continue;
        if (map.get(file)?.durationSeconds) continue;
        const key = `${lesson.code}|${language}|${file}`;
        if (warned.has(key)) continue;
        warned.add(key);
        warnings.push({
          level: 'warning',
          code: 'VIDEO_DURATION_UNREADABLE',
          path: `lessons.${lesson.code}.localized.${language}.video`,
          message: `Video duration could not be read from ${file} (${language}); the lesson cannot be published until a duration is set.`,
        });
      }
    }
    return warnings;
  }

  /** 导入已有课程时补齐媒体资产行；新建课程在 writeCourse 的事务内创建。 */
  private async createMediaRows(
    courseId: string,
    map: Map<string, ImportedMediaMeta>,
  ): Promise<void> {
    if (map.size === 0) return;
    await this.prisma.courseMediaAsset.createMany({
      data: [...map.values()].map((meta) => ({
        id: meta.assetId,
        courseId,
        kind: meta.kind as never,
        originalName: meta.originalName,
        mimeType: meta.mimeType,
        extension: meta.extension,
        size: meta.size,
        storageKey: meta.storageKey,
      })),
    });
  }

  private async rollbackMedia(
    courseId: string,
    map: Map<string, ImportedMediaMeta>,
  ): Promise<void> {
    const ids = [...map.values()].map((m) => m.assetId);
    if (ids.length) {
      await this.prisma.courseMediaAsset
        .deleteMany({ where: { id: { in: ids }, courseId } })
        .catch(() => undefined);
    }
    await Promise.all(
      [...map.values()].map((m) => this.storage.removeMedia(m.storageKey)),
    );
  }

  private async writeCourse(
    tx: Prisma.TransactionClient,
    courseId: string,
    ids: { targetCode: string; targetSlug: string; categoryId: string | null },
    manifest: PackageManifest,
    mediaKeyMap: Map<string, ImportedMediaMeta>,
  ): Promise<void> {
    const { course } = manifest;

    const coverAssetId = course.cover
      ? (mediaKeyMap.get(course.cover)?.assetId ?? null)
      : null;

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
        hasDraft: true,
        trialEnabled: Boolean(course.trial?.enabled),
        localizations: {
          create: Object.entries(course.localized).map(([language, loc]) => ({
            language,
            title: loc.title,
            shortDescription: loc.shortDescription ?? null,
            overview: loc.overview ?? null,
            whatYouLearn: loc.whatYouLearn ?? [],
            provides: (loc.provides ?? []) as unknown as Prisma.InputJsonValue,
          })),
        },
      },
    });

    // 媒体资产行（须在 CommerceCourse 之后，因 courseId 外键指向它）
    for (const meta of mediaKeyMap.values()) {
      await tx.courseMediaAsset.create({
        data: {
          id: meta.assetId,
          courseId,
          kind: meta.kind as never,
          originalName: meta.originalName,
          mimeType: meta.mimeType,
          extension: meta.extension,
          size: meta.size,
          storageKey: meta.storageKey,
        },
      });
    }

    if (coverAssetId) {
      await tx.commerceCourse.update({
        where: { id: courseId },
        data: { coverAssetId },
      });
    }

    // 课时
    const lessonIdByCode = new Map<string, string>();
    // 学习点身份 = (lesson, language, source, code)，见 schema 的 @@unique；
    // 试看的文本截止点只能绑 TEXT 行，不能绑同编号的 VIDEO 行。
    const lpIdByKey = new Map<string, string>();
    const textPoints: Array<{ lessonCode: string; code: string; id: string }> =
      [];
    const takenKnowledgeCodes = new Set<string>();
    for (const lesson of [...(course.lessons ?? [])].sort(
      (a, b) => a.order - b.order,
    )) {
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
              videoAssetId: loc.video?.file
                ? (mediaKeyMap.get(loc.video.file)?.assetId ?? null)
                : null,
              videoDurationSeconds: effectiveVideoDuration(
                loc.video?.durationSeconds,
                loc.video?.file
                  ? mediaKeyMap.get(loc.video.file)?.durationSeconds
                  : undefined,
              ),
              textHtml: loc.text?.html ?? null,
              textLearningPoints: (loc.text?.learningPoints ??
                []) as unknown as Prisma.InputJsonValue,
            })),
          },
        },
      });

      // 展品
      const exhibitIdByCode = new Map<string, string>();
      for (const ex of lesson.exhibits ?? []) {
        const exhibitId = await this.createExhibit(
          tx,
          courseId,
          lessonId,
          ex,
          mediaKeyMap,
          exhibitIdByCode.size + 1,
        );
        exhibitIdByCode.set(ex.code, exhibitId);
      }

      // 学习点 + 触发器
      for (const [language, loc] of Object.entries(lesson.localized)) {
        const videoLps = loc.video?.learningPoints ?? [];
        const textLps = loc.text?.learningPoints ?? [];
        let order = 0;
        for (const lp of videoLps) {
          const createdLp = await tx.learningPoint.create({
            data: {
              lessonId,
              language,
              code: lp.code,
              title: lp.title,
              source: 'VIDEO',
              timeSeconds: lp.timeSeconds,
              sortOrder: order++,
            },
          });
          lpIdByKey.set(
            learningPointKey(lesson.code, language, 'VIDEO', lp.code),
            createdLp.id,
          );
        }
        for (const lp of textLps) {
          const createdLp = await tx.learningPoint.create({
            data: {
              lessonId,
              language,
              code: lp.code,
              title: lp.heading,
              source: 'TEXT',
              anchorHeading: lp.heading,
              sortOrder: order++,
            },
          });
          lpIdByKey.set(
            learningPointKey(lesson.code, language, 'TEXT', lp.code),
            createdLp.id,
          );
          textPoints.push({
            lessonCode: lesson.code,
            code: lp.code,
            id: createdLp.id,
          });
        }
        for (const trigger of loc.video?.exhibitTriggers ?? []) {
          const exId = exhibitIdByCode.get(trigger.exhibitRef);
          if (exId) {
            await tx.exhibitTrigger.create({
              data: {
                lessonId,
                exhibitId: exId,
                language,
                timeSeconds: trigger.timeSeconds,
              },
            });
          }
        }
      }

      // 推荐阅读
      for (const [language, readings] of Object.entries(
        lesson.recommendedReading ?? {},
      )) {
        let order = 0;
        for (const r of readings ?? []) {
          await tx.recommendedReading.create({
            data: {
              lessonId,
              language,
              type: r.type,
              title: r.title,
              author: r.author ?? null,
              whyRecommended: r.why ?? null,
              sortOrder: order++,
            },
          });
        }
      }

      // 知识测试（包格式在 B14 之前不带语言：归默认内容语言；编号在课程内唯一，重复或为空的重新给）
      if (lesson.knowledgeTest?.questions?.length) {
        let order = 0;
        let sequence = 0;
        for (const q of lesson.knowledgeTest.questions) {
          let code = q.code;
          while (!code || takenKnowledgeCodes.has(code)) {
            sequence += 1;
            code = formatKnowledgeCode(
              lessonNumber(lesson.code, lesson.order ?? 0),
              sequence,
            );
          }
          takenKnowledgeCodes.add(code);
          await tx.knowledgeQuestion.create({
            data: {
              lessonId,
              courseId,
              language: course.defaultContentLanguage,
              code,
              question: q.question,
              referenceAnswer: q.referenceAnswer ?? null,
              sortOrder: order++,
            },
          });
        }
      }
      // 应用测试
      if (lesson.applicationTest?.enabled) {
        await tx.applicationTest.create({
          data: {
            lessonId,
            courseId,
            language: course.defaultContentLanguage,
            code: formatApplicationCode(
              lessonNumber(lesson.code, lesson.order ?? 0),
              1,
            ),
            scenario: lesson.applicationTest.scenario,
            referenceAnswer: lesson.applicationTest.referenceAnswer ?? null,
            enabled: true,
          },
        });
      }
    }

    // 试用：文本截止点按 (lesson, language, source=TEXT, code) 解析（包规范 §4.2、§14）。
    // 包里的 trial 行没有语言字段：优先默认内容语言，否则接受该课时唯一一个同编号的
    // TEXT 行；绝不落到同编号的 VIDEO 行。
    const resolveTextCutoff = (
      lessonCode: string,
      code?: string | null,
    ): string | null => {
      if (!code) return null;
      const preferred = lpIdByKey.get(
        learningPointKey(
          lessonCode,
          course.defaultContentLanguage,
          'TEXT',
          code,
        ),
      );
      if (preferred) return preferred;
      const matches = textPoints.filter(
        (point) => point.lessonCode === lessonCode && point.code === code,
      );
      return matches.length === 1 ? matches[0].id : null;
    };
    if (course.trial?.enabled) {
      for (const row of course.trial.lessons ?? []) {
        const lessonId = lessonIdByCode.get(row.lessonRef);
        if (!lessonId) continue;
        // Design §17.5：引用缺失 → RE_CONFIRM（见 importIntoExistingCourse 同款处理）。
        const textCutoff = resolveTextCutoff(
          row.lessonRef,
          row.textCutoffLearningPoint,
        );
        const status =
          row.textCutoffLearningPoint && !textCutoff
            ? 'RE_CONFIRM'
            : (row.status ?? 'READY');
        await tx.trialSetting.create({
          data: {
            courseId,
            lessonId,
            videoCutoffSeconds: row.videoCutoffSeconds ?? null,
            textCutoffLearningPointId: textCutoff,
            status: status as never,
          },
        });
      }
    }

    // 价格随包带入；Stripe 由导入完成后在同一环境重新创建
    for (const [index, plan] of (course.pricing ?? []).entries()) {
      await tx.coursePlan.create({
        data: {
          id: randomUUID(),
          courseId,
          name: plan.name,
          scope: 'COURSE',
          scopeId: courseId,
          termMonths: plan.termMonths,
          device: 'WEB',
          amountMinor: plan.amountMinor,
          currency: (plan.currency || 'usd').toLowerCase(),
          stripeLookupKey: plan.lookupKey,
          sortOrder: index,
          active: true,
        },
      });
    }

    // 审计
    await tx.courseAuthoringActivity.create({
      data: {
        courseId,
        action: 'IMPORT',
        detail: {
          manifestFormat: manifest.formatVersion,
          packageId: manifest.packageId,
        },
      },
    });
  }

  private async createExhibit(
    tx: Prisma.TransactionClient,
    courseId: string,
    lessonId: string,
    ex: PackageExhibit,
    mediaKeyMap: Map<string, ImportedMediaMeta>,
    sortOrder: number,
  ): Promise<string> {
    const exhibitId = randomUUID();
    await tx.exhibit.create({
      data: {
        id: exhibitId,
        lessonId,
        courseId,
        sortOrder,
        code: ex.code,
        type: ex.type,
        mediaAssetId: ex.file
          ? (mediaKeyMap.get(ex.file)?.assetId ?? null)
          : null,
        thumbnailAssetId: ex.thumbnail
          ? (mediaKeyMap.get(ex.thumbnail)?.assetId ?? null)
          : null,
        sourceText: ex.source ?? null,
        localized: ex.localized,
      },
    });
    return exhibitId;
  }
}
