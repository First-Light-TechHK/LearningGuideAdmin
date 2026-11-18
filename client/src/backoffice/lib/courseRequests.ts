/**
 * 课程接口请求体的构造：把页面状态变成服务器要的形状。
 * 都是纯函数，tests/course-requests.test.ts 逐个锁住。服务器是唯一的判断方：
 * 这里只整理形状，不判断"填没填完"。
 */

/** 创建课程：Course ID 和短名由服务器分配，不发；两种语言的课程名一次发出。 */
export function createCourseBody(input: {
  titleEn: string;
  titleZh: string;
  languages: string[];
  mode: string;
  categoryId: string;
}) {
  const defaultLanguage = input.languages.includes('en-GB') ? 'en-GB' : input.languages[0];
  return {
    titles: { 'en-GB': input.titleEn.trim(), 'zh-CN': input.titleZh.trim() },
    defaultContentLanguage: defaultLanguage,
    learningLanguages: input.languages,
    learningMode: input.mode,
    categoryId: input.categoryId || null,
  };
}

export type InfoDraft = {
  categoryId: string;
  titleEn: string;
  titleZh: string;
  descEn: string;
  descZh: string;
  overviewEn: string;
  overviewZh: string;
  learnRows: Array<{ en: string; zh: string }>;
  providesRows: Array<{ en: string; zh: string }>;
};

/**
 * Course Information 一次保存（PUT /courses/:id/information）：
 * 两种语言都发；两种语言的条目按位置一一对应，一边空着也照发（空的一半不能丢，否则下面的行会错位）。
 */
export function informationBody(draft: InfoDraft, addLearningLanguages: string[] = []) {
  const side = (language: 'en' | 'zh') => ({
    title: (language === 'en' ? draft.titleEn : draft.titleZh).trim(),
    shortDescription: (language === 'en' ? draft.descEn : draft.descZh).trim(),
    overview: (language === 'en' ? draft.overviewEn : draft.overviewZh).trim(),
    whatYouLearn: draft.learnRows.map((row) => row[language].trim()),
    provides: draft.providesRows.map((row) => row[language].trim()),
  });
  return {
    categoryId: draft.categoryId || null,
    localizations: { 'en-GB': side('en'), 'zh-CN': side('zh') },
    ...(addLearningLanguages.length > 0 ? { addLearningLanguages } : {}),
  };
}

/**
 * 理解测试导入（POST /courses/:id/understanding/import）：服务器从表单字段读 language 和 lessonId，不读地址里的参数。
 * 不带 lessonId = 导入到所有课时。
 */
export function understandingImportForm(file: Blob, language: string, lessonId?: string): FormData {
  const form = new FormData();
  form.append('file', file);
  form.append('language', language);
  if (lessonId) form.append('lessonId', lessonId);
  return form;
}

export type PointDraft = { id?: string; code?: string; title: string; timeText: string };

/**
 * 时间输入框里的文字 → 要发给服务器的值：
 * 空 = null（还没填，服务器报"必填"）；能读成 mm:ss（或 h:mm:ss、纯秒数）的发整数秒；
 * 读不懂的原样发出，由服务器回 INVALID_TIME 和行号，页面把错误放在那一行。
 */
export function timeToSend(text: string): number | string | null {
  const trimmed = text.trim().replace(/：/g, ':').replace(/\s*:\s*/g, ':');
  if (!trimmed) return null;
  // 只认 `秒数`、`m:ss`、`h:mm:ss`，冒号后的分和秒必须是 0–59；其余（负数、小数、字母、1:75）原样发出让服务器拒绝。
  if (!/^\d+(:\d{1,2}){0,2}$/.test(trimmed)) return text.trim();
  const parts = trimmed.split(':').map(Number);
  if (parts.slice(1).some((part) => part > 59)) return text.trim();
  const seconds = parts.length === 1 ? parts[0] : parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] * 3600 + parts[1] * 60 + parts[2];
  return Number.isSafeInteger(seconds) ? seconds : text.trim();
}

/** 视频学习点：已有的行带 id 和服务器给的编号（改标题、改时间、换位置都不换身份），新行不带。 */
export function videoPointsBody(language: string, rows: PointDraft[]) {
  return {
    language,
    points: rows.map((row) => ({
      ...(row.id ? { id: row.id } : {}),
      ...(row.code ? { code: row.code } : {}),
      title: row.title,
      timeSeconds: timeToSend(row.timeText),
    })),
  };
}

export type TriggerDraft = { exhibitId: string; timeText: string };

export function triggersBody(language: string, rows: TriggerDraft[]) {
  return {
    language,
    triggers: rows.map((row) => ({ exhibitId: row.exhibitId || null, timeSeconds: timeToSend(row.timeText) })),
  };
}

export type ReadingDraft = { id?: string; type: string; title: string; author: string; whyRecommended: string };

/** 推荐阅读：只有一份英文列表，整份发出，已有的行带 id，新行不带，不发语言。 */
export function readingsBody(rows: ReadingDraft[]) {
  return {
    readings: rows.map((row) => ({
      ...(row.id ? { id: row.id } : {}),
      type: row.type,
      title: row.title,
      author: row.author,
      whyRecommended: row.whyRecommended,
    })),
  };
}

/** 课时标题/简介：不发 Lesson ID（它不能改）。 */
export function lessonInfoBody(language: string, title: string, description: string) {
  return { language, title, description };
}

export function lessonTextBody(language: string, textHtml: string) {
  return { language, textHtml };
}

export function lessonCreateBody(language: string, title: string) {
  return { titles: { [language]: title } };
}

export function lessonOrderBody(lessonIds: string[]) {
  return { lessonIds };
}

export function exhibitOrderBody(exhibitIds: string[]) {
  return { exhibitIds };
}

/** 把列表里的一项和相邻的一项换位置；越界返回 null。 */
export function movedIds(ids: string[], id: string, direction: -1 | 1): string[] | null {
  const index = ids.indexOf(id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ids.length) return null;
  const next = [...ids];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
