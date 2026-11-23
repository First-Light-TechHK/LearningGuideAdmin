import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { notifyCourseNewLaunch } from '../backoffice/modules/notification/events';
import {
  COMMERCE_CONFIG,
  type CommerceCourseConfig,
  type VersionNumberingMode,
} from './commerce.config';
import {
  computeCompleteness,
  canExport,
  type CourseCompleteness,
} from './completeness';
import {
  applyVersionSnapshotInTx,
  captureVersionSnapshot,
  completenessTrial,
  loadBrokenAssetIds,
  snapshotToCompletenessInput,
  type VersionSnapshot,
} from './version-snapshot';
import { TrialService } from './trial.service';
import { snapshotContentHash, versionContentHash } from './content-hash';
import { employeeNames, operatorName } from './employee-names';
import { oneOf } from './input';

/** Notification P0：首次发布 = 发布前没有线上版本（重新发布不触发 COURSE_NEW_LAUNCH）。 */
export function isFirstCoursePublish(course: {
  liveVersionId: string | null;
}): boolean {
  return !course.liveVersionId;
}

export interface VersionLabelResult {
  label: string;
  series: number;
  minor: number;
}

/** 课程首次发布事件需要的展示字段（eventKey 之外）。纯函数，便于单测回退规则。 */
export type CourseLaunchSource = {
  code: string;
  slug: string;
  defaultContentLanguage: string | null;
  localizations: Array<{ language: string; title: string | null }>;
  category: { name: string; localized: unknown } | null;
};

export function courseLaunchEventParams(course: CourseLaunchSource): {
  courseTitle: string;
  categoryName: string;
  courseLink: string;
} {
  const preferred =
    course.localizations.find(
      (item) => item.language === course.defaultContentLanguage,
    ) ?? course.localizations[0];
  const courseTitle = preferred?.title?.trim() || course.code;
  const localized =
    course.category?.localized &&
    typeof course.category.localized === 'object' &&
    !Array.isArray(course.category.localized)
      ? (course.category.localized as Record<string, unknown>)
      : {};
  const lang = course.defaultContentLanguage || 'en-GB';
  const entry = localized[lang] ?? localized['en-GB'];
  const rawName =
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? (entry as Record<string, unknown>).name
      : undefined;
  const categoryName = typeof rawName === 'string' ? rawName.trim() : '';
  return {
    courseTitle,
    categoryName: categoryName || course.category?.name || '',
    courseLink: `/${lang === 'zh-CN' ? 'zh-CN' : 'en-GB'}/portal/courses/${encodeURIComponent(course.slug)}`,
  };
}

/** 纯函数：下一次发布的版本编号（PRD §15.3）。 */
export function nextVersionLabel(
  mode: VersionNumberingMode,
  last: {
    versionSeries: number;
    versionMinor: number;
    exportedAt?: Date | string | null;
  } | null,
): VersionLabelResult {
  if (mode === 'production') {
    const minor = (last?.versionMinor ?? 0) + 1;
    return { label: `Version ${minor}`, series: 0, minor };
  }
  if (!last) return { label: '1.1', series: 1, minor: 1 };
  if (last.exportedAt) {
    const series = last.versionSeries + 1;
    return { label: `${series}.1`, series, minor: 1 };
  }
  const minor = last.versionMinor + 1;
  return {
    label: `${last.versionSeries}.${minor}`,
    series: last.versionSeries,
    minor,
  };
}

export const HISTORY_ACTIONS = {
  PUBLISH: 'PUBLISH',
  DELETE_DRAFT: 'DELETE_DRAFT',
  RESTORE: 'RESTORE',
  EXPORT_PACKAGE: 'EXPORT_PACKAGE',
  IMPORT_PACKAGE: 'IMPORT_PACKAGE',
  CHANGE_STATUS: 'CHANGE_STATUS',
  OPERATIONS_PUBLISH: 'OPERATIONS_PUBLISH',
  CREATE_COURSE: 'CREATE_COURSE',
  ADD_LEARNING_LANGUAGE: 'ADD_LEARNING_LANGUAGE',
} as const;

/** Change status 只接受三种线上状态，且必须说明原因（PRD §21）。 */
export const LIVE_STATUSES = ['ONLINE', 'HIDDEN', 'OFFLINE'] as const;
export type LiveStatusValue = (typeof LIVE_STATUSES)[number];

export interface ChangeStatusInput {
  status: LiveStatusValue;
  reason: string;
}

/**
 * Change status 请求体的正式契约：status 必填且必须是三种状态之一，reason 必须是非空文字。
 *
 * 以前直接把 body 交给 Prisma：缺 status 时 `data.liveStatus = undefined` 被忽略，
 * 请求返回 200 却什么都不改（QA 黑盒复现）。现在形状错误显式拒绝：
 * status 缺失/非法 → 400 VALIDATION_ERROR（details.field=status）；
 * reason 缺失/空白 → 409 REASON_REQUIRED（保持原有业务码）。
 */
export function parseChangeStatusBody(body: unknown): ChangeStatusInput {
  const input =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const status = oneOf(input.status, LIVE_STATUSES, 'status');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) {
    throw new ConflictException({
      code: 'REASON_REQUIRED',
      message: 'A reason is required to change status.',
    });
  }
  return { status, reason };
}

@Injectable()
export class PublishingService {
  private readonly logger = new Logger(PublishingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly trial: TrialService,
    @Inject(COMMERCE_CONFIG) private readonly config: CommerceCourseConfig,
  ) {}

  /**
   * 读取工作区（草稿）并计算完成度：先拍一份快照（只读），再走和线上版本相同的规则，
   * 所以课程详情、Publish 门禁和导出检查对同一份内容给出同样的 issues。
   */
  async completenessForDraft(courseId: string): Promise<CourseCompleteness> {
    const [snapshot, trial, brokenAssetIds] = await Promise.all([
      captureVersionSnapshot(this.prisma, courseId),
      this.trial.get(courseId),
      loadBrokenAssetIds(this.prisma, courseId),
    ]);
    return computeCompleteness(
      snapshotToCompletenessInput(snapshot, completenessTrial(trial), {
        brokenAssetIds,
      }),
    );
  }

  /** 发布草稿：生成不可变版本，立即成为本环境线上版本。 */
  async publish(
    courseId: string,
    actorEmployeeId: string | null,
    options?: { notifyLearners?: boolean },
  ) {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        code: true,
        liveVersionId: true,
        liveStatus: true,
        hasDraft: true,
        draftSourceType: true,
        draftSourceEnvironment: true,
        draftSourceVersionLabel: true,
        archivedAt: true,
      },
    });
    if (!course)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });
    if (course.archivedAt) {
      throw new ConflictException({
        code: 'COURSE_ARCHIVED',
        message: 'Archived course cannot be published',
      });
    }
    if (!course.hasDraft) {
      throw new ConflictException({
        code: 'NO_DRAFT',
        message: 'There is no draft to publish.',
      });
    }

    const completeness = await this.completenessForDraft(courseId);
    if (!completeness.canPublish) {
      throw new ConflictException({
        code: 'PUBLISH_BLOCKED',
        message: completeness.publishBlockers.join(' '),
        blockers: completeness.publishBlockers,
        blockerCodes: completeness.publishBlockerCodes,
        incompleteLessons: completeness.incompleteLessons,
      });
    }

    const source = this.resolveSource(course);
    // 锁住课程行后再取上一版本号、拍快照：两人同时点发布时第二个请求等第一个提交，
    // 然后看到草稿已发布返回 NO_DRAFT，不会撞 (courseId, versionNo) 唯一键变成 500。
    const version = await this.prisma.$transaction(
      async (tx) => {
        const [locked] = await tx.$queryRaw<
          { hasDraft: boolean; liveVersionId: string | null }[]
        >`
          SELECT "hasDraft", "liveVersionId" FROM "CommerceCourse"
          WHERE id = ${courseId} FOR UPDATE`;
        if (!locked?.hasDraft) {
          throw new ConflictException({
            code: 'NO_DRAFT',
            message: 'There is no draft to publish.',
          });
        }
        const snapshot = await captureVersionSnapshot(tx, courseId);
        const contentHash = await snapshotContentHash(tx, snapshot);
        // 草稿改回了线上内容（PRD §15.1）：清掉草稿标记，不生成重复版本。
        if (
          locked.liveVersionId &&
          (await versionContentHash(tx, locked.liveVersionId)) === contentHash
        ) {
          await tx.commerceCourse.update({
            where: { id: courseId },
            data: {
              hasDraft: false,
              lifecycleStatus: 'LIVE',
              draftSourceType: null,
              draftSourceEnvironment: null,
              draftSourceVersionLabel: null,
            },
          });
          return null;
        }
        const last = await tx.courseVersion.findFirst({
          where: { courseId },
          orderBy: { versionNo: 'desc' },
          select: {
            versionNo: true,
            versionSeries: true,
            versionMinor: true,
            exportedAt: true,
          },
        });
        const numbering = nextVersionLabel(
          this.config.versionNumberingMode,
          last,
        );
        const created = await tx.courseVersion.create({
          data: {
            courseId,
            versionNo: (last?.versionNo ?? 0) + 1,
            versionLabel: numbering.label,
            versionSeries: numbering.series,
            versionMinor: numbering.minor,
            sourceEnvironment: source.environment,
            sourceVersionLabel: source.label,
            snapshotData: snapshot as unknown as Prisma.InputJsonValue,
            contentHash,
            wentLiveAt: new Date(),
            createdBy: actorEmployeeId,
          },
        });
        await tx.commerceCourse.update({
          where: { id: courseId },
          data: {
            liveVersionId: created.id,
            // 首次发布后为 Offline；之后发布保持当前状态（PRD §17）
            liveStatus: course.liveVersionId ? course.liveStatus : 'OFFLINE',
            lifecycleStatus: 'LIVE',
            hasDraft: false,
            draftSourceType: null,
            draftSourceEnvironment: null,
            draftSourceVersionLabel: null,
          },
        });
        await tx.courseAuthoringActivity.create({
          data: {
            courseId,
            versionNo: created.versionNo,
            actorEmployeeId,
            action: HISTORY_ACTIONS.PUBLISH,
            detail: {
              versionLabel: numbering.label,
              sourceEnvironment: source.environment,
              sourceVersionLabel: source.label,
              notifyLearners: Boolean(options?.notifyLearners),
            },
          },
        });
        return created;
      },
      { timeout: 30_000 },
    );
    if (!version) {
      throw new ConflictException({
        code: 'NO_DRAFT',
        message: 'The draft is the same as the live version.',
      });
    }

    // Notification P0（设计 §4）：首次发布才发 COURSE_NEW_LAUNCH；重新发布不算。
    // 事件写入失败不能影响已经提交的发布，因此不 await 主流程，只记录告警。
    if (isFirstCoursePublish(course)) {
      void this.emitCourseNewLaunch(courseId, version.id).catch((error) => {
        this.logger.warn(
          `COURSE_NEW_LAUNCH event could not be prepared: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }

    return {
      versionId: version.id,
      versionLabel: version.versionLabel,
      versionNo: version.versionNo,
    };
  }

  /**
   * 课程首次发布事件需要的课程标题/分类/深链（eventKey=course+version）。
   * 只在首次发布后异步读取，不阻塞发布；Portal 会向所有有效订阅者扇出。
   */
  private async emitCourseNewLaunch(
    courseId: string,
    versionId: string,
  ): Promise<void> {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: {
        code: true,
        slug: true,
        defaultContentLanguage: true,
        localizations: { select: { language: true, title: true } },
        category: { select: { name: true, localized: true } },
      },
    });
    if (!course) return;
    const params = courseLaunchEventParams(course);
    await notifyCourseNewLaunch({
      courseId,
      versionId,
      courseTitle: params.courseTitle,
      categoryName: params.categoryName,
      courseLink: params.courseLink,
    });
  }

  private resolveSource(course: {
    draftSourceType: string | null;
    draftSourceEnvironment: string | null;
    draftSourceVersionLabel: string | null;
  }): { environment: string | null; label: string | null } {
    if (
      course.draftSourceType === 'RESTORE' &&
      course.draftSourceVersionLabel
    ) {
      return { environment: null, label: course.draftSourceVersionLabel };
    }
    if (course.draftSourceType === 'IMPORT' && course.draftSourceVersionLabel) {
      return {
        environment: course.draftSourceEnvironment,
        label: course.draftSourceVersionLabel,
      };
    }
    if (this.config.versionNumberingMode === 'production') {
      return { environment: null, label: null };
    }
    return { environment: null, label: null };
  }

  /** Delete draft：用线上版本覆盖草稿；从未发布时不可用。 */
  async deleteDraft(courseId: string, actorEmployeeId: string | null) {
    // 锁住课程行再判断和覆盖：重复点击或与发布同时发生时按顺序执行，第二次看到没有草稿返回 409。
    return this.prisma.$transaction(
      async (tx) => {
        const [course] = await tx.$queryRaw<
          { liveVersionId: string | null; hasDraft: boolean }[]
        >`
          SELECT "liveVersionId", "hasDraft" FROM "CommerceCourse"
          WHERE id = ${courseId} FOR UPDATE`;
        if (!course)
          throw new NotFoundException({
            code: 'COURSE_NOT_FOUND',
            message: 'Course not found',
          });
        if (!course.liveVersionId || !course.hasDraft) {
          throw new ConflictException({
            code: 'NO_DRAFT',
            message: 'There is no draft to delete. Publish a version first.',
          });
        }
        const live = await tx.courseVersion.findUnique({
          where: { id: course.liveVersionId },
          select: {
            id: true,
            versionNo: true,
            versionLabel: true,
            snapshotData: true,
          },
        });
        if (!live)
          throw new NotFoundException({
            code: 'VERSION_NOT_FOUND',
            message: 'Live version not found',
          });

        await applyVersionSnapshotInTx(
          tx,
          courseId,
          live.snapshotData as unknown as VersionSnapshot,
        );
        await tx.commerceCourse.update({
          where: { id: courseId },
          data: {
            hasDraft: false,
            lifecycleStatus: 'LIVE',
            draftSourceType: null,
            draftSourceEnvironment: null,
            draftSourceVersionLabel: null,
          },
        });
        await tx.courseAuthoringActivity.create({
          data: {
            courseId,
            versionNo: live.versionNo,
            actorEmployeeId,
            action: HISTORY_ACTIONS.DELETE_DRAFT,
            detail: { keptVersion: live.versionLabel },
          },
        });
        return { deleted: true, keptVersion: live.versionLabel };
      },
      { timeout: 60_000 },
    );
  }

  /** Restore：把版本快照写入草稿，发布后才影响线上。 */
  async restore(
    courseId: string,
    versionId: string,
    actorEmployeeId: string | null,
  ) {
    const version = await this.prisma.courseVersion.findUnique({
      where: { id: versionId },
    });
    if (!version || version.courseId !== courseId) {
      throw new NotFoundException({
        code: 'VERSION_NOT_FOUND',
        message: 'Version not found',
      });
    }
    // 标记草稿、写快照、记历史在同一事务里：中途失败不会留下"有草稿但内容没恢复"的半成品。
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT id FROM "CommerceCourse" WHERE id = ${courseId} FOR UPDATE`;
        await tx.commerceCourse.update({
          where: { id: courseId },
          data: {
            hasDraft: true,
            lifecycleStatus: 'WORKING',
            draftSourceType: 'RESTORE',
            draftSourceEnvironment: null,
            draftSourceVersionLabel: version.versionLabel,
          },
        });
        await applyVersionSnapshotInTx(
          tx,
          courseId,
          version.snapshotData as unknown as VersionSnapshot,
        );
        await tx.courseAuthoringActivity.create({
          data: {
            courseId,
            versionNo: version.versionNo,
            actorEmployeeId,
            action: HISTORY_ACTIONS.RESTORE,
            detail: { restoredFrom: version.versionLabel },
          },
        });
      },
      { timeout: 60_000 },
    );
    return { restoredFrom: version.versionLabel, hasDraft: true };
  }

  /** Change status：Online / Hidden / Offline，必须填原因；不生成版本。 */
  async changeStatus(
    courseId: string,
    body: unknown,
    actorEmployeeId: string | null,
  ) {
    const { status, reason } = parseChangeStatusBody(body);
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: { id: true, liveVersionId: true, liveStatus: true },
    });
    if (!course)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });
    if (!course.liveVersionId) {
      throw new ConflictException({
        code: 'NOT_PUBLISHED',
        message: 'Publish the course first.',
      });
    }
    const from = course.liveStatus;
    await this.prisma.$transaction([
      this.prisma.commerceCourse.update({
        where: { id: courseId },
        data: { liveStatus: status },
      }),
      this.prisma.courseAuthoringActivity.create({
        data: {
          courseId,
          actorEmployeeId,
          action: HISTORY_ACTIONS.CHANGE_STATUS,
          detail: { from, to: status, reason },
          reason,
        },
      }),
    ]);
    return { from, to: status, reason };
  }

  async listVersions(courseId: string) {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: { liveVersionId: true },
    });
    if (!course)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });
    const versions = await this.prisma.courseVersion.findMany({
      where: { courseId },
      orderBy: { versionNo: 'desc' },
      select: {
        id: true,
        versionNo: true,
        versionLabel: true,
        versionSeries: true,
        versionMinor: true,
        sourceEnvironment: true,
        sourceVersionLabel: true,
        wentLiveAt: true,
        exportedAt: true,
        createdAt: true,
        createdBy: true,
      },
    });
    const names = await employeeNames(
      this.prisma,
      versions.map((version) => version.createdBy),
    );
    return versions.map((version) => ({
      ...version,
      publishedBy: operatorName(names, version.createdBy),
      isLive: version.id === course.liveVersionId,
    }));
  }

  async getVersion(courseId: string, versionId: string) {
    const version = await this.prisma.courseVersion.findUnique({
      where: { id: versionId },
      select: {
        id: true,
        courseId: true,
        versionNo: true,
        versionLabel: true,
        sourceEnvironment: true,
        sourceVersionLabel: true,
        snapshotData: true,
        wentLiveAt: true,
        exportedAt: true,
      },
    });
    if (!version || version.courseId !== courseId) {
      throw new NotFoundException({
        code: 'VERSION_NOT_FOUND',
        message: 'Version not found',
      });
    }
    return version;
  }

  /** 导出前检查：线上版本必须存在且 3 步完成（PRD §16.2）。 */
  async assertExportable(courseId: string) {
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        code: true,
        liveVersionId: true,
      },
    });
    if (!course)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });
    if (!course.liveVersionId) {
      throw new ConflictException({
        code: 'EXPORT_REQUIRES_LIVE_VERSION',
        message: 'Publish the course before exporting.',
      });
    }
    const live = await this.prisma.courseVersion.findUnique({
      where: { id: course.liveVersionId },
      select: { id: true, versionLabel: true, snapshotData: true },
    });
    if (!live)
      throw new NotFoundException({
        code: 'VERSION_NOT_FOUND',
        message: 'Live version not found',
      });
    const trial = await this.trial.get(courseId);
    const completeness = computeCompleteness(
      snapshotToCompletenessInput(
        live.snapshotData as unknown as VersionSnapshot,
        completenessTrial(trial),
        { brokenAssetIds: await loadBrokenAssetIds(this.prisma, courseId) },
      ),
    );
    if (!canExport(completeness)) {
      throw new ConflictException({
        code: 'VERSION_INCOMPLETE',
        message:
          'This version is incomplete. Complete all 3 steps, publish, then export.',
        blockers: [
          ...completeness.steps.courseInformation.missing,
          ...completeness.steps.content.missing,
          ...completeness.steps.trial.missing,
        ],
      });
    }
    return { versionId: live.id, versionLabel: live.versionLabel };
  }

  async markExported(versionId: string, actorEmployeeId: string | null) {
    const version = await this.prisma.courseVersion.update({
      where: { id: versionId },
      data: { exportedAt: new Date(), exportedBy: actorEmployeeId },
      select: { id: true, courseId: true, versionNo: true, versionLabel: true },
    });
    await this.prisma.courseAuthoringActivity.create({
      data: {
        courseId: version.courseId,
        versionNo: version.versionNo,
        actorEmployeeId,
        action: HISTORY_ACTIONS.EXPORT_PACKAGE,
        detail: { versionLabel: version.versionLabel },
      },
    });
    return version;
  }

  /** History：只读、分页（PRD §21）。 */
  async listHistory(
    courseId: string,
    query: { page?: number; pageSize?: number },
  ) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
    const where = { courseId };
    const [rows, total] = await Promise.all([
      this.prisma.courseAuthoringActivity.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.courseAuthoringActivity.count({ where }),
    ]);
    const names = await employeeNames(
      this.prisma,
      rows.map((row) => row.actorEmployeeId),
    );
    return {
      items: rows.map((row) => ({
        id: row.id.toString(),
        time: row.createdAt,
        operator: operatorName(names, row.actorEmployeeId),
        action: row.action,
        versionNo: row.versionNo,
        detail: row.detail,
      })),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  /** 写一条 History；传入事务连接时，和事务里的写入同成同败。 */
  async recordHistory(
    courseId: string | null,
    action: string,
    detail: unknown,
    actorEmployeeId: string | null,
    versionNo?: number,
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    return db.courseAuthoringActivity.create({
      data: {
        courseId,
        versionNo: versionNo ?? null,
        action,
        detail: detail ?? {},
        actorEmployeeId,
      },
    });
  }
}
