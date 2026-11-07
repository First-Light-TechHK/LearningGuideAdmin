-- 发布前的检查改成后台任务（owner 2026-11-03 选「抽样跑测试集」）：一次检查 = 一个 run。
-- 新建版本立刻返回（status = evaluating），检查在后台跑，按 eval_heartbeat_at 报心跳与进度；
-- 心跳停了（进程重启、部署中断）→ 界面显示「检查中断」，可以重新检查（新的 run id 接手，旧的写不进来）。
ALTER TABLE "helpdesk_faq_releases"
    ADD COLUMN "eval_run_id" UUID,
    ADD COLUMN "eval_started_at" TIMESTAMPTZ(6),
    ADD COLUMN "eval_heartbeat_at" TIMESTAMPTZ(6),
    -- { stage: retrieval | vectors | model, done, total }
    ADD COLUMN "eval_progress" JSONB;
