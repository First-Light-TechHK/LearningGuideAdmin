import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { CourseTx } from './course-write';
import { oneOf, requireArray } from './input';

/**
 * 课程基本信息（PRD 第一步）的输入整理：形状不对的输入变成 400，
 * 没填完的值（空标题、空条目、缺的语言）照常保存，由完整性规则报告。
 */

/** 课程基本信息和学习语言能选的语言。 */
export const COURSE_LANGUAGES = ['en-GB', 'zh-CN'] as const;
export type CourseLanguage = (typeof COURSE_LANGUAGES)[number];

export const LEARNING_MODES = [
  'VIDEO_ONLY',
  'TEXT_ONLY',
  'VIDEO_AND_TEXT',
] as const;
export type LearningMode = (typeof LEARNING_MODES)[number];

export const DEFAULT_LEARNING_MODE: LearningMode = 'VIDEO_AND_TEXT';
export const DEFAULT_LANGUAGE: CourseLanguage = 'en-GB';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refuse(field: string, message: string): never {
  throw new BadRequestException({
    code: 'VALIDATION_ERROR',
    message,
    details: { field },
  });
}

export function parseLanguage(value: unknown, field: string): CourseLanguage {
  return oneOf(value, COURSE_LANGUAGES, field, { code: 'LANGUAGE_INVALID' });
}

/** 没传（undefined、null、空字符串）得到 undefined；传了就必须是能选的语言。 */
export function parseOptionalLanguage(
  value: unknown,
  field: string,
): CourseLanguage | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return parseLanguage(value, field);
}

/** 没传（或空）得到 undefined；传了就必须是三种模式之一，大小写不限。 */
export function parseLearningMode(value: unknown): LearningMode | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const normalised =
    typeof value === 'string' ? value.trim().toUpperCase() : '';
  return oneOf(normalised || value, LEARNING_MODES, 'learningMode', {
    code: 'LEARNING_MODE_INVALID',
  });
}

/** 没传得到 undefined；传了必须是语言列表，重复的去掉，顺序不变。 */
export function parseLearningLanguages(
  value: unknown,
  field = 'learningLanguages',
): CourseLanguage[] | undefined {
  if (value === undefined || value === null) return undefined;
  const items = requireArray(value, field);
  const result: CourseLanguage[] = [];
  for (const item of items) {
    const language = parseLanguage(item, field);
    if (!result.includes(language)) result.push(language);
  }
  return result;
}

/** 文字字段：没传得到 undefined，null 表示清空，其余必须是文字（空字符串照存）。 */
export function nullableText(
  value: unknown,
  field: string,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return refuse(field, `${field} must be text.`);
  return value;
}

/** 条目列表（whatYouLearn / provides）：每项必须是文字，空条目照存，两种语言的条目靠位置对应。 */
function nullableTextList(
  value: unknown,
  field: string,
): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const items = requireArray(value, field);
  return items.map((item, index) => {
    if (typeof item !== 'string') {
      return refuse(`${field}[${index}]`, `${field} items must be text.`);
    }
    return item;
  });
}

/** 创建时的 `titles`：{ 语言: 课程名 }，只认两种语言；没传得到空对象。 */
export function parseTitles(
  value: unknown,
): Partial<Record<CourseLanguage, string>> {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) return refuse('titles', 'titles must be an object.');
  const titles: Partial<Record<CourseLanguage, string>> = {};
  for (const [key, title] of Object.entries(value)) {
    const language = parseLanguage(key, 'titles');
    const text = nullableText(title, `titles.${language}`);
    if (text !== undefined && text !== null) titles[language] = text;
  }
  return titles;
}

/** 一种语言的课程基本信息：只含这次发来的键。 */
export interface LocalizationPatch {
  title?: string;
  shortDescription?: string | null;
  overview?: string | null;
  whatYouLearn?: string[] | null;
  provides?: string[] | null;
}

export function parseLocalizationPatch(
  value: unknown,
  field = 'body',
): LocalizationPatch {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) return refuse(field, `${field} must be an object.`);
  const patch: LocalizationPatch = {};
  if (value.title !== undefined) {
    // 课程名不能被清成 null（数据库里是必填文字）；空字符串照存，完整性规则会报 Required。
    if (typeof value.title !== 'string') {
      return refuse(`${field}.title`, 'title must be text.');
    }
    patch.title = value.title;
  }
  const shortDescription = nullableText(
    value.shortDescription,
    `${field}.shortDescription`,
  );
  if (shortDescription !== undefined) patch.shortDescription = shortDescription;
  const overview = nullableText(value.overview, `${field}.overview`);
  if (overview !== undefined) patch.overview = overview;
  const whatYouLearn = nullableTextList(
    value.whatYouLearn,
    `${field}.whatYouLearn`,
  );
  if (whatYouLearn !== undefined) patch.whatYouLearn = whatYouLearn;
  const provides = nullableTextList(value.provides, `${field}.provides`);
  if (provides !== undefined) patch.provides = provides;
  return patch;
}

/** 写库用的字段：JSON 列的 null 要用 DbNull。 */
export function localizationData(patch: LocalizationPatch) {
  const json = (list: string[] | null) =>
    list === null ? Prisma.DbNull : (list as Prisma.InputJsonValue);
  return {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.shortDescription !== undefined
      ? { shortDescription: patch.shortDescription }
      : {}),
    ...(patch.overview !== undefined ? { overview: patch.overview } : {}),
    ...(patch.whatYouLearn !== undefined
      ? { whatYouLearn: json(patch.whatYouLearn) }
      : {}),
    ...(patch.provides !== undefined ? { provides: json(patch.provides) } : {}),
  };
}

/** `PUT :id/information` 的请求体。 */
export interface InformationInput {
  /** undefined：不动；null 或空：清掉分类。 */
  categoryId?: string | null;
  localizations: Array<[CourseLanguage, LocalizationPatch]>;
  addLearningLanguages: CourseLanguage[];
}

export function parseInformation(value: unknown): InformationInput {
  if (!isObject(value)) return refuse('body', 'body must be an object.');
  let categoryId: string | null | undefined;
  if (value.categoryId !== undefined) {
    const text = nullableText(value.categoryId, 'categoryId');
    categoryId = text ? text : null;
  }
  const localizations: InformationInput['localizations'] = [];
  if (value.localizations !== undefined && value.localizations !== null) {
    if (!isObject(value.localizations)) {
      return refuse('localizations', 'localizations must be an object.');
    }
    for (const [key, patch] of Object.entries(value.localizations)) {
      const language = parseLanguage(key, 'localizations');
      localizations.push([
        language,
        parseLocalizationPatch(patch, `localizations.${language}`),
      ]);
    }
  }
  return {
    ...(categoryId !== undefined ? { categoryId } : {}),
    localizations,
    addLearningLanguages:
      parseLearningLanguages(
        value.addLearningLanguages,
        'addLearningLanguages',
      ) ?? [],
  };
}

/**
 * 课程分类绑定校验（唯一一处）：分类必须存在、启用、层级不超过两级。
 * 没有分类（null、空）不算错：清掉分类是允许的，Course Information 会显示 Required。
 */
export async function assertCategoryBinding(
  db: PrismaService | CourseTx,
  categoryId: string | null | undefined,
): Promise<string | null> {
  if (!categoryId) return null;
  const category = await db.courseCatalogueEntry.findUnique({
    where: { id: categoryId },
    select: { id: true, status: true, parentId: true },
  });
  const refusal = (code: string, message: string) =>
    new BadRequestException({
      code,
      message,
      details: { field: 'categoryId' },
    });
  if (!category) {
    throw refusal('CATEGORY_NOT_FOUND', 'Category not found.');
  }
  if (category.status !== 'ACTIVE') {
    throw refusal(
      'CATEGORY_ARCHIVED',
      'Category is archived and cannot be assigned.',
    );
  }
  if (category.parentId !== null) {
    const parent = await db.courseCatalogueEntry.findUnique({
      where: { id: category.parentId },
      select: { parentId: true },
    });
    if (parent?.parentId) {
      throw refusal(
        'CATEGORY_INVALID_LEVEL',
        'Category is deeper than level 2.',
      );
    }
  }
  return category.id;
}
