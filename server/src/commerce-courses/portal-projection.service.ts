import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { VersionSnapshot } from './version-snapshot';

/**
 * Portal v1 只读投影（设计文档 §22.2）：从 v2 数据重建旧 `ProductCourse` 形状。
 *
 * P1b：线上内容来自 **live version 快照**，而不是工作区行。
 * 这样保存草稿不会提前改变 Portal，Publish 后才切换。
 */
@Injectable()
export class PortalProjectionService {
  constructor(private readonly prisma: PrismaService) {}

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
      this.toSummary(
        row,
        snapshotById.get(row.liveVersionId ?? '')?.course.lessons.length ?? 0,
      ),
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
      },
    });
    if (!row || row.liveStatus !== 'ONLINE' || !row.liveVersionId) return null;
    const version = await this.prisma.courseVersion.findUnique({
      where: { id: row.liveVersionId },
      select: { snapshotData: true },
    });
    if (!version) return null;
    const snapshot = version.snapshotData as unknown as VersionSnapshot;

    const assetIds = new Set<string>();
    for (const lesson of snapshot.course.lessons) {
      for (const loc of lesson.localizations)
        if (loc.videoAssetId) assetIds.add(loc.videoAssetId);
      for (const exhibit of lesson.exhibits) {
        if (exhibit.mediaAssetId) assetIds.add(exhibit.mediaAssetId);
        if (exhibit.thumbnailAssetId) assetIds.add(exhibit.thumbnailAssetId);
      }
    }
    const assets = assetIds.size
      ? await this.prisma.courseMediaAsset.findMany({
          where: { id: { in: [...assetIds] } },
          select: { id: true, storageKey: true },
        })
      : [];
    return this.toDetail(
      row,
      snapshot,
      new Map(assets.map((asset) => [asset.id, asset.storageKey])),
    );
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
      localizations: {
        language: string;
        title: string;
        shortDescription: string | null;
        overview: string | null;
      }[];
      cover: { storageKey: string } | null;
    },
    lessonCount: number,
  ) {
    const loc = row.localizations[0];
    return {
      id: row.id,
      slug: row.slug,
      code: row.code,
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
      lessonCount,
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
      localizations: {
        language: string;
        title: string;
        shortDescription: string | null;
        overview: string | null;
      }[];
      trialRows: Array<{ lessonId: string; status: string }>;
    },
    snapshot: VersionSnapshot,
    storageKeyById: Map<string, string>,
  ) {
    const loc =
      snapshot.course.localizations.find(
        (entry) => entry.language === snapshot.course.defaultContentLanguage,
      ) ??
      snapshot.course.localizations[0] ??
      row.localizations[0];
    const publicLessonIds = new Set(
      row.trialRows
        .filter((trial) => trial.status === 'READY')
        .map((trial) => trial.lessonId),
    );
    return {
      id: row.id,
      slug: snapshot.course.slug ?? row.slug,
      code: snapshot.course.code ?? row.code,
      title: loc?.title ?? row.slug,
      subtitle: row.subtitle ?? null,
      description: loc?.overview ?? null,
      category: row.category?.name ?? null,
      level: row.level ?? null,
      tags: row.tags ?? [],
      referencePrice: row.referencePrice ?? 0,
      discount: row.discount ?? 0,
      coverUrl: row.cover ? `/api/portal/v1/media/${row.id}/cover` : null,
      sections: [
        {
          id: 'all',
          title: 'Lessons',
          lessons: [...snapshot.course.lessons]
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((lesson) => {
              const lessonLoc =
                lesson.localizations.find(
                  (entry) =>
                    entry.language === snapshot.course.defaultContentLanguage,
                ) ?? lesson.localizations[0];
              return {
                id: lesson.id,
                title: lessonLoc?.title ?? lesson.code,
                summary: lessonLoc?.description ?? null,
                isPublic: publicLessonIds.has(lesson.id),
                contents: this.rebuildContents(lesson, storageKeyById),
              };
            }),
        },
      ],
    };
  }

  private rebuildContents(
    lesson: VersionSnapshot['course']['lessons'][number],
    storageKeyById: Map<string, string>,
  ) {
    const loc = lesson.localizations[0];
    const contents: unknown[] = [];
    if (loc?.videoAssetId) {
      const storageKey = storageKeyById.get(loc.videoAssetId) ?? '';
      contents.push({
        id: `${lesson.code}-video`,
        title: '',
        type: 'video',
        mode: 'lecture',
        url: `media/${storageKey}`,
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
              ? `media/${storageKeyById.get(exhibit.mediaAssetId) ?? ''}`
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

  private mapExhibitType(type: string): string {
    if (type === 'IMAGE') return 'image';
    if (type === 'VIDEO') return 'video';
    if (type === 'MODEL3D') return 'model3d';
    return 'image';
  }
}
