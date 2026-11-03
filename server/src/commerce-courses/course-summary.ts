/**
 * 课程列表（课程名/副标题）应该展示哪条本地化记录。
 *
 * Prisma 的 `include: { localizations: true }` 没有 orderBy，返回顺序不稳定：
 * 记录被 UPDATE 后行位置可能变化。若直接取 `localizations[0]`，就可能拿到
 * 「添加学习语言」时以空标题占位的记录，导致课程列表里课程名为空白
 * （空字符串会绕过 `??` 兜底）。这里按下面的优先级挑一条：
 *
 * 1. 默认内容语言且标题非空；
 * 2. 任意标题非空的记录；
 * 3. 默认内容语言的记录（标题可能为空）；
 * 4. 第一条记录。
 */
export interface SummaryLocalization {
  language: string;
  title: string;
  shortDescription?: string | null;
}

export function pickSummaryLocalization(
  localizations: SummaryLocalization[],
  defaultContentLanguage: string,
): SummaryLocalization | undefined {
  const hasTitle = (loc: SummaryLocalization) => loc.title.trim() !== '';
  return (
    localizations.find(
      (loc) => loc.language === defaultContentLanguage && hasTitle(loc),
    ) ??
    localizations.find(hasTitle) ??
    localizations.find((loc) => loc.language === defaultContentLanguage) ??
    localizations[0]
  );
}

/** 课程名：本地化标题优先，其次 slug、课程编号，保证列表里永远有可读文本。 */
export function summaryTitle(
  localizations: SummaryLocalization[],
  defaultContentLanguage: string,
  fallbacks: { slug: string; code: string },
): string {
  const localized = pickSummaryLocalization(localizations, defaultContentLanguage);
  return localized?.title?.trim() || fallbacks.slug || fallbacks.code;
}
