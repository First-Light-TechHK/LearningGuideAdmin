import JSZip from 'jszip';
import type { PrismaService } from '../prisma/prisma.service';
import { CourseStorageService } from './storage.service';
import {
  buildCourseSnapshot,
  packageMediaPath,
  type CourseAggregate,
} from './snapshot';
import {
  PACKAGE_FORMAT,
  PACKAGE_FORMAT_VERSION,
  type PackageCourse,
  type PackageExhibit,
  type PackageLesson,
  type PackageLessonLocalization,
  type PackageManifest,
  type PackageReading,
} from './contracts/manifest';
import type { VersionSnapshot } from './version-snapshot';

/**
 * 从课程聚合生成 .lgcourse.zip（导出）。见设计文档 §4/§5.6。
 * 返回 zip 字节；调用方负责存储与下载令牌。
 */
export async function buildCoursePackage(
  prisma: PrismaService,
  storage: CourseStorageService,
  courseId: string,
  sourceVersion: string,
): Promise<Buffer> {
  const agg = (await prisma.commerceCourse.findUnique({
    where: { id: courseId },
    include: {
      category: true,
      cover: true,
      localizations: true,
      trialRows: true,
      plans: { where: { active: true }, orderBy: { sortOrder: 'asc' } },
      lessons: {
        orderBy: { sortOrder: 'asc' },
        include: {
          localizations: { include: { video: true } },
          exhibits: { include: { media: true, thumbnail: true } },
          readings: { orderBy: { sortOrder: 'asc' } },
          questions: { orderBy: { sortOrder: 'asc' } },
          applicationTest: true,
          learningPoints: { orderBy: { sortOrder: 'asc' } },
          triggers: true,
        },
      },
    },
  })) as unknown as CourseAggregate | null;
  if (!agg) throw new Error('Course not found');

  const { course, media } = buildCourseSnapshot(agg);
  const zip = new JSZip();
  const checksums: string[] = [];

  for (const ref of media) {
    if (!ref.storageKey) continue;
    try {
      const bytes = await storage.getMedia(ref.storageKey);
      zip.file(ref.path, bytes);
      checksums.push(`${CourseStorageService.sha256(bytes)}  ${ref.path}`);
    } catch {
      // 媒体缺失时导出失败（不允许坏包），这里抛错由上层处理
      throw new Error(`Export failed: media missing for ${ref.path}`);
    }
  }

  const manifest: PackageManifest = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    packageId: `pkg_${courseId}_${Date.now().toString(36)}`,
    exportedAt: new Date().toISOString(),
    source: { courseCode: course.code, sourceVersion },
    incomplete: false,
    course,
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  if (checksums.length) zip.file('checksums.sha256', checksums.join('\n'));

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * P1b：从线上版本快照导出课程包（PRD §16）。
 * 只导出 Live 行；内容来自不可变快照，试看/价格读取本环境当前值。
 */
export async function buildCoursePackageFromSnapshot(
  prisma: PrismaService,
  storage: CourseStorageService,
  courseId: string,
  options: { versionId: string; environment: string },
): Promise<{ bytes: Buffer; fileName: string; versionLabel: string }> {
  const [course, version] = await Promise.all([
    prisma.commerceCourse.findUnique({
      where: { id: courseId },
      include: {
        category: true,
        plans: { where: { active: true }, orderBy: { sortOrder: 'asc' } },
        trialRows: true,
      },
    }),
    prisma.courseVersion.findUnique({ where: { id: options.versionId } }),
  ]);
  if (!course) throw new Error('Course not found');
  if (!version || version.courseId !== courseId)
    throw new Error('Live version not found');

  const snapshot = version.snapshotData as unknown as VersionSnapshot;
  const assetIds = new Set<string>();
  if (snapshot.course.coverAssetId) assetIds.add(snapshot.course.coverAssetId);
  for (const lesson of snapshot.course.lessons) {
    for (const loc of lesson.localizations)
      if (loc.videoAssetId) assetIds.add(loc.videoAssetId);
    for (const exhibit of lesson.exhibits) {
      if (exhibit.mediaAssetId) assetIds.add(exhibit.mediaAssetId);
      if (exhibit.thumbnailAssetId) assetIds.add(exhibit.thumbnailAssetId);
    }
  }
  const assets = assetIds.size
    ? await prisma.courseMediaAsset.findMany({
        where: { id: { in: [...assetIds] }, courseId },
      })
    : [];
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));

  const zip = new JSZip();
  const checksums: string[] = [];
  const addMedia = async (
    path: string,
    assetId: string | null | undefined,
  ): Promise<string | undefined> => {
    if (!assetId) return undefined;
    const asset = assetById.get(assetId);
    if (!asset) throw new Error(`Export failed: media missing for ${path}`);
    const bytes = await storage.getMedia(asset.storageKey);
    zip.file(path, bytes);
    checksums.push(`${CourseStorageService.sha256(bytes)}  ${path}`);
    return path;
  };

  const cover = snapshot.course.coverAssetId
    ? await addMedia(
        packageMediaPath.cover(
          assetById.get(snapshot.course.coverAssetId)?.extension ?? 'bin',
        ),
        snapshot.course.coverAssetId,
      )
    : undefined;

  const lessons: PackageLesson[] = await Promise.all(
    [...snapshot.course.lessons]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(async (lesson) => {
        const localized: Record<string, PackageLessonLocalization> = {};
        for (const loc of lesson.localizations) {
          const lps = lesson.learningPoints
            .filter((lp) => lp.language === loc.language)
            .sort((a, b) => a.sortOrder - b.sortOrder);
          const video = loc.videoAssetId
            ? {
                file: (await addMedia(
                  packageMediaPath.video(
                    lesson.code,
                    loc.language,
                    assetById.get(loc.videoAssetId)?.extension ?? 'bin',
                  ),
                  loc.videoAssetId,
                )) as string,
                durationSeconds: loc.videoDurationSeconds ?? undefined,
                learningPoints: lps
                  .filter((lp) => lp.source === 'VIDEO')
                  .map((lp) => ({
                    code: lp.code,
                    timeSeconds: lp.timeSeconds ?? 0,
                    title: lp.title,
                  })),
                exhibitTriggers: lesson.triggers
                  .filter((trigger) => trigger.language === loc.language)
                  .map((trigger) => ({
                    timeSeconds: trigger.timeSeconds,
                    exhibitRef: trigger.exhibitCode,
                  })),
              }
            : null;
          localized[loc.language] = {
            title: loc.title,
            description: loc.description ?? undefined,
            video,
            text: loc.textHtml
              ? {
                  html: loc.textHtml,
                  learningPoints: lps
                    .filter((lp) => lp.source === 'TEXT')
                    .map((lp) => ({ code: lp.code, heading: lp.title })),
                }
              : null,
          };
        }

        const exhibits: PackageExhibit[] = lesson.exhibits.map((exhibit) => ({
          code: exhibit.code,
          type: exhibit.type as PackageExhibit['type'],
          file: exhibit.mediaAssetId ? undefined : undefined,
          thumbnail: undefined,
          source: exhibit.sourceText ?? undefined,
          localized: (exhibit.localized as PackageExhibit['localized']) ?? {},
        }));

        return {
          code: lesson.code,
          order: lesson.sortOrder,
          localized,
          exhibits,
          recommendedReading: groupReadings(lesson.readings),
          knowledgeTest: {
            enabled: lesson.questions.length > 0,
            questions: lesson.questions
              .sort((a, b) => a.sortOrder - b.sortOrder)
              .map((question) => ({
                code: question.code,
                question: question.question,
                referenceAnswer: question.referenceAnswer ?? undefined,
              })),
          },
          applicationTest: lesson.applicationTest
            ? {
                enabled: lesson.applicationTest.enabled,
                scenario: lesson.applicationTest.scenario,
                referenceAnswer:
                  lesson.applicationTest.referenceAnswer ?? undefined,
              }
            : undefined,
        };
      }),
  );

  // 展品媒体是异步读取的；上面 map 里先占位，这里统一补齐。
  const pkgLessonByCode = new Map(
    lessons.map((lesson) => [lesson.code, lesson]),
  );
  for (const lesson of snapshot.course.lessons) {
    const pkgLesson = pkgLessonByCode.get(lesson.code);
    if (!pkgLesson) continue;
    for (const [exhibitIndex, exhibit] of lesson.exhibits.entries()) {
      const pkgExhibit = pkgLesson.exhibits?.[exhibitIndex];
      if (!pkgExhibit) continue;
      pkgExhibit.file = await addMedia(
        packageMediaPath.exhibit(
          exhibit.code,
          assetById.get(exhibit.mediaAssetId ?? '')?.extension ?? 'bin',
        ),
        exhibit.mediaAssetId,
      );
      pkgExhibit.thumbnail = await addMedia(
        packageMediaPath.exhibitThumb(
          exhibit.code,
          assetById.get(exhibit.thumbnailAssetId ?? '')?.extension ?? 'bin',
        ),
        exhibit.thumbnailAssetId,
      );
    }
  }

  const lessonCodes = new Set(lessons.map((lesson) => lesson.code));
  const codeByLessonId = new Map(
    snapshot.course.lessons.map((lesson) => [lesson.id, lesson.code]),
  );
  // 课程包里的 Trial 截止点必须用稳定的 LP code，而不是本环境数据库 ID。
  const cutoffIds = [
    ...new Set(
      course.trialRows
        .map((row) => row.textCutoffLearningPointId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const cutoffRows = cutoffIds.length
    ? await prisma.learningPoint.findMany({
        where: { id: { in: cutoffIds } },
        select: { id: true, code: true },
      })
    : [];
  const lpCodeById = new Map(
    cutoffRows.map((row) => [row.id, row.code]),
  );
  const trial = {
    enabled: course.trialEnabled,
    lessons: course.trialRows
      .map((row) => ({
        lessonRef: codeByLessonId.get(row.lessonId) ?? '',
        videoCutoffSeconds: row.videoCutoffSeconds,
        textCutoffLearningPoint: row.textCutoffLearningPointId
          ? (lpCodeById.get(row.textCutoffLearningPointId) ?? null)
          : null,
        status: row.status,
      }))
      .filter((row) => lessonCodes.has(row.lessonRef)),
  };

  const courseLocalized: PackageCourse['localized'] = {};
  for (const loc of snapshot.course.localizations) {
    courseLocalized[loc.language] = {
      title: loc.title,
      shortDescription: loc.shortDescription ?? undefined,
      overview: loc.overview ?? undefined,
      whatYouLearn: (loc.whatYouLearn as string[] | null) ?? [],
      provides: (loc.provides as unknown[] | null) ?? [],
    };
  }

  const pkgCourse: PackageCourse = {
    code: snapshot.course.code,
    slug: snapshot.course.slug,
    category: course.category?.name ?? course.legacyCategory ?? 'Uncategorized',
    learningMode: snapshot.course.learningMode as PackageCourse['learningMode'],
    learningLanguages: snapshot.course.learningLanguages,
    defaultContentLanguage: snapshot.course.defaultContentLanguage,
    cover,
    localized: courseLocalized,
    lessons,
    trial,
    pricing: course.plans.map((plan) => ({
      name: plan.name,
      termMonths: plan.termMonths,
      amountMinor: plan.amountMinor,
      currency: plan.currency,
      lookupKey:
        plan.stripeLookupKey ?? `${snapshot.course.code}_${plan.termMonths}m`,
    })),
  };

  const manifest: PackageManifest = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    packageId: `pkg_${courseId}_${Date.now().toString(36)}`,
    exportedAt: new Date().toISOString(),
    source: {
      environment: options.environment,
      courseCode: snapshot.course.code,
      sourceVersion: version.versionLabel,
    },
    incomplete: false,
    course: pkgCourse,
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  if (checksums.length) zip.file('checksums.sha256', checksums.join('\n'));

  return {
    bytes: await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    }),
    fileName: `${snapshot.course.code}_${version.versionLabel}.zip`,
    versionLabel: version.versionLabel,
  };
}

function groupReadings(
  readings: Array<{
    language: string;
    type: string;
    title: string;
    author: string | null;
    whyRecommended: string | null;
    sortOrder: number;
  }>,
): Record<string, PackageReading[]> {
  const grouped: Record<string, PackageReading[]> = {};
  for (const reading of [...readings].sort(
    (a, b) => a.sortOrder - b.sortOrder,
  )) {
    (grouped[reading.language] ??= []).push({
      type: reading.type as PackageReading['type'],
      title: reading.title,
      author: reading.author ?? undefined,
      why: reading.whyRecommended ?? undefined,
    });
  }
  return grouped;
}
