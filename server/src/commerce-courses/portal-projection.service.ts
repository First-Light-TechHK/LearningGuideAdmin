import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Portal v1 只读投影（设计文档 §22.2）：从 v2 数据重建旧 `ProductCourse` 形状，
 * 保证 Portal 现有页面不受影响。仅投影 liveStatus=ONLINE 且有 liveVersionId 的课程。
 */
@Injectable()
export class PortalProjectionService {
  constructor(private readonly prisma: PrismaService) {}

  async listCourses(limit = 50) {
    const rows = await this.prisma.commerceCourse.findMany({
      where: { liveStatus: 'ONLINE', liveVersionId: { not: null } },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      include: { category: true, cover: true, localizations: true, lessons: true },
    });
    return rows.map((row) => this.toSummary(row));
  }

  async getCourseById(id: string) {
    const row = await this.prisma.commerceCourse.findUnique({
      where: { id },
      include: this.detailInclude(),
    });
    if (!row || row.liveStatus !== 'ONLINE' || !row.liveVersionId) {
      return null;
    }
    return this.toDetail(row);
  }

  private detailInclude() {
    return {
      category: true,
      cover: true,
      localizations: true,
      lessons: {
        orderBy: { sortOrder: 'asc' as const },
        include: {
          localizations: { include: { video: true } },
          exhibits: { include: { media: true } },
          learningPoints: { orderBy: { sortOrder: 'asc' as const } },
          triggers: true,
          readings: { orderBy: { sortOrder: 'asc' as const } },
        },
      },
      trialRows: true,
    };
  }

  private toSummary(row: {
    id: string;
    slug: string;
    code: string;
    subtitle: string | null;
    level: string | null;
    tags: unknown;
    referencePrice: number | null;
    discount: number | null;
    category: { name: string; id: string } | null;
    localizations: { language: string; title: string; shortDescription: string | null; overview: string | null }[];
    lessons: unknown[];
    cover: { storageKey: string } | null;
  }) {
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
      lessonCount: row.lessons.length,
    };
  }

  private toDetail(row: {
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
    localizations: { language: string; title: string; shortDescription: string | null; overview: string | null }[];
    lessons: Array<{
      id: string;
      code: string;
      sortOrder: number;
      localizations: Array<{
        language: string;
        title: string;
        description: string | null;
        video: { storageKey: string } | null;
        textHtml: string | null;
      }>;
      exhibits: Array<{ id: string; code: string; type: string; media: { storageKey: string } | null }>;
      learningPoints: Array<{ language: string; code: string; title: string; source: string; timeSeconds: number | null; sortOrder: number }>;
      readings: Array<{ language: string; type: string; title: string; author: string | null; whyRecommended: string | null }>;
    }>;
    trialRows: Array<{ lessonId: string; status: string }>;
  }) {
    const loc = row.localizations[0];
    // v1 投影：合成章节 + 课时
    const publicLessonIds = new Set(
      row.trialRows.filter((t) => t.status === 'READY').map((t) => t.lessonId),
    );
    return {
      id: row.id,
      slug: row.slug,
      code: row.code,
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
          lessons: row.lessons.map((lesson) => {
            const lloc = lesson.localizations[0];
            return {
              id: lesson.id,
              title: lloc?.title ?? lesson.code,
              summary: lloc?.description ?? null,
              isPublic: publicLessonIds.has(lesson.id),
              contents: this.rebuildContents(lesson),
            };
          }),
        },
      ],
    };
  }

  private rebuildContents(lesson: {
    localizations: Array<{ language: string; video: { storageKey: string } | null; textHtml: string | null }>;
    exhibits: Array<{ id: string; code: string; type: string; media: { storageKey: string } | null }>;
    learningPoints: Array<{ language: string; code: string; title: string; source: string; timeSeconds: number | null; sortOrder: number }>;
    readings: Array<{ language: string; type: string; title: string; author: string | null; whyRecommended: string | null }>;
  }) {
    const lloc = lesson.localizations[0];
    const contents: unknown[] = [];
    if (lloc?.video) {
      contents.push({
        id: `${lesson.exhibits.length}-video`,
        title: '',
        type: 'video',
        mode: 'lecture',
        url: `media/${lloc.video.storageKey}`,
        nodes: lesson.exhibits.map((ex) => ({
          id: ex.code,
          title: ex.code,
          type: this.mapExhibitType(ex.type),
          url: ex.media ? `media/${ex.media.storageKey}` : undefined,
          triggerTime: 0,
        })),
      });
    }
    if (lloc?.textHtml) {
      contents.push({
        id: `${lesson.exhibits.length}-text`,
        title: '',
        type: 'text',
        mode: 'lecture',
        html: lloc.textHtml,
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
