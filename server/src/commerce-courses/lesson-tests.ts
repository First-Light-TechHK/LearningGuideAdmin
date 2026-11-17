/**
 * 测试按 Content language 分别保存（PRD L421）：每个课时每种语言各一份应用题、各一组知识题。
 * 在页面、快照和课程包都按语言读写之前（B14），所有只认"一份"的读取方都取默认内容语言的那一份。
 */
export function defaultLanguageTest<T extends { language: string }>(
  rows: readonly T[] | null | undefined,
  defaultContentLanguage: string,
): T | null {
  return rows?.find((row) => row.language === defaultContentLanguage) ?? null;
}

/** 同上，用于一组题目：只留默认内容语言的题。 */
export function defaultLanguageRows<T extends { language: string }>(
  rows: readonly T[] | null | undefined,
  defaultContentLanguage: string,
): T[] {
  return (rows ?? []).filter((row) => row.language === defaultContentLanguage);
}

/**
 * 把读出来的课程（课时带 `questions` 与 `applicationTests`）整理成旧形状：
 * `questions` 只留默认内容语言的题，`applicationTest` 是默认内容语言的那一份（或 null）。
 */
export function withDefaultLanguageTests<
  C extends {
    defaultContentLanguage: string;
    lessons: Array<{
      questions: Array<{ language: string }>;
      applicationTests: Array<{ language: string }>;
    }>;
  },
>(
  course: C,
): Omit<C, 'lessons'> & {
  lessons: Array<
    C['lessons'][number] & {
      applicationTest: C['lessons'][number]['applicationTests'][number] | null;
    }
  >;
} {
  return {
    ...course,
    lessons: course.lessons.map((lesson: C['lessons'][number]) => ({
      ...lesson,
      questions: defaultLanguageRows(
        lesson.questions,
        course.defaultContentLanguage,
      ),
      applicationTest: defaultLanguageTest(
        lesson.applicationTests,
        course.defaultContentLanguage,
      ),
    })),
  };
}
