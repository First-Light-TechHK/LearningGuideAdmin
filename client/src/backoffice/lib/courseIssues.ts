import type { CourseIssue } from '../contracts/course';
import type { Locale } from './i18n/config';
import { t } from './i18n/messages';

/**
 * 服务器按字段报告"哪里没填完"（completeness.issues）；页面只负责把它放在对应的位置、写成当前语言。
 * 这里不判断任何完整性，只按字段路径找出属于某个位置的那几条。
 */

const asLocale = (locale: string): Locale => (locale.startsWith('zh') ? 'zh-CN' : 'en-GB');

/** 服务器的句子里括号中的细节（如 `Beyond video length (10:00)` 的 10:00）。 */
function detailOf(message: string): string {
  return message.match(/\(([^)]*)\)\s*$/)?.[1] ?? '';
}

export function issueText(locale: string, issue: Pick<CourseIssue, 'code' | 'message'>): string {
  const l = asLocale(locale);
  const key = `course.issues.${issue.code}`;
  if (t(l, key) === key) return t(l, 'course.issues.UNKNOWN');
  return t(l, key, { detail: detailOf(issue.message) });
}

export type IssueSpot = {
  /** 步骤：Course Information 和课时里都有叫 `title` 的字段，要按步骤分开。 */
  step?: CourseIssue['step'];
  lessonId?: string | null;
  /** 不传：不限语言；传 null：只要没有语言的（如分类、封面）。 */
  language?: string | null;
  field: string;
};

/** 属于某个位置的服务器提示：字段路径完全一致，课时和语言按需过滤。 */
export function issuesAt(issues: readonly CourseIssue[] | undefined, spot: IssueSpot): CourseIssue[] {
  return (issues ?? []).filter((issue) => {
    if (issue.field !== spot.field) return false;
    if (spot.step !== undefined && issue.step !== spot.step) return false;
    if (spot.lessonId !== undefined && (issue.lessonId ?? null) !== spot.lessonId) return false;
    if (spot.language !== undefined && (issue.language ?? null) !== spot.language) return false;
    return true;
  });
}

/** 同上，但写成一句话（几条用分号连起来）；没有就是 null。 */
export function issueLine(locale: string, issues: readonly CourseIssue[] | undefined, spot: IssueSpot): string | null {
  const found = issuesAt(issues, spot);
  if (found.length === 0) return null;
  return [...new Set(found.map((issue) => issueText(locale, issue)))].join(locale.startsWith('zh') ? '；' : '; ');
}

export function hasIssue(issues: readonly CourseIssue[] | undefined, spot: IssueSpot): boolean {
  return issuesAt(issues, spot).length > 0;
}
