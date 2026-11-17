import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  assertCategoryBinding,
  localizationData,
  nullableText,
  parseInformation,
  parseLanguage,
  parseLearningLanguages,
  parseLearningMode,
  parseLocalizationPatch,
  parseOptionalLanguage,
  parseTitles,
} from './course-info';

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof BadRequestException) {
      return (error.getResponse() as { code: string }).code;
    }
    throw error;
  }
  return undefined;
}

describe('learning mode and languages', () => {
  it('reads a mode in any case and treats missing as not sent', () => {
    expect(parseLearningMode('text_only')).toBe('TEXT_ONLY');
    expect(parseLearningMode(undefined)).toBeUndefined();
    expect(parseLearningMode('')).toBeUndefined();
  });

  it('refuses a mode that does not exist', () => {
    expect(codeOf(() => parseLearningMode('X'))).toBe('LEARNING_MODE_INVALID');
    expect(codeOf(() => parseLearningMode(7))).toBe('LEARNING_MODE_INVALID');
  });

  it('refuses a language that is not offered', () => {
    expect(parseLanguage('zh-CN', 'language')).toBe('zh-CN');
    expect(codeOf(() => parseLanguage('fr-FR', 'language'))).toBe(
      'LANGUAGE_INVALID',
    );
  });

  it('treats an empty language as not sent and refuses an unknown one', () => {
    expect(parseOptionalLanguage(undefined, 'language')).toBeUndefined();
    expect(parseOptionalLanguage(null, 'language')).toBeUndefined();
    expect(parseOptionalLanguage('', 'language')).toBeUndefined();
    expect(parseOptionalLanguage('zh-CN', 'language')).toBe('zh-CN');
    expect(codeOf(() => parseOptionalLanguage('fr-FR', 'language'))).toBe(
      'LANGUAGE_INVALID',
    );
  });

  it('keeps the order of the languages and drops repeats', () => {
    expect(parseLearningLanguages(['zh-CN', 'en-GB', 'zh-CN'])).toEqual([
      'zh-CN',
      'en-GB',
    ]);
    expect(parseLearningLanguages(undefined)).toBeUndefined();
    expect(codeOf(() => parseLearningLanguages('en-GB'))).toBe(
      'VALIDATION_ERROR',
    );
  });
});

describe('titles and text', () => {
  it('reads one title per language and ignores null', () => {
    expect(parseTitles({ 'en-GB': 'A', 'zh-CN': null })).toEqual({
      'en-GB': 'A',
    });
    expect(parseTitles(undefined)).toEqual({});
  });

  it('refuses a title that is not text, an unknown language or a list', () => {
    expect(codeOf(() => parseTitles({ 'en-GB': 5 }))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => parseTitles({ 'fr-FR': 'x' }))).toBe(
      'LANGUAGE_INVALID',
    );
    expect(codeOf(() => parseTitles(['x']))).toBe('VALIDATION_ERROR');
  });

  it('tells not sent from cleared', () => {
    expect(nullableText(undefined, 'f')).toBeUndefined();
    expect(nullableText(null, 'f')).toBeNull();
    expect(nullableText('', 'f')).toBe('');
    expect(codeOf(() => nullableText(3, 'f'))).toBe('VALIDATION_ERROR');
  });
});

describe('Course Information patch', () => {
  it('holds only the keys that were sent', () => {
    expect(parseLocalizationPatch({ overview: 'Only this' })).toEqual({
      overview: 'Only this',
    });
    expect(parseLocalizationPatch({})).toEqual({});
    expect(parseLocalizationPatch(undefined)).toEqual({});
  });

  it('keeps blank items so the two languages stay in step', () => {
    expect(
      parseLocalizationPatch({ whatYouLearn: ['A', '', 'C'] }).whatYouLearn,
    ).toEqual(['A', '', 'C']);
  });

  it('refuses the wrong shapes', () => {
    expect(codeOf(() => parseLocalizationPatch({ title: null }))).toBe(
      'VALIDATION_ERROR',
    );
    expect(codeOf(() => parseLocalizationPatch({ whatYouLearn: 'a' }))).toBe(
      'VALIDATION_ERROR',
    );
    expect(codeOf(() => parseLocalizationPatch({ provides: [1] }))).toBe(
      'VALIDATION_ERROR',
    );
    expect(codeOf(() => parseLocalizationPatch('text'))).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('writes a cleared list as a database null and leaves unsent keys out', () => {
    expect(localizationData({ provides: null, title: 'T' })).toEqual({
      title: 'T',
      provides: Prisma.DbNull,
    });
    expect(localizationData({})).toEqual({});
  });
});

describe('PUT information body', () => {
  it('reads category, languages and per-language patches', () => {
    expect(
      parseInformation({
        categoryId: 'c1',
        addLearningLanguages: ['zh-CN'],
        localizations: { 'en-GB': { title: 'A' }, 'zh-CN': { overview: 'B' } },
      }),
    ).toEqual({
      categoryId: 'c1',
      addLearningLanguages: ['zh-CN'],
      localizations: [
        ['en-GB', { title: 'A' }],
        ['zh-CN', { overview: 'B' }],
      ],
    });
  });

  it('treats an empty category as clearing it and a missing one as leaving it', () => {
    expect(parseInformation({ categoryId: '' }).categoryId).toBeNull();
    expect('categoryId' in parseInformation({})).toBe(false);
  });

  it('refuses what is not an object or names a language that is not offered', () => {
    expect(codeOf(() => parseInformation([]))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => parseInformation({ localizations: [] }))).toBe(
      'VALIDATION_ERROR',
    );
    expect(
      codeOf(() => parseInformation({ localizations: { 'fr-FR': {} } })),
    ).toBe('LANGUAGE_INVALID');
  });
});

describe('assertCategoryBinding', () => {
  type Entry = { id: string; status: string; parentId: string | null };
  function db(rows: Entry[]) {
    return {
      courseCatalogueEntry: {
        findUnique: ({ where }: { where: { id: string } }) =>
          Promise.resolve(rows.find((row) => row.id === where.id) ?? null),
      },
    } as never;
  }
  const top: Entry = { id: 'top', status: 'ACTIVE', parentId: null };
  const child: Entry = { id: 'child', status: 'ACTIVE', parentId: 'top' };
  const grand: Entry = { id: 'grand', status: 'ACTIVE', parentId: 'child' };
  const archived: Entry = { id: 'old', status: 'ARCHIVED', parentId: null };

  it('lets a course have no category', async () => {
    await expect(assertCategoryBinding(db([]), null)).resolves.toBeNull();
    await expect(assertCategoryBinding(db([]), '')).resolves.toBeNull();
  });

  it('accepts an active category on level one or two', async () => {
    const all = db([top, child, grand, archived]);
    await expect(assertCategoryBinding(all, 'top')).resolves.toBe('top');
    await expect(assertCategoryBinding(all, 'child')).resolves.toBe('child');
  });

  it('names what is wrong with the others', async () => {
    const all = db([top, child, grand, archived]);
    await expect(assertCategoryBinding(all, 'nope')).rejects.toMatchObject({
      response: { code: 'CATEGORY_NOT_FOUND' },
    });
    await expect(assertCategoryBinding(all, 'old')).rejects.toMatchObject({
      response: { code: 'CATEGORY_ARCHIVED' },
    });
    await expect(assertCategoryBinding(all, 'grand')).rejects.toMatchObject({
      response: { code: 'CATEGORY_INVALID_LEVEL' },
    });
  });
});
