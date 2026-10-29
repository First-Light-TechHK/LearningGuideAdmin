-- Helpdesk v5 FAQ 问题树（helpdesk-v5-faq-graph-design §2，2026-10-30）：
-- - helpdesk_faqs 加 key（稳定的 slug，改文字也不变；旧行按英文问题确定地回填）、node_type（answer | choice）、
--   entry（能否被新问题直接命中），以及检索用的问法汇总 phrasing_text / phrasing_tsv（由触发器维护）；
-- - 新表：边 helpdesk_faq_edges（DAG：follow_up 追问 / option 选项）、边的修订（只追加）、问法 helpdesk_faq_phrasings、
--   发布版本 helpdesk_faq_releases（快照写入后不再改，至多一行 published）与发布版本的检索行
--   helpdesk_faq_release_nodes（从快照派生，与快照同一事务写入，只追加）。
-- BackOffice 是唯一写入方。只加不改：已应用的迁移一个字不动；旧的 Admin / Portal 不受影响
-- （没有任何发布版本之前，运行时照旧读逐条发布的 FAQ）。

-- ---------------------------------------------------------------------------
-- 1. helpdesk_faqs 的新列
-- ---------------------------------------------------------------------------

-- 英文问题 → slug：小写，去掉撇号，非 [a-z0-9] 的连续字符换成一个 -，去掉首尾 -，至多 60 个字符；
-- 空了就是 faq。与 faqKeys.ts faqKeySlug 完全同一规则（helpdesk-faq-graph.pg.spec.ts 用语料锁定）。
CREATE OR REPLACE FUNCTION helpdesk_faq_slug(question TEXT)
RETURNS TEXT AS $$
  SELECT COALESCE(
    NULLIF(
      btrim(left(btrim(regexp_replace(regexp_replace(lower(question), '[''’]', '', 'g'),
                                      '[^a-z0-9]+', '-', 'g'), '-'), 60), '-'),
      ''),
    'faq')
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

-- 第一个还没被占用的 key：base、base-2、base-3……（按调用先后，确定）
CREATE OR REPLACE FUNCTION helpdesk_faq_free_key(base TEXT)
RETURNS TEXT AS $$
DECLARE
  candidate TEXT := base;
  n INTEGER := 1;
BEGIN
  WHILE EXISTS (SELECT 1 FROM helpdesk_faqs WHERE "key" = candidate) LOOP
    n := n + 1;
    candidate := base || '-' || n;
  END LOOP;
  RETURN candidate;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE "helpdesk_faqs" ADD COLUMN "key" TEXT;
ALTER TABLE "helpdesk_faqs" ADD COLUMN "node_type" TEXT NOT NULL DEFAULT 'answer';
ALTER TABLE "helpdesk_faqs" ADD COLUMN "entry" BOOLEAN NOT NULL DEFAULT true;
-- 这条 FAQ 所有问法的检索文字（原文小写 + 简体 / 普通话改写，换行连接）；由 helpdesk_faq_phrasings 的触发器维护
ALTER TABLE "helpdesk_faqs" ADD COLUMN "phrasing_text" TEXT NOT NULL DEFAULT '';
ALTER TABLE "helpdesk_faqs" ADD COLUMN "phrasing_tsv" TSVECTOR
    GENERATED ALWAYS AS (to_tsvector('english', "phrasing_text")) STORED;

-- 回填：按创建先后（再按 id）逐行取第一个空闲的 slug，结果确定；不动 updated_at（Portal 的 ETag 不变）
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT id, question_en FROM helpdesk_faqs ORDER BY created_at, id LOOP
    UPDATE helpdesk_faqs SET "key" = helpdesk_faq_free_key(helpdesk_faq_slug(r.question_en))
     WHERE id = r.id;
  END LOOP;
END;
$$;

ALTER TABLE "helpdesk_faqs" ALTER COLUMN "key" SET NOT NULL;
CREATE UNIQUE INDEX "helpdesk_faqs_key_key" ON "helpdesk_faqs"("key");
ALTER TABLE "helpdesk_faqs" ADD CONSTRAINT "helpdesk_faqs_key_check"
    CHECK ("key" ~ '^[a-z0-9][a-z0-9._-]{0,79}$');
ALTER TABLE "helpdesk_faqs" ADD CONSTRAINT "helpdesk_faqs_node_type_check"
    CHECK ("node_type" IN ('answer', 'choice'));

-- 不带 key 的新行（旧代码、评测与测试里的原生 INSERT）：按英文问题取第一个空闲的 slug
CREATE OR REPLACE FUNCTION helpdesk_faqs_fill_key()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."key" IS NULL THEN
    NEW."key" := helpdesk_faq_free_key(helpdesk_faq_slug(NEW.question_en));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "helpdesk_faqs_fill_key"
    BEFORE INSERT ON "helpdesk_faqs"
    FOR EACH ROW EXECUTE FUNCTION helpdesk_faqs_fill_key();

-- ---------------------------------------------------------------------------
-- 2. 边（DAG）与边的修订
-- ---------------------------------------------------------------------------

CREATE TABLE "helpdesk_faq_edges" (
    "id" UUID NOT NULL,
    "parent_id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    -- 同一父节点下的顺序（发布时按 position、创建时间、id 重新编号为 0..n-1）
    "position" SMALLINT NOT NULL DEFAULT 0,
    -- chip / 按钮文字；NULL = 用子节点的问题
    "label_en" TEXT,
    "label_zh" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_faq_edges_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "helpdesk_faq_edges_kind_check" CHECK ("kind" IN ('follow_up', 'option')),
    CONSTRAINT "helpdesk_faq_edges_position_check" CHECK ("position" >= 0),
    CONSTRAINT "helpdesk_faq_edges_self_check" CHECK ("parent_id" <> "child_id"),
    CONSTRAINT "helpdesk_faq_edges_label_en_check"
        CHECK ("label_en" IS NULL OR char_length("label_en") BETWEEN 1 AND 200),
    CONSTRAINT "helpdesk_faq_edges_label_zh_check"
        CHECK ("label_zh" IS NULL OR char_length("label_zh") BETWEEN 1 AND 200)
);

CREATE UNIQUE INDEX "helpdesk_faq_edges_parent_child_key" ON "helpdesk_faq_edges"("parent_id", "child_id");
CREATE INDEX "helpdesk_faq_edges_parent_position_idx" ON "helpdesk_faq_edges"("parent_id", "position");
CREATE INDEX "helpdesk_faq_edges_child_idx" ON "helpdesk_faq_edges"("child_id");

ALTER TABLE "helpdesk_faq_edges" ADD CONSTRAINT "helpdesk_faq_edges_parent_id_fkey"
    FOREIGN KEY ("parent_id") REFERENCES "helpdesk_faqs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "helpdesk_faq_edges" ADD CONSTRAINT "helpdesk_faq_edges_child_id_fkey"
    FOREIGN KEY ("child_id") REFERENCES "helpdesk_faqs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- 每次建 / 改 / 删边一行（谁、何时、改前 / 改后），与改动同一事务；只追加
CREATE TABLE "helpdesk_faq_edge_revisions" (
    "id" UUID NOT NULL,
    "edge_id" UUID NOT NULL,
    "parent_id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "employee_id" UUID,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_faq_edge_revisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "helpdesk_faq_edge_revisions_action_check" CHECK ("action" IN ('create', 'update', 'delete'))
);

CREATE INDEX "helpdesk_faq_edge_revisions_edge_idx" ON "helpdesk_faq_edge_revisions"("edge_id", "at");
CREATE INDEX "helpdesk_faq_edge_revisions_parent_idx" ON "helpdesk_faq_edge_revisions"("parent_id", "at");

CREATE OR REPLACE FUNCTION helpdesk_faq_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "helpdesk_faq_edge_revisions_append_only"
    BEFORE UPDATE OR DELETE ON "helpdesk_faq_edge_revisions"
    FOR EACH ROW EXECUTE FUNCTION helpdesk_faq_append_only();

-- ---------------------------------------------------------------------------
-- 3. 问法（学员实际怎么问；检索用，不改答案）
-- ---------------------------------------------------------------------------

CREATE TABLE "helpdesk_faq_phrasings" (
    "id" UUID NOT NULL,
    "faq_id" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    -- 检索文字：原文小写 + 简体 / 普通话改写（faqSearchText.ts，代码写入）
    "search_text" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'staff',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_faq_phrasings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "helpdesk_faq_phrasings_locale_check" CHECK ("locale" IN ('en-GB', 'zh-CN', 'zh-TW')),
    CONSTRAINT "helpdesk_faq_phrasings_text_check" CHECK (char_length("text") BETWEEN 1 AND 200),
    CONSTRAINT "helpdesk_faq_phrasings_source_check" CHECK ("source" IN ('staff', 'flywheel', 'seed'))
);

CREATE UNIQUE INDEX "helpdesk_faq_phrasings_text_key"
    ON "helpdesk_faq_phrasings"("faq_id", "locale", lower("text"));

ALTER TABLE "helpdesk_faq_phrasings" ADD CONSTRAINT "helpdesk_faq_phrasings_faq_id_fkey"
    FOREIGN KEY ("faq_id") REFERENCES "helpdesk_faqs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- 问法变了 → 重算那条 FAQ 的 phrasing_text（同一事务）；不动 version / updated_at
CREATE OR REPLACE FUNCTION helpdesk_faq_phrasings_refresh()
RETURNS TRIGGER AS $$
DECLARE
  ids UUID[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    ids := ARRAY[NEW.faq_id];
  ELSIF TG_OP = 'DELETE' THEN
    ids := ARRAY[OLD.faq_id];
  ELSE
    ids := ARRAY[OLD.faq_id, NEW.faq_id];
  END IF;
  UPDATE helpdesk_faqs f
     SET phrasing_text = COALESCE(
           (SELECT string_agg(p.search_text, E'\n' ORDER BY p.created_at, p.id)
              FROM helpdesk_faq_phrasings p WHERE p.faq_id = f.id), '')
   WHERE f.id = ANY (ids);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "helpdesk_faq_phrasings_refresh"
    AFTER INSERT OR UPDATE OR DELETE ON "helpdesk_faq_phrasings"
    FOR EACH ROW EXECUTE FUNCTION helpdesk_faq_phrasings_refresh();

-- ---------------------------------------------------------------------------
-- 4. 发布版本（学员看到的就是 published 的那一版快照）
-- ---------------------------------------------------------------------------

CREATE TABLE "helpdesk_faq_releases" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    -- draft = 已冻结且通过检查与评测、等待发布；evaluating = 评测中；rejected = 检查或评测没过；
    -- published = 当前上线的（至多一行）；superseded = 曾经上线、已被替换
    "status" TEXT NOT NULL,
    -- { nodes[], edges[], phrasings[] }，写入后不再改（触发器拒绝）
    "snapshot" JSONB NOT NULL,
    "snapshot_hash" TEXT NOT NULL,
    -- 图检查结果（faqGraphChecks.ts）
    "checks" JSONB NOT NULL,
    -- 评测门的结果
    "eval_report" JSONB,
    -- 回滚：这一版的快照复制自哪个版本
    "source_version" INTEGER,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_by" UUID,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "helpdesk_faq_releases_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "helpdesk_faq_releases_version_check" CHECK ("version" >= 1),
    CONSTRAINT "helpdesk_faq_releases_status_check"
        CHECK ("status" IN ('draft', 'evaluating', 'published', 'rejected', 'superseded')),
    CONSTRAINT "helpdesk_faq_releases_published_check"
        CHECK ("status" NOT IN ('published', 'superseded') OR "published_at" IS NOT NULL)
);

CREATE UNIQUE INDEX "helpdesk_faq_releases_version_key" ON "helpdesk_faq_releases"("version");
-- 至多一行 published：发布 = 同一事务里把旧的改成 superseded、新的改成 published
CREATE UNIQUE INDEX "helpdesk_faq_releases_one_published"
    ON "helpdesk_faq_releases"((true)) WHERE "status" = 'published';
CREATE INDEX "helpdesk_faq_releases_hash_idx" ON "helpdesk_faq_releases"("snapshot_hash");

-- 快照、版本号与创建信息写入后不再改；发布版本不删除
CREATE OR REPLACE FUNCTION helpdesk_faq_releases_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'helpdesk_faq_releases rows are never deleted';
  END IF;
  IF NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.source_version IS DISTINCT FROM OLD.source_version
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'helpdesk_faq_releases snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "helpdesk_faq_releases_immutable"
    BEFORE UPDATE OR DELETE ON "helpdesk_faq_releases"
    FOR EACH ROW EXECUTE FUNCTION helpdesk_faq_releases_immutable();

-- 发布版本的检索行：从快照派生（与快照同一事务写入），列名与 helpdesk_faqs 相同，
-- 所以候选检索是同一条 SQL，只换表并加 release_version 条件（faqRepository.ts candidatesSql）
CREATE TABLE "helpdesk_faq_release_nodes" (
    "release_version" INTEGER NOT NULL,
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "node_type" TEXT NOT NULL,
    "entry" BOOLEAN NOT NULL,
    "category" TEXT NOT NULL,
    "popular" BOOLEAN NOT NULL,
    "question_en" TEXT NOT NULL,
    "answer_en" TEXT NOT NULL,
    "question_zh" TEXT NOT NULL,
    "answer_zh" TEXT NOT NULL,
    "keywords" TEXT[] NOT NULL,
    "signals" TEXT[] NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'published',
    -- 冻结时这条 FAQ 的 version
    "version" INTEGER NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "phrasing_text" TEXT NOT NULL DEFAULT '',
    "typo_keys" TEXT[] GENERATED ALWAYS AS (helpdesk_faq_typo_keys("question_en", "keywords")) STORED,
    "phrasing_tsv" TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', "phrasing_text")) STORED,

    CONSTRAINT "helpdesk_faq_release_nodes_pkey" PRIMARY KEY ("release_version", "id"),
    CONSTRAINT "helpdesk_faq_release_nodes_status_check" CHECK ("status" = 'published')
);

ALTER TABLE "helpdesk_faq_release_nodes" ADD CONSTRAINT "helpdesk_faq_release_nodes_release_fkey"
    FOREIGN KEY ("release_version") REFERENCES "helpdesk_faq_releases"("version")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE TRIGGER "helpdesk_faq_release_nodes_append_only"
    BEFORE UPDATE OR DELETE ON "helpdesk_faq_release_nodes"
    FOR EACH ROW EXECUTE FUNCTION helpdesk_faq_append_only();
