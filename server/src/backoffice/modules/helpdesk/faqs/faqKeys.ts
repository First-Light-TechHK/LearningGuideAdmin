import { chineseSearchForms } from './faqSearchText';

/**
 * v5 问题树的 FAQ key（helpdesk-v5-faq-graph-design §2.1）：稳定的 slug，改文字也不变。
 * faqKeySlug 与迁移 20261030150000 的 SQL 函数 helpdesk_faq_slug 完全同一规则
 * （helpdesk-faq-graph.pg.spec.ts 用 FAQ 库的问题逐条比对锁定）：小写，去掉撇号，
 * 非 [a-z0-9] 的连续字符换成一个 -，去掉首尾 -，至多 60 个字符（截断后再去尾部 -），空了就是 faq。
 */
export function faqKeySlug(question: string): string {
  const slug = question
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'faq' : slug;
}

/**
 * 问法的检索文字：原文小写（NFKC）+ 简体 / 普通话改写，换行连接（与 searchTerms 的 body 同一套形式），
 * 繁体问法与简体的学员原文就能对上中文双字。存进 helpdesk_faq_phrasings.search_text，
 * 发布时也用它写发布版本的检索行。
 */
export function phrasingSearchText(text: string): string {
  const lower = text.normalize('NFKC').toLowerCase();
  return [...new Set([lower, ...chineseSearchForms(lower)])].join('\n');
}
