import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CourseStorageService } from './storage.service';
import {
  captureVersionSnapshot,
  type VersionSnapshot,
} from './version-snapshot';

type SnapshotLesson = VersionSnapshot['course']['lessons'][number];
type SnapshotLocalization = VersionSnapshot['course']['localizations'][number];

/**
 * Portal v1 只读投影（设计文档 §22.2）：从 v2 数据重建 Portal 课程详情。
 *
 * P1b：线上内容来自 **live version 快照**，而不是工作区行。
 * 这样保存草稿不会提前改变 Portal，Publish 后才切换。
 */
@Injectable()
export class PortalProjectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: CourseStorageService,
  ) {}

  async listCourses(limit = 50) {
    const rows = await this.prisma.commerceCourse.findMany({
      where: {
        liveStatus: 'ONLINE',
        liveVersionId: { not: null },
        archivedAt: null,
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      include: { category: true, cover: true, localizations: true },
    });
    const versions = await this.prisma.courseVersion.findMany({
      where: {
        id: {
          in: rows
            .map((row) => row.liveVersionId)
            .filter((id): id is string => Boolean(id)),
        },
      },
      select: { id: true, snapshotData: true },
    });
    const snapshotById = new Map(
      versions.map((version) => [
        version.id,
        version.snapshotData as unknown as VersionSnapshot,
      ]),
    );
    return rows.map((row) =>
      this.toSummary(row, snapshotById.get(row.liveVersionId ?? '') ?? null),
    );
  }

  async getCourseById(id: string) {
    const row = await this.prisma.commerceCourse.findUnique({
      where: { id },
      include: {
        category: true,
        cover: true,
        localizations: true,
        trialRows: true,
        plans: {
          where: { active: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });
    if (
      !row ||
      row.liveStatus !== 'ONLINE' ||
      row.archivedAt ||
      !row.liveVersionId
    )
      return null;
    const version = await this.prisma.courseVersion.findUnique({
      where: { id: row.liveVersionId },
      select: { snapshotData: true },
    });
    if (!version) return null;
    const snapshot = version.snapshotData as unknown as VersionSnapshot;
    return this.toDetail(row, snapshot);
  }

  /** 预览投影：草稿或指定版本，仅在 Portal preview token 校验通过后调用。 */
  async getPreviewCourse(courseId: string, versionId?: string) {
    const row = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      include: {
        category: true,
        cover: true,
        localizations: true,
        trialRows: true,
        plans: {
          where: { active: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });
    if (!row || row.archivedAt) return null;

    let snapshot: VersionSnapshot;
    let versionLabel: string | null = null;
    if (versionId) {
      const version = await this.prisma.courseVersion.findFirst({
        where: { id: versionId, courseId },
        select: { snapshotData: true, versionLabel: true },
      });
      if (!version) return null;
      snapshot = version.snapshotData as unknown as VersionSnapshot;
      versionLabel = version.versionLabel;
    } else {
      snapshot = await captureVersionSnapshot(this.prisma, courseId);
    }

    return {
      ...this.toDetail(row, snapshot),
      preview: {
        source: versionId ? 'version' : 'draft',
        versionLabel,
      },
    };
  }

  async getCoverBytes(courseId: string) {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: {
        liveStatus: true,
        archivedAt: true,
        cover: { select: { storageKey: true, extension: true } },
      },
    });
    if (
      !course ||
      course.liveStatus !== 'ONLINE' ||
      course.archivedAt ||
      !course.cover
    )
      return null;
    try {
      return {
        bytes: await this.storage.getMedia(course.cover.storageKey),
        extension: course.cover.extension,
      };
    } catch {
      return null;
    }
  }

  async getMediaBytes(courseId: string, assetId: string) {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: { liveStatus: true, archivedAt: true },
    });
    if (!course || course.liveStatus !== 'ONLINE' || course.archivedAt)
      return null;
    const asset = await this.prisma.courseMediaAsset.findFirst({
      where: { id: assetId, courseId },
      select: { storageKey: true, extension: true },
    });
    if (!asset) return null;
    try {
      return {
        bytes: await this.storage.getMedia(asset.storageKey),
        extension: asset.extension,
      };
    } catch {
      return null;
    }
  }

  private toSummary(
    row: {
      id: string;
      slug: string;
      code: string;
      subtitle: string | null;
      level: string | null;
      tags: unknown;
      referencePrice: number | null;
      discount: number | null;
      category: { name: string } | null;
      localizations: SnapshotLocalization[];
      cover: { storageKey: string } | null;
    },
    snapshot: VersionSnapshot | null,
  ) {
    const loc =
      this.pickLocalization(
        snapshot?.course.localizations,
        snapshot?.course.defaultContentLanguage,
      ) ?? row.localizations[0];
    const lessons = snapshot?.course.lessons ?? [];
    return {
      id: row.id,
      slug: snapshot?.course.slug ?? row.slug,
      code: snapshot?.course.code ?? row.code,
      title: loc?.title ?? row.slug,
      subtitle: row.subtitle ?? null,
      shortDescription: loc?.shortDescription ?? null,
      description: loc?.overview ?? null,
      category: row.category?.name ?? null,
      level: row.level ?? null,
      tags: row.tags ?? [],
      referencePrice: row.referencePrice ?? 0,
      discount: row.discount ?? 0,
      coverUrl: row.cover ? `/api/portal/v1/media/${row.id}/cover` : null,
      lessonCount: lessons.length,
      totalDurationSeconds: this.totalDuration(
        lessons,
        snapshot?.course.defaultContentLanguage,
      ),
      learningMode: snapshot?.course.learningMode ?? null,
      learningLanguages: snapshot?.course.learningLanguages ?? [],
    };
  }

  private toDetail(
    row: {
      id: string;
      slug: string;
      code: string;
      subtitle: string | null;
      level: string | null;
      tags: unknown;
      referencePrice: number | null;
      discount: number | null;
      category: { name: string } | null;
      cover: { storageKey: string } | null;
      localizations: SnapshotLocalization[];
      trialEnabled: boolean;
      trialRows: Array<{ lessonId: string; status: string }>;
      plans: Array<{
        id: string;
        name: string;
        termMonths: number;
        amountMinor: number;
        currency: string;
        stripeLookupKey: string | null;
        trialEligible: boolean;
      }>;
    },
    snapshot: VersionSnapshot,
  ) {
    const loc =
      this.pickLocalization(
        snapshot.course.localizations,
        snapshot.course.defaultContentLanguage,
      ) ?? row.localizations[0];
    const publicLessonIds = new Set(
      row.trialRows
        .filter((trial) => trial.status === 'READY')
        .map((trial) => trial.lessonId),
    );
    const lessons = [...snapshot.course.lessons].sort(
      (a, b) => a.sortOrder - b.sortOrder,
    );
    return {
      id: row.id,
      slug: snapshot.course.slug ?? row.slug,
      code: snapshot.course.code ?? row.code,
      title: loc?.title ?? row.slug,
      subtitle: row.subtitle ?? null,
      shortDescription: loc?.shortDescription ?? null,
      description: loc?.overview ?? null,
      category: row.category?.name ?? null,
      level: row.level ?? null,
      tags: row.tags ?? [],
      referencePrice: row.referencePrice ?? 0,
      discount: row.discount ?? 0,
      coverUrl: row.cover ? `/api/portal/v1/media/${row.id}/cover` : null,
      learningMode: snapshot.course.learningMode,
      learningLanguages: snapshot.course.learningLanguages ?? [],
      defaultContentLanguage: snapshot.course.defaultContentLanguage,
      whatYouLearn: loc?.whatYouLearn ?? [],
      provides: loc?.provides ?? [],
      lessonCount: lessons.length,
      totalDurationSeconds: this.totalDuration(
        lessons,
        snapshot.course.defaultContentLanguage,
      ),
      trial: {
        enabled: row.trialEnabled,
        lessonIds: [...publicLessonIds],
      },
      plans: row.plans.map((plan) => ({
        id: plan.id,
        name: plan.name,
        termMonths: plan.termMonths,
        amountMinor: plan.amountMinor,
        currency: plan.currency,
        lookupKey: plan.stripeLookupKey,
        trialEligible: plan.trialEligible,
      })),
      sections: [
        {
          id: 'all',
          title: 'Lessons',
          lessons: lessons.map((lesson) => {
            const lessonLoc = this.pickLocalization(
              lesson.localizations,
              snapshot.course.defaultContentLanguage,
            );
            return {
              id: lesson.id,
              title: lessonLoc?.title ?? lesson.code,
              summary: lessonLoc?.description ?? null,
              durationSeconds: lessonLoc?.videoDurationSeconds ?? null,
              isPublic: publicLessonIds.has(lesson.id),
              contents: this.rebuildContents(lesson, snapshot, row.id),
            };
          }),
        },
      ],
    };
  }

  private rebuildContents(
    lesson: SnapshotLesson,
    snapshot: VersionSnapshot,
    courseId: string,
  ) {
    const loc = this.pickLocalization(
      lesson.localizations,
      snapshot.course.defaultContentLanguage,
    );
    const contents: unknown[] = [];
    if (loc?.videoAssetId) {
      contents.push({
        id: `${lesson.code}-video`,
        title: '',
        type: 'video',
        mode: 'lecture',
        url: this.mediaUrl(courseId, loc.videoAssetId),
        nodes: lesson.exhibits.map((exhibit) => {
          const trigger = lesson.triggers.find(
            (entry) =>
              entry.exhibitCode === exhibit.code &&
              entry.language === loc.language,
          );
          return {
            id: exhibit.code,
            title: exhibit.code,
            type: this.mapExhibitType(exhibit.type),
            url: exhibit.mediaAssetId
              ? this.mediaUrl(courseId, exhibit.mediaAssetId)
              : undefined,
            triggerTime: trigger?.timeSeconds ?? 0,
          };
        }),
      });
    }
    if (loc?.textHtml) {
      contents.push({
        id: `${lesson.code}-text`,
        title: '',
        type: 'text',
        mode: 'lecture',
        html: loc.textHtml,
        nodes: [],
      });
    }
    return contents;
  }

  private mediaUrl(courseId: string, assetId: string): string {
    return `/api/portal/v1/media/${courseId}/assets/${assetId}`;
  }

  private pickLocalization<T extends { language: string }>(
    entries: T[] | undefined,
    language: string | undefined,
  ): T | undefined {
    if (!entries?.length) return undefined;
    return (
      entries.find((entry) => entry.language === language) ?? entries[0]
    );
  }

  private totalDuration(
    lessons: SnapshotLesson[],
    language: string | undefined,
  ): number {
    return lessons.reduce((sum, lesson) => {
      const loc = this.pickLocalization(lesson.localizations, language);
      return sum + (loc?.videoDurationSeconds ?? 0);
    }, 0);
  }

  private mapExhibitType(type: string): string {
    if (type === 'IMAGE') return 'image';
    if (type === 'VIDEO') return 'video';
    if (type === 'MODEL3D') return 'model3d';
    return 'image';
  }
}
