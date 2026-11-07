-- 热门 FAQ 的顺序（产品 2026-11-02：帮助中心按产品挑的顺序列热门，前 10 条之外收起）。
-- 1 排最前；NULL = 没排，排在有顺序的热门之后（再按更新时间）。只在 popular = true 时起作用。
-- 发布版本的检索行同样带上，Portal 读到的热门顺序随发布冻结。
ALTER TABLE "helpdesk_faqs" ADD COLUMN "popular_rank" INTEGER;
ALTER TABLE "helpdesk_faqs" ADD CONSTRAINT "helpdesk_faqs_popular_rank_check"
  CHECK ("popular_rank" IS NULL OR "popular_rank" BETWEEN 1 AND 999);
ALTER TABLE "helpdesk_faq_release_nodes" ADD COLUMN "popular_rank" INTEGER;
