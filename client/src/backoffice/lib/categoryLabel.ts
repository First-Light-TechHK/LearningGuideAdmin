/**
 * 课程分类展示名（中文界面映射为中文）。
 *
 * 分类的规范名称随课程数据存为英文（Science / Chinese Humanities /
 * European Humanities），与 Portal `lib/portalContent.ts` 的分类 id 对齐；
 * 中文界面沿用同一套译文，其它值原样返回，避免后台新增分类时丢字。
 */
const ZH_CATEGORY_LABELS: Record<string, string> = {
  Science: '科学',
  'Chinese Humanities': '中国人文',
  'European Humanities': '欧洲人文',
};

export function categoryLabel(locale: string, name: string | null | undefined): string {
  if (!name) return '';
  if (!locale.startsWith('zh')) return name;
  return ZH_CATEGORY_LABELS[name] ?? name;
}
