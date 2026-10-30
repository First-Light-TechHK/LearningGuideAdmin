import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import JSZip from 'jszip';
import type { Prisma } from '@prisma/client';
import { lockCourseRow } from '../prisma/course-lock';
import { PrismaService } from '../prisma/prisma.service';
import { IndexingService } from '../knowledge/indexing.service';
import { CreateReleaseDto } from './dto/create-release.dto';
import { ActivateReleaseDto } from './dto/activate-release.dto';

/** 重复发布判定窗口：窗口内同说明、同快照的第二次提交视为重试（QA 2026-10-27 幂等） */
const PUBLISH_DEDUPE_WINDOW_MS = 60_000;

/** 键排序后的 JSON：jsonb 读回时键顺序会变，比较快照不能直接 JSON.stringify */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const body = entries.map(
      ([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`,
    );
    return `{${body.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * CourseAiConfig 中随 Release 复制的列（不含 id / releaseId / 时间戳，不含 SystemPrompt）
 *
 * 2026-10-29 A：不再复制 lectureSystemPrompt / socraticSystemPrompt / assessmentSystemPrompt / mainSystemPrompt。
 * 新建 Release 时这四列保持 null，resolvePrompts 自动走模板兜底 → 始终指向当前最新 md 文件。
 * 原因：旧 Release 可能存着被固化的旧 md 内容，复制过来就漂移了。
 * mainSystemPrompt 本来就不在此字段集（此前从未复制），保持不变。
 * 用户如需在新 Release 上自定义提示词，手动 Save 即可；Reset 恢复默认也直接从模板兜底链取最新值。
 */
const AI_CONFIG_COPY_FIELDS = {
  lectureModeId: true,
  socraticModeId: true,
  assessmentModeId: true,
  // lectureSystemPrompt / socraticSystemPrompt / assessmentSystemPrompt / mainSystemPrompt 均不复制（2026-10-29 A）
  welcomeMsg: true,
  llmProvider: true,
  model: true,
  llmBaseUrl: true,
  apiKey: true,
} as const;

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
    const outcome = await this.prisma.$transaction(async (tx) => {
      // 同一课程的发布串行执行，下面的重复判断才可靠（QA 2026-10-27 幂等）
      await lockCourseRow(tx, courseId);
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
      // 幂等：重复提交（连点、超时重试）在短时间内带来同样的说明和同样的快照时，
      // 返回刚发布的那个版本，不再生成第二个 Release
      const latest = await tx.release.findFirst({
        where: { courseId },
        orderBy: { createdAt: 'desc' },
      });
      if (
        latest &&
        latest.revisionNotes === dto.revisionNotes &&
        Date.now() - latest.createdAt.getTime() < PUBLISH_DEDUPE_WINDOW_MS &&
        stableJson(latest.snapshotData) === stableJson(snapshotData)
      ) {
        return { created: latest, duplicate: true };
      }
      // 仅写入快照，不更新 currentReleaseId（纯快照，2026-10-20 改拍）
      const created = await tx.release.create({
        data: {
          courseId,
          versionTag: `${course.title}_${this.timestamp()}`,
          revisionNotes: dto.revisionNotes,
          snapshotData,
        },
      });
      // AI 配置按 Release 一份：新版本沿用当前 Live（无则测试所选）版本的配置，
      // 否则把新版本设为 Live 后学员端会回到默认 Prompt / 模型 / 欢迎语（QA 2026-10-27 A3）
      const sourceReleaseId = course.currentReleaseId ?? course.aiTestReleaseId;
      if (sourceReleaseId) {
        const source = await tx.courseAiConfig.findUnique({
          where: {
            courseId_releaseId: { courseId, releaseId: sourceReleaseId },
          },
          select: AI_CONFIG_COPY_FIELDS,
        });
        if (source) {
          await tx.courseAiConfig.create({
            data: { ...source, courseId, releaseId: created.id },
          });
        }
      }
      // 置当前编辑版本指针 = 新 Release（2026-10-20 三次改拍，§3.4.3）；
      // 课程还没有任何测试 / Live 版本时，首个 Release 同时作为测试所选版本，
      // 否则 AI Tutor 后台无法保存配置或测试对话（QA 2026-10-27 A6）
      await tx.course.update({
        where: { id: courseId },
        data: {
          editingReleaseId: created.id,
          ...(sourceReleaseId ? {} : { aiTestReleaseId: created.id }),
        },
      });
      return { created, duplicate: false };
    });
    const { created, duplicate } = outcome;
    if (duplicate) return created;

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
    const result = await this.prisma.$transaction(async (tx) => {
      await lockCourseRow(tx, courseId);
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
      // 自愈：历史版本可能在索引失败（如 embedding 鉴权过期、事务超时）后
      // 从未生成 chunks，上线后检索会一直为空。上线时补建一次索引。
      const chunkCount = await tx.knowledgeChunk.count({
        where: { releaseId: release.id },
      });
      return {
        id: release.id,
        versionTag: release.versionTag,
        missingChunks: chunkCount === 0,
      };
    });

    if (result.missingChunks) {
      void this.indexing.indexRelease(result.id).catch(() => {
        /* IndexingService 内部已记录日志 */
      });
    }
    return { id: result.id, versionTag: result.versionTag };
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
      const found = await tx.release.findUnique({
        where: { id: releaseId },
        select: { courseId: true },
      });
      if (!found) {
        throw new NotFoundException('发布版本不存在');
      }
      // 先锁 Course 再复查：并发的 Set Live / 切换测试版本要么已提交（下面的保护检查能看到），
      // 要么等本事务结束后再校验（届时版本已不存在）
      await lockCourseRow(tx, found.courseId);
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
        throw new ConflictException(
          '该版本为 AI Tutor 后台测试所选版本，不可删除',
        );
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

  /**
   * 将 Release 快照打包成 ZIP 下载。
   * - ZIP 根目录直接平铺每页一个 Markdown 文件：{NNN}_{title}.md
   * - 不包含 manifest.json、不包含 pages/ 子目录
   * - 丢弃 sectionTags
   * - 纯读，不改动 Release / Course 任何状态
   */
  async exportZip(releaseId: string): Promise<{
    buffer: Buffer;
    filename: string;
  }> {
    const release = await this.prisma.release.findUnique({
      where: { id: releaseId },
    });
    if (!release) {
      throw new NotFoundException('发布版本不存在');
    }
    const snapshot = release.snapshotData as unknown as SnapshotData;
    const pages = snapshot.pages ?? [];

    const zip = new JSZip();

    for (const [i, page] of pages.entries()) {
      const safe = ReleasesService.sanitizeFilename(
        page.title || `page_${i + 1}`,
      );
      const padded = String(i + 1).padStart(3, '0');
      // 直接平铺到 ZIP 根目录，序号前缀保证唯一性
      const path = `${padded}_${safe}.md`;
      zip.file(path, page.contentMd ?? '');
    }

    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const filename = `${ReleasesService.sanitizeFilename(release.versionTag)}.zip`;
    return { buffer, filename };
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

  /**
   * 文件名清洗：去掉 Windows / macOS / Linux 非法字符、控制字符、首尾空白；
   * 不保留扩展名（zip 后缀由调用方追加）；长度上限 80。
   */
  private static sanitizeFilename(input: string): string {
    return (
      input
        .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || 'untitled'
    );
  }
}
