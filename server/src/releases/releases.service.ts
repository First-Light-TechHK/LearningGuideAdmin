import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IndexingService } from '../knowledge/indexing.service';
import { CreateReleaseDto } from './dto/create-release.dto';
import { ActivateReleaseDto } from './dto/activate-release.dto';

/** snapshotData 结构（开发文档 §2 Release 模型；2026-10-16 扁平化：lessons → pages；去 tags） */
interface SnapshotPage {
  id: string;
  title: string;
  contentMd: string;
  sectionTags?: unknown;
}
interface SnapshotData {
  pages?: SnapshotPage[];
}

/** 发布与版本（开发文档 §5.1.3、§3.4；纯快照发布 + 历史版本可切换/删除） */
@Injectable()
export class ReleasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly indexing: IndexingService,
  ) {}

  /**
   * 发布 Course 快照（**纯快照**，§3.4.3；2026-10-20 改拍）：
   * 将当前 Pages 内容固化为不可变 snapshotData 写入 Release 表；
   * **不改动 Course.currentReleaseId（Live 指针）**，故不影响 AI Tutor 的上线版本；
   * 亦不改动 Course.aiTestReleaseId（后台测试所选 Release，由用户在 AI Tutor 头部手动选择）。
   * **置 Course.editingReleaseId = 新 Release**（当前编辑版本指针；2026-10-20 三次改拍，§3.4.2）。
   * 快照仅收录 syncState=SYNCED 节点。
   * versionTag 格式: "CourseName_YYYYMMDDHHmm"。
   */
  async publish(courseId: string, dto: CreateReleaseDto) {
    const created = await this.prisma.$transaction(async (tx) => {
      const course = await tx.course.findUnique({
        where: { id: courseId },
        include: {
          pages: {
            where: { syncState: 'SYNCED' },
            orderBy: { sortOrder: 'asc' },
          },
        },
      });
      if (!course) {
        throw new NotFoundException('课程不存在');
      }
      const snapshotData = {
        pages: course.pages.map((page) => ({
          id: page.id,
          title: page.title,
          contentMd: page.contentMd,
          sectionTags: page.sectionTags,
        })),
      };
      // 仅写入快照，不更新 currentReleaseId（纯快照，2026-10-20 改拍）
      const created = await tx.release.create({
        data: {
          courseId,
          versionTag: `${course.title}_${this.timestamp()}`,
          revisionNotes: dto.revisionNotes,
          snapshotData,
        },
      });
      // 置当前编辑版本指针 = 新 Release（2026-10-20 三次改拍，§3.4.3）
      await tx.course.update({
        where: { id: courseId },
        data: { editingReleaseId: created.id },
      });
      return created;
    });

    // 2026-10-26 新增：异步构建向量索引（RAG），不阻塞发布响应
    void this.indexing.indexRelease(created.id).catch(() => {
      /* IndexingService 内部已兜底日志；此处防 unhandled rejection */
    });
    return created;
  }

  /**
   * 切换到此版本（§3.4.2；2026-10-20 二次/三次改拍）：单事务内校验归属 → 以快照重建 Page 草稿
   * （覆盖当前草稿，含未发布修改；前端已二次确认）→ **置 `Course.editingReleaseId` = 该 Release**。
   * **不改动 `Course.currentReleaseId`（Live 指针）**——Live 只能由 §3.4.4 Set Live（AI Tutor 板块）变更。
   * 重建节点一律 syncState=SYNCED，后续 Sync 按标题匹配不受影响。
   */
  async activate(courseId: string, dto: ActivateReleaseDto) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { id: true },
    });
    if (!course) {
      throw new NotFoundException('课程不存在');
    }
    const release = await this.prisma.release.findUnique({
      where: { id: dto.releaseId },
    });
    if (!release || release.courseId !== courseId) {
      throw new NotFoundException('发布版本不存在或不属于该课程');
    }
    const snapshot = release.snapshotData as unknown as SnapshotData;
    return this.prisma.$transaction(async (tx) => {
      // 删除当前所有 Page（Course 级联无需管 Lesson）
      await tx.page.deleteMany({ where: { courseId } });
      for (const [pi, page] of (snapshot.pages ?? []).entries()) {
        await tx.page.create({
          data: {
            courseId,
            title: page.title,
            contentMd: page.contentMd ?? '',
            sectionTags:
              page.sectionTags == null
                ? undefined
                : (page.sectionTags as Prisma.InputJsonValue),
            sortOrder: pi,
            syncState: 'SYNCED',
          },
        });
      }
      // 置当前编辑版本指针 = 该 Release（2026-10-20 三次改拍）；不改动 currentReleaseId
      await tx.course.update({
        where: { id: courseId },
        data: { editingReleaseId: release.id },
      });
      return { id: release.id, versionTag: release.versionTag };
    });
  }

  /**
   * Set Live（§3.4.4，2026-10-20 新增）：**轻量**——仅把 Course.currentReleaseId 指向目标 Release，
   * **不重建、不覆盖当前可编辑 Page 草稿**（与 activate 的关键区别，供 AI Tutor 对话头部使用）。
   */
  async setLive(courseId: string, dto: ActivateReleaseDto) {
    // §3.4.4 第 3 步：在单事务内校验归属 → 更新上线指针（轻量，不重建/覆盖草稿）
    return this.prisma.$transaction(async (tx) => {
      const course = await tx.course.findUnique({
        where: { id: courseId },
        select: { id: true },
      });
      if (!course) {
        throw new NotFoundException('课程不存在');
      }
      const release = await tx.release.findUnique({
        where: { id: dto.releaseId },
        select: { id: true, courseId: true, versionTag: true },
      });
      if (!release || release.courseId !== courseId) {
        throw new NotFoundException('发布版本不存在或不属于该课程');
      }
      await tx.course.update({
        where: { id: courseId },
        data: { currentReleaseId: release.id },
      });
      return { id: release.id, versionTag: release.versionTag };
    });
  }

  /** Course 的 Release 历史列表（不含 snapshotData，避免响应过大；标注 Live / 后台测试所选 / 当前编辑版本） */
  async findAllByCourse(courseId: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        currentReleaseId: true,
        aiTestReleaseId: true,
        editingReleaseId: true,
      },
    });
    if (!course) {
      throw new NotFoundException('课程不存在');
    }
    const releases = await this.prisma.release.findMany({
      where: { courseId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        versionTag: true,
        revisionNotes: true,
        createdAt: true,
      },
    });
    return releases.map((r) => ({
      ...r,
      // isActive: 是否为 Live 版本；isTestSelected: 是否为 AI Tutor 后台测试所选版本；
      // isEditing: 是否为当前编辑版本（2026-10-20 新增，§3.4.2）
      isActive: r.id === course.currentReleaseId,
      isTestSelected: r.id === course.aiTestReleaseId,
      isEditing: r.id === course.editingReleaseId,
    }));
  }

  /**
   * 删除 Release（§3.4.5，2026-10-20 新增）：**双保护**——
   * Live 版本（currentReleaseId）与后台测试所选版本（aiTestReleaseId）均拒绝删除（409）。
   * 其余版本删除，其关联 CourseAiConfig 行经 onDelete: Cascade 一并删除；
   * **若被删除的版本恰为当前编辑版本（editingReleaseId），同事务清空该指针（置 null）**（三次改拍）。
   * 单事务内校验归属 → 保护检查 → 删除/清指针；不改动任何草稿与其他指针。
   */
  async remove(releaseId: string) {
    return this.prisma.$transaction(async (tx) => {
      const release = await tx.release.findUnique({
        where: { id: releaseId },
        select: { id: true, courseId: true, versionTag: true },
      });
      if (!release) {
        throw new NotFoundException('发布版本不存在');
      }
      const course = await tx.course.findUnique({
        where: { id: release.courseId },
        select: {
          currentReleaseId: true,
          aiTestReleaseId: true,
          editingReleaseId: true,
        },
      });
      if (course?.currentReleaseId === release.id) {
        throw new ConflictException('该版本为上线版本（Live），不可删除');
      }
      if (course?.aiTestReleaseId === release.id) {
        throw new ConflictException('该版本为 AI Tutor 后台测试所选版本，不可删除');
      }
      await tx.release.delete({ where: { id: release.id } });
      // 清空当前编辑版本指针（若被删版本即 editing 版本）
      if (course?.editingReleaseId === release.id) {
        await tx.course.update({
          where: { id: release.courseId },
          data: { editingReleaseId: null },
        });
      }
      return { id: release.id, versionTag: release.versionTag };
    });
  }

  /** 某个 Release 的快照详情 */
  async findByReleaseId(releaseId: string) {
    const release = await this.prisma.release.findUnique({
      where: { id: releaseId },
    });
    if (!release) {
      throw new NotFoundException('发布版本不存在');
    }
    return release;
  }

  /** 本地时间 YYYYMMDDHHmm（精确到分钟） */
  private timestamp(): string {
    const d = new Date();
    const p = (n: number): string => String(n).padStart(2, '0');
    return (
      `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
      `${p(d.getHours())}${p(d.getMinutes())}`
    );
  }
}
