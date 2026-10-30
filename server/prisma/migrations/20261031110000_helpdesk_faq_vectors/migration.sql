-- Helpdesk FAQ 向量检索的基建（RAG，owner 2026-10-30 22:07Z：先把基建打好，人工过一遍卡片后再决定上不上）。
-- 读写在 faqVectors.ts；HELPDESK_RETRIEVAL 缺省 = lexical，不配 HELPDESK_EMBED_MODEL 时这两张表一直是空的。
-- 不用 pgvector（CI 的 postgres:16 没有这个扩展）：向量存 REAL[]，按 (版本, 模型) 整批读进内存算相似度。
-- 两张表都只追加：向量按文本内容寻址，发布版本不再变。

-- 同一个模型下同一段文本只存一个向量（按 sha256）；文本没变，下一次发布就不再算。
CREATE TABLE "helpdesk_faq_embeddings" (
    "model" TEXT NOT NULL,
    "text_hash" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "dims" INTEGER NOT NULL,
    "embedding" REAL[] NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helpdesk_faq_embeddings_pkey" PRIMARY KEY ("model", "text_hash"),
    CONSTRAINT "helpdesk_faq_embeddings_model_check" CHECK (char_length("model") BETWEEN 1 AND 200),
    CONSTRAINT "helpdesk_faq_embeddings_hash_check" CHECK ("text_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "helpdesk_faq_embeddings_dims_check"
        CHECK ("dims" BETWEEN 1 AND 8192 AND cardinality("embedding") = "dims")
);

CREATE TRIGGER "helpdesk_faq_embeddings_append_only"
    BEFORE UPDATE OR DELETE ON "helpdesk_faq_embeddings"
    FOR EACH ROW EXECUTE FUNCTION helpdesk_faq_append_only();

-- 某一版的每个节点用了哪几段文本（英文问题、中文问题、问法）。一版的连接最后一次写完，
-- 检索要么看到完整的一版，要么一条也看不到（退回字词检索）。主键以 (版本, 模型) 开头，整批读走主键。
CREATE TABLE "helpdesk_faq_release_vectors" (
    "release_version" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "node_id" UUID NOT NULL,
    "text_hash" TEXT NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "helpdesk_faq_release_vectors_pkey"
        PRIMARY KEY ("release_version", "model", "node_id", "text_hash"),
    CONSTRAINT "helpdesk_faq_release_vectors_source_check"
        CHECK ("source" IN ('question_en', 'question_zh', 'phrasing'))
);

ALTER TABLE "helpdesk_faq_release_vectors" ADD CONSTRAINT "helpdesk_faq_release_vectors_node_fkey"
    FOREIGN KEY ("release_version", "node_id") REFERENCES "helpdesk_faq_release_nodes"("release_version", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "helpdesk_faq_release_vectors" ADD CONSTRAINT "helpdesk_faq_release_vectors_embedding_fkey"
    FOREIGN KEY ("model", "text_hash") REFERENCES "helpdesk_faq_embeddings"("model", "text_hash")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE TRIGGER "helpdesk_faq_release_vectors_append_only"
    BEFORE UPDATE OR DELETE ON "helpdesk_faq_release_vectors"
    FOR EACH ROW EXECUTE FUNCTION helpdesk_faq_append_only();
