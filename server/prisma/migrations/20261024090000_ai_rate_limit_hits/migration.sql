-- AI 限流计数（2026-10-24）：从进程内存搬到数据库，多个 Agent 实例共用一份计数。
-- 只加表，不动已有数据；回滚到上一版代码时这张表被忽略即可。

-- CreateTable
CREATE TABLE "ai_rate_limit_hits" (
    "id" BIGSERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "hit_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_rate_limit_hits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_rate_limit_hits_key_hit_at_idx" ON "ai_rate_limit_hits"("key", "hit_at");
