import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { PackageManifest, PackageExhibit } from './contracts/manifest';
import { CourseStorageService } from './storage.service';
import { COMMERCE_CONFIG, type CommerceCourseConfig } from './commerce.config';
import { validateMediaFile } from './media-validate';
import { applyVersionSnapshot, type VersionSnapshot } from './version-snapshot';
import { HISTORY_ACTIONS } from './publishing.service';

export interface ImportOptions {
  onConflict: 'ABORT' | 'CREATE_NEW_COURSE' | 'NEW_VERSION';
  reassignCodes: boolean;
  actorEmployeeId: string | null;
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

interface ImportedMediaMeta {
  assetId: string;
  kind: string;
  extension: string;
  storageKey: string;
  mimeType: string;
  size: number;
  originalName: string;
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
      // PRD §9.2 / §16.3：Course ID 已存在时必须拒绝导入；已有课程请使用 Import package。
      if (
        options.onConflict === 'ABORT' ||
        options.onConflict === 'CREATE_NEW_COURSE'
      ) {
        throw new ImportError(
          'PACKAGE_CONFLICT',
          409,
          `Course ${existing.code} already exists. The Course ID must not already exist in this Admin, or the import is refused.`,
        );
      }
      // NEW_VERSION 暂未实现，按冲突处理
      if (options.onConflict === 'NEW_VERSION') {
        throw new ImportError(
          'PACKAGE_CONFLICT',
          409,
          'NEW_VERSION import not implemented yet.',
        );
      }
    }

    // 分类（自动创建/复用，大小写不敏感）
    const categoryId = await this.resolveCategory(course.category);

    const courseId = randomUUID();
    const mediaKeyMap = new Map<string, ImportedMediaMeta>();

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

    return { courseId };
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
  ): Promise<{ courseId: string }> {
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
    try {
      await this.transferMedia(courseId, manifest, files, mediaKeyMap);
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
      await applyVersionSnapshot(this.prisma, courseId, snapshot);
      await this.prisma.$transaction(async (tx) => {
        await tx.commerceCourse.update({
          where: { id: courseId },
          data: {
            hasDraft: true,
            lifecycleStatus: 'WORKING',
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
        const learningPoints = await tx.learningPoint.findMany({
          where: { lesson: { courseId } },
          select: { id: true, lessonId: true, code: true },
        });
        const lpIdByKey = new Map(
          learningPoints.map((lp) => [
            `${lessonCodeById.get(lp.lessonId) ?? ''}|${lp.code}`,
            lp.id,
          ]),
        );
        const lpIds = new Set(learningPoints.map((lp) => lp.id));
        const resolveCutoff = (lessonCode: string, ref?: string | null) => {
          if (!ref) return null;
          return lpIdByKey.get(`${lessonCode}|${ref}`) ?? (lpIds.has(ref) ? ref : null);
        };

        await tx.trialSetting.deleteMany({ where: { courseId } });
        if (manifest.course.trial?.enabled) {
          for (const row of manifest.course.trial.lessons ?? []) {
            const lessonId = lessonIdByCode.get(row.lessonRef);
            if (!lessonId) continue;
            await tx.trialSetting.create({
              data: {
                courseId,
                lessonId,
                videoCutoffSeconds: row.videoCutoffSeconds ?? null,
                textCutoffLearningPointId: resolveCutoff(
                  row.lessonRef,
                  row.textCutoffLearningPoint,
                ),
                status: (row.status ?? 'READY') as never,
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
              sourceEnvironment: manifest.source.environment ?? null,
              sourceVersionLabel: manifest.source.sourceVersion ?? null,
            },
          },
        });
      });
      return { courseId };
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
                  videoDurationSeconds: loc.video?.durationSeconds ?? null,
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
  ): Promise<void> {
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
    const lpIdByKey = new Map<string, string>();
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
              videoDurationSeconds: loc.video?.durationSeconds ?? null,
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
          lessonId,
          ex,
          mediaKeyMap,
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
          lpIdByKey.set(`${lesson.code}|${lp.code}`, createdLp.id);
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
          lpIdByKey.set(`${lesson.code}|${lp.code}`, createdLp.id);
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

      // 知识测试
      if (lesson.knowledgeTest?.questions?.length) {
        let order = 0;
        for (const q of lesson.knowledgeTest.questions) {
          await tx.knowledgeQuestion.create({
            data: {
              lessonId,
              code: q.code,
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
            textCutoffLearningPointId: row.textCutoffLearningPoint
              ? (lpIdByKey.get(
                  `${row.lessonRef}|${row.textCutoffLearningPoint}`,
                ) ?? null)
              : null,
            status: (row.status ?? 'READY') as never,
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
    lessonId: string,
    ex: PackageExhibit,
    mediaKeyMap: Map<string, ImportedMediaMeta>,
  ): Promise<string> {
    const exhibitId = randomUUID();
    await tx.exhibit.create({
      data: {
        id: exhibitId,
        lessonId,
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
