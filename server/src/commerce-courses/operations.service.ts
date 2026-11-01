import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { HISTORY_ACTIONS } from './publishing.service';

const BANNER_LANGUAGES = ['en-GB', 'zh-CN'] as const;

/**
 * Operations（PRD §19）：Popular Courses + Discovery Banner。
 * 修改后 Publish 立即在本环境网站生效；不设草稿、不生成课程版本、不入课程包。
 */
@Injectable()
export class OperationsService {
  constructor(private readonly prisma: PrismaService) {}

  async getPopular() {
    const [entries, state] = await Promise.all([
      this.prisma.popularCourseEntry.findMany({
        orderBy: { sortOrder: 'asc' },
      }),
      this.prisma.popularCoursesState.findUnique({
        where: { id: 'singleton' },
      }),
    ]);
    const courses = entries.length
      ? await this.prisma.commerceCourse.findMany({
          where: { id: { in: entries.map((entry) => entry.courseId) } },
          include: { category: true, localizations: true, cover: true },
        })
      : [];
    const courseById = new Map(courses.map((course) => [course.id, course]));
    return {
      items: entries.map((entry) => {
        const course = courseById.get(entry.courseId);
        const loc = course?.localizations[0];
        return {
          courseId: entry.courseId,
          sortOrder: entry.sortOrder,
          code: course?.code ?? '—',
          title: loc?.title ?? course?.slug ?? '—',
          category: course?.category?.name ?? null,
          liveStatus: course?.liveStatus ?? 'OFFLINE',
          trialEnabled: course?.trialEnabled ?? false,
          coverUrl: course?.cover
            ? `/api/backoffice/courses/${course.id}/cover`
            : null,
          invalid: !course || course.liveStatus !== 'ONLINE',
        };
      }),
      publishedAt: state?.publishedAt ?? null,
      publishedBy: state?.publishedBy ?? null,
    };
  }

  async savePopular(items: Array<{ courseId: string; sortOrder?: number }>) {
    if (items.length > 6) {
      throw new ConflictException({
        code: 'POPULAR_LIMIT',
        message: 'Popular Courses allows 1–6 courses.',
      });
    }
    const ids = items.map((item) => item.courseId);
    if (new Set(ids).size !== ids.length) {
      throw new ConflictException({
        code: 'POPULAR_DUPLICATE',
        message: 'The same course cannot be added twice.',
      });
    }
    if (ids.length > 0) {
      const courses = await this.prisma.commerceCourse.findMany({
        where: { id: { in: ids } },
        select: { id: true, liveStatus: true },
      });
      if (courses.length !== ids.length) {
        throw new NotFoundException({
          code: 'COURSE_NOT_FOUND',
          message: 'Course not found.',
        });
      }
      if (courses.some((course) => course.liveStatus !== 'ONLINE')) {
        throw new ConflictException({
          code: 'POPULAR_ONLINE_ONLY',
          message: 'Only Online courses can be added to Popular Courses.',
        });
      }
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.popularCourseEntry.deleteMany({});
      for (const [index, item] of items.entries()) {
        await tx.popularCourseEntry.create({
          data: { courseId: item.courseId, sortOrder: item.sortOrder ?? index },
        });
      }
    });
    return this.getPopular();
  }

  async getBanner() {
    const banner = await this.prisma.discoveryBanner.findUnique({
      where: { id: 'singleton' },
    });
    const course = banner?.courseId
      ? await this.prisma.commerceCourse.findUnique({
          where: { id: banner.courseId },
          include: { localizations: true, cover: true },
        })
      : null;
    const invalid =
      Boolean(banner?.enabled) &&
      (!course || course.liveStatus !== 'ONLINE' || !course.trialEnabled);
    return {
      enabled: banner?.enabled ?? false,
      courseId: banner?.courseId ?? null,
      localized: (banner?.localized as Record<string, unknown> | null) ?? null,
      publishedAt: banner?.publishedAt ?? null,
      publishedBy: banner?.publishedBy ?? null,
      invalid,
      course: course
        ? {
            id: course.id,
            code: course.code,
            title: course.localizations[0]?.title ?? course.slug,
            liveStatus: course.liveStatus,
            trialEnabled: course.trialEnabled,
            coverUrl: course.cover
              ? `/api/backoffice/courses/${course.id}/cover`
              : null,
          }
        : null,
    };
  }

  async saveBanner(body: {
    enabled: boolean;
    courseId?: string | null;
    localized?: Record<string, unknown> | null;
  }) {
    const courseId = body.courseId ?? null;
    if (courseId) {
      const course = await this.prisma.commerceCourse.findUnique({
        where: { id: courseId },
        select: { id: true, liveStatus: true, trialEnabled: true },
      });
      if (!course)
        throw new NotFoundException({
          code: 'COURSE_NOT_FOUND',
          message: 'Course not found.',
        });
      if (
        body.enabled &&
        (course.liveStatus !== 'ONLINE' || !course.trialEnabled)
      ) {
        throw new ConflictException({
          code: 'OPERATIONS_INVALID',
          message: 'The featured course must be Online with Trial enabled.',
        });
      }
    }
    await this.prisma.discoveryBanner.upsert({
      where: { id: 'singleton' },
      create: {
        id: 'singleton',
        enabled: Boolean(body.enabled),
        courseId,
        localized: (body.localized ?? null) as Prisma.InputJsonValue,
      },
      update: {
        enabled: Boolean(body.enabled),
        courseId,
        localized: (body.localized ?? null) as Prisma.InputJsonValue,
      },
    });
    return this.getBanner();
  }

  /** 运营位 Publish：立即生效，写 History，不生成课程版本。 */
  async publish(
    section: 'popular' | 'banner' | 'both',
    actorEmployeeId: string | null,
    reason?: string,
  ) {
    const sections: Array<'popular' | 'banner'> =
      section === 'both' ? ['popular', 'banner'] : [section];
    if (sections.includes('popular')) {
      const popular = await this.getPopular();
      if (popular.items.length < 1 || popular.items.length > 6) {
        throw new ConflictException({
          code: 'OPERATIONS_INVALID',
          message:
            'Popular Courses must contain 1–6 courses before publishing.',
        });
      }
      if (popular.items.some((item) => item.invalid)) {
        throw new ConflictException({
          code: 'OPERATIONS_INVALID',
          message:
            'Replace or remove courses that are no longer Online before publishing.',
        });
      }
    }
    if (sections.includes('banner')) {
      const banner = await this.getBanner();
      if (banner.enabled) {
        if (
          !banner.course ||
          banner.course.liveStatus !== 'ONLINE' ||
          !banner.course.trialEnabled
        ) {
          throw new ConflictException({
            code: 'OPERATIONS_INVALID',
            message: 'The featured course must be Online with Trial enabled.',
          });
        }
        const localized = banner.localized ?? {};
        for (const language of BANNER_LANGUAGES) {
          const entry = (localized[language] ?? {}) as Record<string, unknown>;
          for (const field of ['headline', 'subheading', 'buttonLabel']) {
            if (typeof entry[field] !== 'string' || !entry[field].trim()) {
              throw new ConflictException({
                code: 'OPERATIONS_INVALID',
                message: `Discovery Banner ${field} is required (${language}).`,
              });
            }
          }
        }
      }
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      if (sections.includes('popular')) {
        await tx.popularCoursesState.upsert({
          where: { id: 'singleton' },
          create: {
            id: 'singleton',
            publishedAt: now,
            publishedBy: actorEmployeeId,
          },
          update: { publishedAt: now, publishedBy: actorEmployeeId },
        });
      }
      if (sections.includes('banner')) {
        await tx.discoveryBanner.upsert({
          where: { id: 'singleton' },
          create: {
            id: 'singleton',
            enabled: false,
            publishedAt: now,
            publishedBy: actorEmployeeId,
          },
          update: { publishedAt: now, publishedBy: actorEmployeeId },
        });
      }
      await tx.courseAuthoringActivity.create({
        data: {
          courseId: null,
          actorEmployeeId,
          action: HISTORY_ACTIONS.OPERATIONS_PUBLISH,
          detail: { section, reason: reason ?? null },
        },
      });
    });
    return { publishedAt: now, section };
  }
}
