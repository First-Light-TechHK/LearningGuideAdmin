import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogueSourceService } from './catalogue-source.service';
import type { CatalogueCourse } from './course-registry';

/**
 * 同步模式：structure=课程/课时标题。
 * `all` 仅保留类型以兼容旧调用；控制器已直接返回 CONTENT_SYNC_DISABLED。
 * 本期不读写课程正文，本地 contentMd 保持不变。
 */
export type SyncMode = 'structure' | 'all';

export interface SyncSummary {
  /** 新建的 Page 数 */
  created: number;
  /** 新建的 Course 数（2026-10-26 新增：映射表课程首次导入时无 lesson，需单独计数） */
  courseCreated: number;
  /** 更新过的标题数（课程标题 + Page 标题 + externalId 回填） */
  updated: number;
  staleMarked: number;
  unchanged: boolean;
}

export interface ExternalCourseStatus {
  externalId: string;
  title: string;
  localCourseId: string | null;
  /** not_synced=本地未导入；synced=标题一致；has_updates=Portal 标题有变更或缺少 Page */
  status: 'not_synced' | 'synced' | 'has_updates';
}

interface LocalPage {
  id: string;
  externalId: string | null;
  title: string;
}

interface LocalCourse {
  id: string;
  title: string;
}

/**
 * 课程目录标题同步（2026-10-22 引入，2026-10-26 改数据源）。
 *
 * 数据源由 `CatalogueSourceService` 提供，即 KS 内置的课程 ID 映射表
 * （不再在运行时向 Portal 拉取）。课程以 `Course.externalId = courseID` 匹配，
 * 课时以 `Page.externalId = lesson.externalId` 匹配。
 * 只更新标题；正文、sectionTags、sortOrder、syncState 均不改动，避免误伤本地知识库内容。
 */
@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogue: CatalogueSourceService,
  ) {}

  /**
   * 同步目标列表 + 本地同步状态（供 Sidebar 选择器）。
   * 返回「映射表课程」与「本地带 externalId 的课程」的并集：
   * 映射表外但仍在本地的课程不隐藏，避免侧栏丢失入口。
   */
  async listExternalCourses(): Promise<ExternalCourseStatus[]> {
    const courses = await this.catalogue.listCourses();

    const localCourses = await this.prisma.course.findMany({
      where: { externalId: { not: null } },
      select: { id: true, title: true, externalId: true },
    });
    const localByExternalId = new Map(
      localCourses.map((course) => [course.externalId as string, course]),
    );

    const result: ExternalCourseStatus[] = [];
    for (const ext of courses) {
      const local = localByExternalId.get(ext.externalId);
      if (!local) {
        result.push({
          externalId: ext.externalId,
          title: ext.title,
          localCourseId: null,
          status: 'not_synced',
        });
        continue;
      }
      const pages = await this.prisma.page.findMany({
        where: { courseId: local.id },
        select: { id: true, externalId: true, title: true },
      });
      const diff = this.countDiff(local, pages, ext);
      result.push({
        externalId: ext.externalId,
        title: ext.title,
        localCourseId: local.id,
        status: diff === 0 ? 'synced' : 'has_updates',
      });
    }

    // 本地独有课程（不在映射表中）：照常列出，但无同步源
    const registryIds = new Set(courses.map((ext) => ext.externalId));
    for (const local of localCourses) {
      const externalId = local.externalId as string;
      if (registryIds.has(externalId)) continue;
      result.push({
        externalId,
        title: local.title,
        localCourseId: local.id,
        status: 'synced',
      });
    }
    return result;
  }

  /** 执行标题同步（幂等；不覆盖正文） */
  async sync(externalId: string, _mode: SyncMode): Promise<SyncSummary> {
    const ext = await this.catalogue.getCourse(externalId);
    if (!ext) {
      // 映射表外课程（本地独有）：无可同步项，保持原样
      const localOnly = await this.prisma.course.findFirst({
        where: { externalId },
        select: { id: true },
      });
      if (!localOnly) {
        throw new NotFoundException('该课程不在同步映射表中');
      }
      return {
        created: 0,
        courseCreated: 0,
        updated: 0,
        staleMarked: 0,
        unchanged: true,
      };
    }

    const local = await this.prisma.course.findFirst({
      where: { externalId },
      select: { id: true, title: true },
    });

    let created = 0;
    let courseCreated = 0;
    let updated = 0;

    await this.prisma.$transaction(async (tx) => {
      let courseId: string;
      if (!local) {
        const course = await tx.course.create({
          data: { title: ext.title, externalId },
          select: { id: true },
        });
        courseId = course.id;
        courseCreated += 1;
      } else {
        courseId = local.id;
        if (local.title !== ext.title) {
          await tx.course.update({
            where: { id: local.id },
            data: { title: ext.title },
          });
          updated += 1;
        }
      }

      const pages = await tx.page.findMany({
        where: { courseId },
        select: { id: true, externalId: true, title: true },
      });
      const byExternalId = new Map(
        pages
          .filter((page) => page.externalId)
          .map((page) => [page.externalId as string, page]),
      );
      // 仅允许用标题回填没有 externalId 的历史页面，避免抢占其他 lesson 的映射
      const byTitle = new Map(
        pages
          .filter((page) => !page.externalId)
          .map((page) => [page.title, page]),
      );
      const matchedPageIds = new Set<string>();

      for (const [index, lesson] of ext.lessons.entries()) {
        let page = byExternalId.get(lesson.externalId);
        if (!page) {
          // 历史数据没有 externalId：仅允许用标题回填，且不抢占其他 lesson 的映射
          const titleMatch = byTitle.get(lesson.title);
          if (
            titleMatch &&
            !titleMatch.externalId &&
            !matchedPageIds.has(titleMatch.id)
          ) {
            page = titleMatch;
          }
        }

        if (!page) {
          await tx.page.create({
            data: {
              courseId,
              externalId: lesson.externalId,
              title: lesson.title,
              contentMd: '',
              sortOrder: index,
            },
          });
          created += 1;
          continue;
        }

        matchedPageIds.add(page.id);
        const data: { externalId?: string; title?: string } = {};
        if (!page.externalId) data.externalId = lesson.externalId;
        if (page.title !== lesson.title) data.title = lesson.title;
        if (Object.keys(data).length) {
          await tx.page.update({ where: { id: page.id }, data });
          updated += 1;
        }
      }
    });

    return {
      created,
      courseCreated,
      updated,
      staleMarked: 0,
      unchanged: created === 0 && courseCreated === 0 && updated === 0,
    };
  }

  /** 计算若执行同步会产生多少处标题变更 */
  private countDiff(
    local: LocalCourse,
    pages: LocalPage[],
    ext: CatalogueCourse,
  ): number {
    let diff = local.title === ext.title ? 0 : 1;
    const byExternalId = new Map(
      pages
        .filter((page) => page.externalId)
        .map((page) => [page.externalId as string, page]),
    );
    // 仅允许用标题回填没有 externalId 的历史页面，避免抢占其他 lesson 的映射
    const byTitle = new Map(
      pages
        .filter((page) => !page.externalId)
        .map((page) => [page.title, page]),
    );

    for (const lesson of ext.lessons) {
      const page =
        byExternalId.get(lesson.externalId) ?? byTitle.get(lesson.title);
      if (!page) {
        diff += 1;
        continue;
      }
      if (!page.externalId || page.title !== lesson.title) diff += 1;
    }
    return diff;
  }
}
