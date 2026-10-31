-- Helpdesk FAQ 的流程树与对象表（设计文档「Helpdesk 定位方式对比」第五节，owner 2026-10-31 按文档开始）：
-- - 流程树：阶段 stage → 步骤 step → 岔子 deviation；对象表：对象 object → 格子 cell（对象 × 属性）。
--   两种结构共用一张节点表，kind 区分；节点表本身是严格的树（kind 的层级固定，不可能成环）。
-- - 卡挂在哪：helpdesk_faq_placements（每张卡至多一个主位置；卡的类型由主位置决定：
--   步骤 = 操作步骤，岔子 = 故障排查，格子 = 规则说明，所以 helpdesk_faqs 不另存类型）。
-- - 每次改动一行审计日志 helpdesk_faq_map_revisions（只追加）。
-- - 发布：结构随快照冻结（helpdesk_faq_releases.snapshot.map，写入后不再改）；运行时只读快照、在内存里排序，
--   所以不另建发布用的派生表。
-- 只加不改：旧数据和旧的检索不受影响；HELPDESK_LOCATOR 缺省 flat 时这些表不参与检索。

-- ---------------------------------------------------------------------------
-- 1. 节点
-- ---------------------------------------------------------------------------

CREATE TABLE "helpdesk_faq_map_nodes" (
    "id" UUID NOT NULL,
    -- 稳定的 key。流程树：account、account.verify、account.verify.no-email；对象表在 rules. 下
    -- （rules.trial、rules.trial.timing），不会和同名的阶段撞（阶段 account 与对象 rules.account）
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "parent_id" UUID,
    -- 对象所属的阶段（学员状态的先验按阶段给，对象表里的卡也要知道自己在哪个阶段）
    "stage_id" UUID,
    -- 只有格子有：对象的哪一个属性
    "attribute" TEXT,
    "position" SMALLINT NOT NULL DEFAULT 0,
    "label_en" TEXT NOT NULL,
    "label_zh" TEXT NOT NULL,
    -- 乐观锁：UPDATE … WHERE version = $n
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_faq_map_nodes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "helpdesk_faq_map_nodes_key_check" CHECK ("key" ~ '^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*$' AND char_length("key") <= 120),
    CONSTRAINT "helpdesk_faq_map_nodes_rules_check" CHECK (("kind" IN ('object', 'cell')) = ("key" LIKE 'rules.%')),
    CONSTRAINT "helpdesk_faq_map_nodes_kind_check" CHECK ("kind" IN ('stage', 'step', 'deviation', 'object', 'cell')),
    CONSTRAINT "helpdesk_faq_map_nodes_root_check" CHECK (("kind" IN ('stage', 'object')) = ("parent_id" IS NULL)),
    CONSTRAINT "helpdesk_faq_map_nodes_stage_check" CHECK (("kind" = 'object') = ("stage_id" IS NOT NULL)),
    CONSTRAINT "helpdesk_faq_map_nodes_attribute_check" CHECK (
        ("kind" = 'cell') = ("attribute" IS NOT NULL)
        AND ("attribute" IS NULL OR "attribute" IN ('definition', 'price', 'timing', 'limit', 'eligibility', 'visibility', 'consequence'))
    ),
    CONSTRAINT "helpdesk_faq_map_nodes_position_check" CHECK ("position" >= 0),
    CONSTRAINT "helpdesk_faq_map_nodes_label_en_check" CHECK (char_length("label_en") BETWEEN 1 AND 200),
    CONSTRAINT "helpdesk_faq_map_nodes_label_zh_check" CHECK (char_length("label_zh") BETWEEN 1 AND 200),
    CONSTRAINT "helpdesk_faq_map_nodes_version_check" CHECK ("version" >= 1)
);

CREATE UNIQUE INDEX "helpdesk_faq_map_nodes_key_key" ON "helpdesk_faq_map_nodes"("key");
CREATE INDEX "helpdesk_faq_map_nodes_parent_idx" ON "helpdesk_faq_map_nodes"("parent_id", "position");
-- 一个对象的每个属性只有一个格子
CREATE UNIQUE INDEX "helpdesk_faq_map_nodes_cell_key" ON "helpdesk_faq_map_nodes"("parent_id", "attribute") WHERE "kind" = 'cell';

ALTER TABLE "helpdesk_faq_map_nodes" ADD CONSTRAINT "helpdesk_faq_map_nodes_parent_fkey"
    FOREIGN KEY ("parent_id") REFERENCES "helpdesk_faq_map_nodes"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "helpdesk_faq_map_nodes" ADD CONSTRAINT "helpdesk_faq_map_nodes_stage_fkey"
    FOREIGN KEY ("stage_id") REFERENCES "helpdesk_faq_map_nodes"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- 层级固定：step 的父是 stage，deviation 的父是 step，cell 的父是 object；对象的 stage_id 指向 stage。
-- 父节点的 kind 也不许改成别的（否则子节点的层级会失效）。
CREATE OR REPLACE FUNCTION helpdesk_faq_map_nodes_shape()
RETURNS TRIGGER AS $$
DECLARE
  parent_kind TEXT;
  wanted_kind TEXT;
  stage_kind TEXT;
BEGIN
  IF NEW."parent_id" IS NOT NULL THEN
    SELECT "kind" INTO parent_kind FROM "helpdesk_faq_map_nodes" WHERE "id" = NEW."parent_id";
    wanted_kind := CASE NEW."kind" WHEN 'step' THEN 'stage' WHEN 'deviation' THEN 'step' WHEN 'cell' THEN 'object' END;
    IF parent_kind IS DISTINCT FROM wanted_kind THEN
      RAISE EXCEPTION 'helpdesk_faq_map_nodes: a % cannot hang under a %', NEW."kind", COALESCE(parent_kind, 'missing node');
    END IF;
  END IF;
  IF NEW."stage_id" IS NOT NULL THEN
    SELECT "kind" INTO stage_kind FROM "helpdesk_faq_map_nodes" WHERE "id" = NEW."stage_id";
    IF stage_kind IS DISTINCT FROM 'stage' THEN
      RAISE EXCEPTION 'helpdesk_faq_map_nodes: an object belongs to a stage, not to a %', COALESCE(stage_kind, 'missing node');
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."kind" <> OLD."kind" AND EXISTS (
    SELECT 1 FROM "helpdesk_faq_map_nodes" WHERE "parent_id" = NEW."id" OR "stage_id" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'helpdesk_faq_map_nodes: % has children, its kind cannot change', NEW."key";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "helpdesk_faq_map_nodes_shape"
    BEFORE INSERT OR UPDATE ON "helpdesk_faq_map_nodes"
    FOR EACH ROW EXECUTE FUNCTION helpdesk_faq_map_nodes_shape();

-- ---------------------------------------------------------------------------
-- 2. 卡挂在哪与审计日志
-- ---------------------------------------------------------------------------

CREATE TABLE "helpdesk_faq_placements" (
    "id" UUID NOT NULL,
    "faq_id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_faq_placements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "helpdesk_faq_placements_faq_node_key" ON "helpdesk_faq_placements"("faq_id", "node_id");
-- 每张卡至多一个主位置（「恰好一个」由发布检查保证：编辑途中允许暂时没有）
CREATE UNIQUE INDEX "helpdesk_faq_placements_one_primary" ON "helpdesk_faq_placements"("faq_id") WHERE "is_primary";
CREATE INDEX "helpdesk_faq_placements_node_idx" ON "helpdesk_faq_placements"("node_id");

ALTER TABLE "helpdesk_faq_placements" ADD CONSTRAINT "helpdesk_faq_placements_faq_fkey"
    FOREIGN KEY ("faq_id") REFERENCES "helpdesk_faqs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "helpdesk_faq_placements" ADD CONSTRAINT "helpdesk_faq_placements_node_fkey"
    FOREIGN KEY ("node_id") REFERENCES "helpdesk_faq_map_nodes"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- 卡只挂在步骤、岔子或格子上（阶段和对象是分组，不挂卡）
CREATE OR REPLACE FUNCTION helpdesk_faq_placements_node_kind()
RETURNS TRIGGER AS $$
DECLARE
  node_kind TEXT;
BEGIN
  SELECT "kind" INTO node_kind FROM "helpdesk_faq_map_nodes" WHERE "id" = NEW."node_id";
  IF node_kind IS NULL OR node_kind NOT IN ('step', 'deviation', 'cell') THEN
    RAISE EXCEPTION 'helpdesk_faq_placements: a card hangs on a step, a deviation or a cell, not on a %', COALESCE(node_kind, 'missing node');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "helpdesk_faq_placements_node_kind"
    BEFORE INSERT OR UPDATE ON "helpdesk_faq_placements"
    FOR EACH ROW EXECUTE FUNCTION helpdesk_faq_placements_node_kind();

-- 审计日志：每次建 / 改 / 删节点或挂载一行（谁、何时、改前 / 改后），与改动同一事务；只追加
CREATE TABLE "helpdesk_faq_map_revisions" (
    "id" UUID NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "employee_id" UUID,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_faq_map_revisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "helpdesk_faq_map_revisions_entity_check" CHECK ("entity" IN ('node', 'placement')),
    CONSTRAINT "helpdesk_faq_map_revisions_action_check" CHECK ("action" IN ('create', 'update', 'delete'))
);

CREATE INDEX "helpdesk_faq_map_revisions_entity_idx" ON "helpdesk_faq_map_revisions"("entity", "entity_id", "at");

CREATE TRIGGER "helpdesk_faq_map_revisions_append_only"
    BEFORE UPDATE OR DELETE ON "helpdesk_faq_map_revisions"
    FOR EACH ROW EXECUTE FUNCTION helpdesk_faq_append_only();
