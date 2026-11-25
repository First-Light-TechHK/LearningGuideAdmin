import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { appEnvName } from '../backoffice/lib/env';
import { tryRecordAuditEvent } from '../backoffice/repositories/auditRepository';
import { PrismaService } from '../prisma/prisma.service';
import { COMMERCE_CONFIG, type CommerceCourseConfig } from './commerce.config';
import { CourseStorageService } from './storage.service';

/** 确认短语：必须完全匹配（大小写、空格）。 */
export const SANDBOX_RESET_CONFIRM = 'RESET SANDBOX';

export interface SandboxResetScope {
  courses: boolean;
  media: boolean;
  staging: boolean;
  packageJobs: boolean;
  resetCodeCounters: boolean;
}

export const DEFAULT_SANDBOX_RESET_SCOPE: SandboxResetScope = {
  courses: true,
  media: true,
  staging: true,
  packageJobs: true,
  resetCodeCounters: true,
};

export interface SandboxResetImpact {
  courses: number;
  versions: number;
  mediaAssets: number;
  mediaBytes: number;
  packageJobs: number;
}

/** 重置前后的悬空引用计数（指针还在、目标行不在）。 */
export interface SandboxDanglingReferences {
  liveVersionIds: number;
  planCourseIds: number;
  popularCourseIds: number;
  bannerCourseIds: number;
}

export type SandboxResetJobView = {
  jobId: string;
  status: string;
  stage: string | null;
  progress: number;
  scope: SandboxResetScope;
  reason: string;
  requestedBy: string | null;
  counts: unknown;
  report: unknown;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
};

/** 稳定错误码（结构与 PackageError 一致，由全局过滤器输出 {code,message}）。 */
export class SandboxResetError extends HttpException {
  constructor(
    readonly code: string,
    status: number,
    message: string,
  ) {
    super({ code, message }, status);
  }
}

/** 规范化 scope：缺省 = 全部 true；未知键忽略；非布尔值按缺省 true。 */
export function normalizeSandboxResetScope(input: unknown): SandboxResetScope {
  const raw =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const pick = (key: keyof SandboxResetScope): boolean =>
    typeof raw[key] === 'boolean' ? raw[key] : true;
  return {
    courses: pick('courses'),
    media: pick('media'),
    staging: pick('staging'),
    packageJobs: pick('packageJobs'),
    resetCodeCounters: pick('resetCodeCounters'),
  };
}

export function sandboxResetScopeIsEmpty(scope: SandboxResetScope): boolean {
  return !Object.values(scope).some(Boolean);
}

/** 课程包作业里「仍在进行」的状态：这些存在时不允许开始重置。 */
const ACTIVE_PACKAGE_JOB_STATUSES = [
  'UPLOADING',
  'VALIDATING',
  'AWAITING_CONFIRM',
  'IMPORTING',
  'EXPORTING',
];

type ResetJobRow = {
  id: string;
  status: string;
  stage: string | null;
  progress: number;
  scope: Prisma.JsonValue;
  requestedBy: string | null;
  reason: string;
  counts: Prisma.JsonValue | null;
  report: Prisma.JsonValue | null;
  error: string | null;
  heartbeatAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Sandbox 课程内容重置 / 全量重发（docs/sandbox/partitioning.md §4）。
 *
 * 三层守卫（缺一不可）：
 * 1. 配置层：SANDBOX_RESET_ENABLED=true（默认关）；
 * 2. 运行标识层：APP_ENV 必须显式等于 SANDBOX —— 这是破坏性运维动作的环境断言，
 *    不是产品行为分支；只在服务端 fail-closed，不对任何页面/功能做环境分支；
 * 3. RBAC 层：路由登记为 employeeAdmin（仅 ADMIN），见 backoffice/nest/route-access.ts。
 *
 * 其余约束：confirm 短语 + reason 必填；没有进行中的导入/导出作业；同时最多一条
 * QUEUED/RUNNING 作业（迁移里的部分唯一索引兜底）。
 */
@Injectable()
export class SandboxResetService {
  private readonly logger = new Logger(SandboxResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: CourseStorageService,
    @Inject(COMMERCE_CONFIG) private readonly config: CommerceCourseConfig,
  ) {}

  /** 配置开关 + 环境断言都满足时才可用。 */
  isAvailable(): boolean {
    return (
      this.config.sandboxResetEnabled === true && appEnvName() === 'SANDBOX'
    );
  }

  assertAvailable(): void {
    if (!this.isAvailable()) {
      throw new SandboxResetError(
        'SANDBOX_RESET_DISABLED',
        403,
        'Sandbox reset is not enabled in this environment.',
      );
    }
  }

  /** GET /api/backoffice/sandbox/reset：当前开关、活动作业与影响面。 */
  async state(): Promise<{
    enabled: boolean;
    environment: string;
    activeJob: SandboxResetJobView | null;
    impact: SandboxResetImpact;
  }> {
    this.assertAvailable();
    const active = await this.prisma.sandboxResetJob.findFirst({
      where: { status: { in: ['QUEUED', 'RUNNING'] } },
      orderBy: { createdAt: 'desc' },
    });
    return {
      enabled: true,
      environment: appEnvName(),
      activeJob: active ? this.toView(active) : null,
      impact: await this.impact(),
    };
  }

  async impact(): Promise<SandboxResetImpact> {
    const [courses, versions, mediaAssets, packageJobs, mediaSum] =
      await Promise.all([
        this.prisma.commerceCourse.count(),
        this.prisma.courseVersion.count(),
        this.prisma.courseMediaAsset.count(),
        this.prisma.coursePackageJob.count(),
        this.prisma.courseMediaAsset.aggregate({ _sum: { size: true } }),
      ]);
    return {
      courses,
      versions,
      mediaAssets,
      mediaBytes: mediaSum._sum.size ?? 0,
      packageJobs,
    };
  }

  /** POST /api/backoffice/sandbox/reset：创建作业（202）。 */
  async create(
    input: { confirm?: unknown; reason?: unknown; scope?: unknown },
    actorEmployeeId: string | null,
    ipAddress: string | null,
  ): Promise<SandboxResetJobView> {
    this.assertAvailable();
    const confirm =
      typeof input.confirm === 'string' ? input.confirm.trim() : '';
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (confirm !== SANDBOX_RESET_CONFIRM || reason === '') {
      throw new SandboxResetError(
        'RESET_CONFIRMATION_REQUIRED',
        409,
        `Type "${SANDBOX_RESET_CONFIRM}" and give a reason to reset the sandbox.`,
      );
    }
    const scope = normalizeSandboxResetScope(input.scope);
    if (sandboxResetScopeIsEmpty(scope)) {
      throw new SandboxResetError(
        'RESET_SCOPE_EMPTY',
        422,
        'Select at least one thing to reset.',
      );
    }

    const activePackageJobs = await this.prisma.coursePackageJob.count({
      where: { status: { in: ACTIVE_PACKAGE_JOB_STATUSES as never[] } },
    });
    if (activePackageJobs > 0) {
      throw new SandboxResetError(
        'RESET_BUSY',
        409,
        'Import or export jobs are still active. Wait for them to finish or cancel them first.',
      );
    }
    const activeResets = await this.prisma.sandboxResetJob.count({
      where: { status: { in: ['QUEUED', 'RUNNING'] } },
    });
    if (activeResets > 0) {
      throw new SandboxResetError(
        'RESET_BUSY',
        409,
        'A sandbox reset job is already queued or running.',
      );
    }

    const counts = await this.impact();
    let job: ResetJobRow;
    try {
      job = await this.prisma.sandboxResetJob.create({
        data: {
          status: 'QUEUED',
          scope: scope as unknown as Prisma.InputJsonValue,
          requestedBy: actorEmployeeId,
          reason,
          counts: counts as unknown as Prisma.InputJsonValue,
          progress: 0,
        },
      });
    } catch (error) {
      // 并发创建：部分唯一索引拒绝第二条 QUEUED/RUNNING。
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new SandboxResetError(
          'RESET_BUSY',
          409,
          'A sandbox reset job is already queued or running.',
        );
      }
      throw error;
    }

    await tryRecordAuditEvent({
      eventName: 'SANDBOX_RESET_REQUESTED',
      actorEmployeeId,
      targetEmployeeId: null,
      action: 'SANDBOX_RESET',
      newValue: JSON.stringify({
        jobId: job.id,
        reason,
        scope,
        counts,
      }),
      result: 'SUCCESS',
      ipAddress,
    });
    return this.toView(job);
  }

  async getJob(jobId: string): Promise<SandboxResetJobView> {
    this.assertAvailable();
    const job = await this.prisma.sandboxResetJob.findUnique({
      where: { id: jobId },
    });
    if (!job) {
      throw new SandboxResetError('RESET_JOB_NOT_FOUND', 404, 'Job not found.');
    }
    return this.toView(job);
  }

  async cancel(jobId: string): Promise<SandboxResetJobView> {
    this.assertAvailable();
    const existing = await this.prisma.sandboxResetJob.findUnique({
      where: { id: jobId },
      select: { id: true },
    });
    if (!existing) {
      throw new SandboxResetError('RESET_JOB_NOT_FOUND', 404, 'Job not found.');
    }
    const updated = await this.prisma.sandboxResetJob.updateMany({
      where: { id: jobId, status: 'QUEUED' },
      data: { status: 'CANCELLED', finishedAt: new Date(), progress: 100 },
    });
    if (updated.count === 0) {
      throw new SandboxResetError(
        'RESET_JOB_NOT_CANCELLABLE',
        409,
        'Only a queued reset job can be cancelled.',
      );
    }
    return this.getJob(jobId);
  }

  // ===== Worker 支撑 =====

  /** 把心跳过期的 RUNNING 作业放回队列（多实例安全）。 */
  async reclaimStale(): Promise<void> {
    if (!this.isAvailable()) return;
    const staleBefore = new Date(Date.now() - this.config.jobStaleMs);
    await this.prisma.sandboxResetJob.updateMany({
      where: {
        status: 'RUNNING',
        OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: staleBefore } }],
      },
      data: { status: 'QUEUED', startedAt: null, heartbeatAt: null },
    });
  }

  /** 领取一条 QUEUED 作业；没有则 null。 */
  async claimNext(): Promise<string | null> {
    if (!this.isAvailable()) return null;
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "SandboxResetJob"
      SET "status" = 'RUNNING', "startedAt" = now(), "heartbeatAt" = now(),
          "updatedAt" = now()
      WHERE "id" = (
        SELECT "id" FROM "SandboxResetJob"
        WHERE "status" = 'QUEUED'
        ORDER BY "createdAt"
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING "id";
    `;
    return rows[0]?.id ?? null;
  }

  /** 执行一条已领取（RUNNING）的作业；逐阶段更新进度，失败可重试。 */
  async execute(jobId: string): Promise<void> {
    const job = await this.prisma.sandboxResetJob.findUnique({
      where: { id: jobId },
    });
    if (!job || job.status !== 'RUNNING') return;
    const scope = normalizeSandboxResetScope(job.scope);
    const report: Record<string, unknown> = {};

    try {
      // 1. PRECHECK：再次确认环境与开关（防止运行中途配置被改）。
      this.assertAvailable();
      await this.progress(jobId, 'PRECHECK', 5);
      // 重置前先记录悬空引用（例如历史清理留下的 liveVersionId 悬空），
      // 便于在报告里区分“原本就有”与“重置造成”。
      report.integrityBefore = await this.danglingReferences();

      // 2. JOBS：先取消排队中的作业，再删除全部作业行。
      if (scope.packageJobs) {
        await this.progress(jobId, 'JOBS', 20);
        report.packageJobs = await this.clearPackageJobs();
      }

      // 3. STAGING：清空课程包暂存根（Sandbox 专用桶/目录）。
      if (scope.staging) {
        await this.progress(jobId, 'STAGING', 35);
        await this.storage.clearStagingRoot();
        report.staging = 'cleared';
      }

      // 4. MEDIA：先删对象，再删 DB（对象失败则 DB 不动，便于重试修复）。
      if (scope.media) {
        await this.progress(jobId, 'MEDIA', 55);
        report.mediaObjects = await this.clearMediaObjects();
      }

      // 5. DATABASE：单事务删除课程域；保留员工/设置/分类/知识库/审计。
      if (scope.courses || scope.resetCodeCounters) {
        await this.progress(jobId, 'DATABASE', 75);
        report.database = await this.clearDatabase(scope);
      }

      // 6. VERIFY：复核课程数为 0（并发写入最多再删 3 轮）。
      await this.progress(jobId, 'VERIFY', 90);
      report.verify = await this.verify(scope);

      await this.finish(jobId, 'SUCCEEDED', report, null);
      await this.auditCompleted(job, scope, report);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Sandbox reset failed';
      this.logger.error(
        `Sandbox reset job ${jobId} failed: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.finish(jobId, 'FAILED', report, message);
      await tryRecordAuditEvent({
        eventName: 'SANDBOX_RESET_FAILED',
        actorEmployeeId: job.requestedBy,
        targetEmployeeId: null,
        action: 'SANDBOX_RESET',
        newValue: JSON.stringify({ jobId, scope, report, error: message }),
        result: 'FAILURE',
      });
    }
  }

  // ===== 各阶段实现 =====

  private async clearPackageJobs(): Promise<number> {
    const deleted = await this.prisma.coursePackageJob.deleteMany({});
    return deleted.count;
  }

  private async clearMediaObjects(): Promise<number> {
    const assets = await this.prisma.courseMediaAsset.findMany({
      select: { storageKey: true },
    });
    let removed = 0;
    for (const asset of assets) {
      try {
        await this.storage.removeMedia(asset.storageKey);
        removed += 1;
      } catch (error) {
        throw new Error(
          `Failed to remove media object ${asset.storageKey}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return removed;
  }

  private async clearDatabase(
    scope: SandboxResetScope,
  ): Promise<Record<string, number>> {
    return this.prisma.$transaction(async (tx) => {
      const result: Record<string, number> = {};
      if (scope.courses) {
        // 运营位指向课程：先删/清空，避免指向已删除课程。
        result.popularEntries = (
          await tx.popularCourseEntry.deleteMany({})
        ).count;
        result.bannersCleared = (
          await tx.discoveryBanner.updateMany({
            data: { courseId: null, enabled: false },
          })
        ).count;
        // 课程级价格随课程消失；分类/全部套餐（courseId 为空）保留。
        result.coursePlans = (
          await tx.coursePlan.deleteMany({
            where: { courseId: { not: null } },
          })
        ).count;
        // 课程级联删除：localizations/lessons/exhibits/learning points/triggers/
        // readings/questions/application tests/trial/media rows/versions/authors。
        result.courses = (await tx.commerceCourse.deleteMany({})).count;
      }
      if (scope.resetCodeCounters) {
        // 编号计数器清空后，下一轮从 C001 / 1.1 重新开始（全量重发语义）。
        result.codeCounters = (await tx.courseCodeCounter.deleteMany({})).count;
      }
      return result;
    });
  }

  private async verify(scope: SandboxResetScope): Promise<{
    courses: number;
    leftover: number;
    attempts: number;
    dangling: SandboxDanglingReferences;
  }> {
    if (!scope.courses) {
      return {
        courses: await this.prisma.commerceCourse.count(),
        leftover: 0,
        attempts: 0,
        dangling: await this.danglingReferences(),
      };
    }
    let attempts = 0;
    let remaining = await this.prisma.commerceCourse.count();
    while (remaining > 0 && attempts < 3) {
      await this.prisma.commerceCourse.deleteMany({});
      attempts += 1;
      remaining = await this.prisma.commerceCourse.count();
    }
    // 重置后课程域必须干净：任何“指针还在、目标行不在”的残留都说明
    // 清理不完整（或并发写入），按失败处理，避免再次出现悬空 liveVersionId。
    const dangling = await this.danglingReferences();
    const danglingTotal = Object.values(dangling).reduce(
      (sum, count) => sum + count,
      0,
    );
    if (danglingTotal > 0) {
      throw new SandboxResetError(
        'SANDBOX_RESET_INTEGRITY_FAILED',
        500,
        `Reset left ${danglingTotal} dangling reference(s): ${JSON.stringify(dangling)}`,
      );
    }
    return { courses: remaining, leftover: remaining, attempts, dangling };
  }

  /**
   * 悬空引用检查：课程/版本/运营位等指针指向不存在的行。
   * 典型来源：直接删版本行或课程行，却没有同步 liveVersionId / 关联行。
   */
  private async danglingReferences(): Promise<SandboxDanglingReferences> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        liveVersionIds: bigint | number;
        planCourseIds: bigint | number;
        popularCourseIds: bigint | number;
        bannerCourseIds: bigint | number;
      }>
    >`
      SELECT
        (SELECT count(*) FROM "CommerceCourse" c
           LEFT JOIN "CourseVersion" v ON v.id = c."liveVersionId"
          WHERE c."liveVersionId" IS NOT NULL AND v.id IS NULL) AS "liveVersionIds",
        (SELECT count(*) FROM "CoursePlan" p
           LEFT JOIN "CommerceCourse" c ON c.id = p."courseId"
          WHERE p."courseId" IS NOT NULL AND c.id IS NULL) AS "planCourseIds",
        (SELECT count(*) FROM "PopularCourseEntry" e
           LEFT JOIN "CommerceCourse" c ON c.id = e."courseId"
          WHERE c.id IS NULL) AS "popularCourseIds",
        (SELECT count(*) FROM "DiscoveryBanner" b
           LEFT JOIN "CommerceCourse" c ON c.id = b."courseId"
          WHERE b."courseId" IS NOT NULL AND c.id IS NULL) AS "bannerCourseIds"
    `;
    const row = rows[0];
    return {
      liveVersionIds: Number(row?.liveVersionIds ?? 0),
      planCourseIds: Number(row?.planCourseIds ?? 0),
      popularCourseIds: Number(row?.popularCourseIds ?? 0),
      bannerCourseIds: Number(row?.bannerCourseIds ?? 0),
    };
  }

  private async progress(
    jobId: string,
    stage: string,
    progress: number,
  ): Promise<void> {
    await this.prisma.sandboxResetJob.update({
      where: { id: jobId },
      data: { stage, progress, heartbeatAt: new Date() },
    });
  }

  private async finish(
    jobId: string,
    status: 'SUCCEEDED' | 'FAILED',
    report: Record<string, unknown>,
    error: string | null,
  ): Promise<void> {
    await this.prisma.sandboxResetJob.update({
      where: { id: jobId },
      data: {
        status,
        stage: status === 'SUCCEEDED' ? 'DONE' : 'FAILED',
        progress: 100,
        report: report as unknown as Prisma.InputJsonValue,
        error,
        finishedAt: new Date(),
        heartbeatAt: new Date(),
      },
    });
  }

  private async auditCompleted(
    job: ResetJobRow,
    scope: SandboxResetScope,
    report: Record<string, unknown>,
  ): Promise<void> {
    await tryRecordAuditEvent({
      eventName: 'SANDBOX_RESET_COMPLETED',
      actorEmployeeId: job.requestedBy,
      targetEmployeeId: null,
      action: 'SANDBOX_RESET',
      newValue: JSON.stringify({
        jobId: job.id,
        scope,
        counts: job.counts,
        report,
      }),
      result: 'SUCCESS',
    });
  }

  private toView(job: ResetJobRow): SandboxResetJobView {
    return {
      jobId: job.id,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      scope: normalizeSandboxResetScope(job.scope),
      reason: job.reason,
      requestedBy: job.requestedBy,
      counts: job.counts,
      report: job.report,
      error: job.error,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    };
  }
}
