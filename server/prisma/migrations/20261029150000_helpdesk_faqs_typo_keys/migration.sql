-- Helpdesk FAQ 候选检索的英文拼写容错（2026-10-29）。不用扩展（不需要 pg_trgm，运维无需额外操作）：
-- 对称删除（SymSpell）—— 英文问题与关键词里 ≥5 个字母的词，连同每个「删掉一个字母」的写法，
-- 存成生成列 typo_keys（GIN 索引）；查询端对学员的词做同样的展开（faqSearchText.ts typoKeys），
-- 两边有交集就算拼写相近（编辑距离 1，含相邻两字母对调）。只加不改：已应用的迁移一个字不动。

-- 只依赖参数、不读表，结果确定（IMMUTABLE 才能用在生成列里）
CREATE OR REPLACE FUNCTION helpdesk_faq_typo_keys(question_en TEXT, keywords TEXT[])
RETURNS TEXT[] AS $$
  SELECT COALESCE(array_agg(DISTINCT k.key ORDER BY k.key), ARRAY[]::TEXT[])
    FROM regexp_split_to_table(lower(question_en || ' ' || array_to_string(keywords, ' ')), '[^a-z]+') AS w(word)
   CROSS JOIN LATERAL (
     SELECT w.word AS key
     UNION ALL
     SELECT overlay(w.word PLACING '' FROM g FOR 1) FROM generate_series(1, length(w.word)) AS g
   ) AS k
   WHERE length(w.word) >= 5
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

ALTER TABLE "helpdesk_faqs" ADD COLUMN "typo_keys" TEXT[]
    GENERATED ALWAYS AS (helpdesk_faq_typo_keys("question_en", "keywords")) STORED;

CREATE INDEX "helpdesk_faqs_typo_keys_idx" ON "helpdesk_faqs" USING GIN ("typo_keys");
