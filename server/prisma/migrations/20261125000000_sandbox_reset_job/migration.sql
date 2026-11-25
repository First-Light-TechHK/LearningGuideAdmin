-- Sandbox 课程内容重置作业（Sandbox 专项）。
-- 只在 APP_ENV=SANDBOX 且 SANDBOX_RESET_ENABLED=true 时由服务层创建；
-- 单活由部分唯一索引兜底（同时最多一条 QUEUED 或 RUNNING），数据库层面拒绝并发重置。
-- 见 docs/sandbox/partitioning.md §4、server/src/commerce-courses/sandbox-reset.service.ts。

CREATE TABLE "SandboxResetJob" (
  "id"          TEXT          NOT NULL,
  "status"      TEXT          NOT NULL,
  "stage"       TEXT,
  "progress"    INTEGER       NOT NULL DEFAULT 0,
  "scope"       JSONB         NOT NULL,
  "requestedBy" UUID,
  "reason"      TEXT          NOT NULL,
  "counts"      JSONB,
  "report"      JSONB,
  "error"       TEXT,
  "heartbeatAt" TIMESTAMP(3),
  "startedAt"   TIMESTAMP(3),
  "finishedAt"  TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3)  NOT NULL,

  CONSTRAINT "SandboxResetJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SandboxResetJob_status_createdAt_idx"
  ON "SandboxResetJob" ("status", "createdAt");

-- 单活：常量表达式上的部分唯一索引 = 该集合里最多一行。
-- 用 Prisma schema 表达不了部分索引，因此只在这里创建；schema.prisma 里保留普通索引。
CREATE UNIQUE INDEX "SandboxResetJob_single_active_key"
  ON "SandboxResetJob" ((1))
  WHERE "status" IN ('QUEUED', 'RUNNING');

COMMENT ON TABLE "SandboxResetJob" IS
  'Sandbox 课程内容重置作业：仅在 Sandbox 环境可用，删除课程域并保留员工/设置/分类/知识库';
