import {
  createScratchDatabase,
  type ScratchDatabase,
} from './helpers/migration-db';

/**
 * Course-module migrations against a database that already holds courses: apply everything before
 * the migration, load legacy rows, apply it, assert what it did to them. Each describe builds its own
 * throwaway database, so these tests never touch the shared one.
 */
jest.setTimeout(120000);

describe('migration 20261118000000_course_identity', () => {
  const MIGRATION = '20261118000000_course_identity';
  let db: ScratchDatabase;

  async function rows<T extends Record<string, unknown>>(
    sql: string,
  ): Promise<T[]> {
    return (await db.client.query<T>(sql)).rows;
  }

  async function counter(key: string): Promise<number | null> {
    const found = await rows<{ next: number }>(
      `SELECT next FROM "CourseCodeCounter" WHERE key = '${key}'`,
    );
    return found[0]?.next ?? null;
  }

  beforeAll(async () => {
    db = await createScratchDatabase();
    await db.applyMigrations({ before: MIGRATION });
    await db.loadFixture('course-identity-legacy.sql');
    await db.applyMigrations({ only: MIGRATION });
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('seeds the Course ID counter above the highest C-number and ignores other codes', async () => {
    expect(await counter('course')).toBe(8);
  });

  it('seeds the lesson counter from the highest trailing number, archived lessons included', async () => {
    expect(await counter('lesson:mig-a')).toBe(6);
    expect(await counter('lesson:mig-c')).toBe(3);
    expect(await counter('lesson:mig-b')).toBeNull();
  });

  it('seeds learning point counters per lesson, language and source (legacy 1.3 counts as 3)', async () => {
    expect(await counter('lp:mig-la:en-GB:V')).toBe(4);
    expect(await counter('lp:mig-la:zh-CN:V')).toBe(2);
    expect(await counter('lp:mig-la:en-GB:T')).toBe(3);
  });

  it('renames the later duplicate exhibit code and keeps the oldest holder', async () => {
    const exhibits = await rows<{
      id: string;
      code: string;
      courseId: string;
      sortOrder: number;
    }>(`SELECT id, code, "courseId", "sortOrder" FROM "Exhibit" ORDER BY id`);
    expect(exhibits).toEqual([
      { id: 'mig-ea1', code: 'E001', courseId: 'mig-a', sortOrder: 1 },
      { id: 'mig-ea2', code: 'E002', courseId: 'mig-a', sortOrder: 2 },
      { id: 'mig-eb1', code: 'E003', courseId: 'mig-a', sortOrder: 1 },
    ]);
    expect(await counter('exhibit:mig-a')).toBe(4);
  });

  it('rewrites the card of the renamed exhibit in its own lesson only', async () => {
    const texts = await rows<{
      lessonId: string;
      language: string;
      textHtml: string;
    }>(
      `SELECT "lessonId", language, "textHtml" FROM "LessonLocalization" ORDER BY id`,
    );
    const byKey = Object.fromEntries(
      texts.map((t) => [`${t.lessonId}/${t.language}`, t.textHtml]),
    );
    // Lesson A keeps E001.
    expect(byKey['mig-la/en-GB']).toContain(
      'data-exhibit-code="E001" data-exhibit-id="mig-ea1"',
    );
    // Lesson B: its own exhibit's card is renamed in both languages; a card for lesson A's exhibit is not.
    expect(byKey['mig-lb/en-GB']).toContain(
      'data-exhibit-code="E003" data-exhibit-id="mig-eb1"',
    );
    expect(byKey['mig-lb/en-GB']).toContain(
      'data-exhibit-code="E001" data-exhibit-id="mig-ea1"',
    );
    expect(byKey['mig-lb/zh-CN']).toContain(
      'data-exhibit-code="E003" data-exhibit-id="mig-eb1"',
    );
  });

  it('says which exhibit it renamed', () => {
    expect(db.notices.some((notice) => notice.includes('E001 -> E003'))).toBe(
      true,
    );
  });

  it('gives an orphan or foreign trigger no exhibit instead of a dangling id', async () => {
    const triggers = await rows<{
      id: string;
      exhibitId: string | null;
      sortOrder: number;
    }>(`SELECT id, "exhibitId", "sortOrder" FROM "ExhibitTrigger" ORDER BY id`);
    expect(triggers).toEqual([
      { id: 'tg-b', exhibitId: 'mig-eb1', sortOrder: 1 },
      { id: 'tg-foreign', exhibitId: null, sortOrder: 1 },
      { id: 'tg-good', exhibitId: 'mig-ea1', sortOrder: 2 },
      { id: 'tg-orphan', exhibitId: null, sortOrder: 1 },
    ]);
  });

  it('allows the same exhibit at two times and a trigger with nothing chosen yet', async () => {
    await db.client.query(
      `INSERT INTO "ExhibitTrigger" (id, "lessonId", "exhibitId", language, "timeSeconds")
       VALUES ('tg-again', 'mig-la', 'mig-ea1', 'en-GB', 99),
              ('tg-blank-1', 'mig-la', NULL, 'en-GB', NULL),
              ('tg-blank-2', 'mig-la', NULL, 'en-GB', NULL)`,
    );
    await expect(
      db.client.query(
        `INSERT INTO "ExhibitTrigger" (id, "lessonId", "exhibitId", language, "timeSeconds")
         VALUES ('tg-dup', 'mig-la', 'mig-ea1', 'en-GB', 99)`,
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it('refuses a second exhibit with the same code anywhere in the course', async () => {
    await expect(
      db.client.query(
        `INSERT INTO "Exhibit" (id, "lessonId", "courseId", code, type, localized, "updatedAt")
         VALUES ('mig-ex-dup', 'mig-lb', 'mig-a', 'E001', 'IMAGE', '{}', now())`,
      ),
    ).rejects.toThrow(/Exhibit_courseId_code_key/);
  });

  it('compacts active lesson positions to 1..N and leaves archived ones alone', async () => {
    const lessons = await rows<{ id: string; sortOrder: number }>(
      `SELECT id, "sortOrder" FROM "Lesson" ORDER BY id`,
    );
    expect(lessons).toEqual([
      { id: 'mig-la', sortOrder: 1 },
      { id: 'mig-lb', sortOrder: 2 },
      { id: 'mig-lc1', sortOrder: 1 },
      { id: 'mig-lc2', sortOrder: 2 },
      { id: 'mig-lz', sortOrder: 5 },
    ]);
  });

  it('backfills the video duration onto the file', async () => {
    const assets = await rows<{ id: string; durationSeconds: number | null }>(
      `SELECT id, "durationSeconds" FROM "CourseMediaAsset" ORDER BY id`,
    );
    expect(assets).toEqual([
      { id: 'mig-img', durationSeconds: null },
      { id: 'mig-v-en', durationSeconds: 100 },
    ]);
  });
});

describe('migration 20261118010000_course_tests_trial', () => {
  const MIGRATION = '20261118010000_course_tests_trial';
  let db: ScratchDatabase;

  async function rows<T extends Record<string, unknown>>(
    sql: string,
  ): Promise<T[]> {
    return (await db.client.query<T>(sql)).rows;
  }

  beforeAll(async () => {
    db = await createScratchDatabase();
    await db.applyMigrations({ before: MIGRATION });
    await db.loadFixture('course-tests-legacy.sql');
    await db.applyMigrations({ only: MIGRATION });
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('renumbers questions to a course-unique K-{lesson}{sequence} in the default language', async () => {
    const questions = await rows<{
      id: string;
      code: string;
      language: string;
      courseId: string;
    }>(
      `SELECT id, code, language, "courseId" FROM "KnowledgeQuestion" ORDER BY id`,
    );
    expect(questions).toEqual([
      { id: 'mig-q11', code: 'K-0101', language: 'en-GB', courseId: 'mig-t' },
      { id: 'mig-q12', code: 'K-0102', language: 'en-GB', courseId: 'mig-t' },
      { id: 'mig-q31', code: 'K-0301', language: 'en-GB', courseId: 'mig-t' },
      { id: 'mig-q32', code: 'K-0302', language: 'en-GB', courseId: 'mig-t' },
    ]);
  });

  it('seeds the question counter so the next new question does not reuse a code', async () => {
    const counters = await rows<{ key: string; next: number }>(
      `SELECT key, next FROM "CourseCodeCounter" WHERE key LIKE 'knowledge:%' ORDER BY key`,
    );
    expect(counters).toEqual([
      { key: 'knowledge:mig-t-l1', next: 3 },
      { key: 'knowledge:mig-t-l3', next: 3 },
    ]);
  });

  it('gives each application test a code and its language', async () => {
    const tests = await rows<{
      id: string;
      code: string;
      language: string;
      enabled: boolean;
    }>(`SELECT id, code, language, enabled FROM "ApplicationTest" ORDER BY id`);
    expect(tests).toEqual([
      { id: 'mig-a1', code: 'A-0101', language: 'en-GB', enabled: true },
      { id: 'mig-a3', code: 'A-0301', language: 'en-GB', enabled: false },
    ]);
    const counter = await rows<{ next: number }>(
      `SELECT next FROM "CourseCodeCounter" WHERE key = 'application:mig-t-l1'`,
    );
    expect(counter[0].next).toBe(2);
  });

  it('backfills the stored Enabled switches from what exists and adds the missing language row', async () => {
    const flags = await rows<{
      lessonId: string;
      title: string;
      knowledgeTestEnabled: boolean;
      applicationTestEnabled: boolean;
    }>(
      `SELECT "lessonId", title, "knowledgeTestEnabled", "applicationTestEnabled"
       FROM "LessonLocalization" WHERE language = 'en-GB' ORDER BY "lessonId"`,
    );
    expect(flags).toEqual([
      {
        lessonId: 'mig-t-l1',
        title: 'One',
        knowledgeTestEnabled: true,
        applicationTestEnabled: true,
      },
      // No localization row before: created empty, questions exist, the application test is switched off.
      {
        lessonId: 'mig-t-l3',
        title: '',
        knowledgeTestEnabled: true,
        applicationTestEnabled: false,
      },
      {
        lessonId: 'mig-t-l4',
        title: 'Four',
        knowledgeTestEnabled: false,
        applicationTestEnabled: false,
      },
    ]);
  });

  it('relabels readings to English only for a lesson that has no English list, and says how many', async () => {
    const readings = await rows<{ id: string; language: string }>(
      `SELECT id, language FROM "RecommendedReading" ORDER BY id`,
    );
    expect(readings).toEqual([
      { id: 'mig-r1', language: 'en-GB' },
      { id: 'mig-r2', language: 'en-GB' },
      { id: 'mig-r3', language: 'en-GB' },
      { id: 'mig-r4', language: 'zh-CN' },
    ]);
    expect(
      db.notices.some((notice) => notice.includes('relabelled to en-GB: 2')),
    ).toBe(true);
  });

  it('turns a legacy id cut-off into a per-language learning point code', async () => {
    const trial = await rows<{
      id: string;
      cutoffs: unknown;
      confirmed: unknown;
    }>(`SELECT id, cutoffs, confirmed FROM "TrialSetting" ORDER BY id`);
    expect(trial[0]).toEqual({
      id: 'mig-trial-1',
      cutoffs: {
        'en-GB': { videoSeconds: 60, textLpCode: 'T2' },
        'zh-CN': { videoSeconds: 90, textLpCode: 'T1' },
      },
      confirmed: {
        'en-GB': {
          videoAssetId: 'mig-t-video',
          textLpCode: 'T2',
          textIndex: 2,
        },
      },
    });
    // A value that already is a code is kept, under the default language.
    expect(trial[1]).toEqual({
      id: 'mig-trial-2',
      cutoffs: { 'en-GB': { textLpCode: 'T3' } },
      confirmed: null,
    });
  });

  it('allows the same code in two courses but not twice in one course', async () => {
    await db.client.query(
      `INSERT INTO "CommerceCourse" (id, code, slug, "learningMode", "learningLanguages", "updatedAt")
       VALUES ('mig-t2', 'C011', 'mig-t2', 'VIDEO_AND_TEXT', '["en-GB"]'::jsonb, now())`,
    );
    await db.client.query(
      `INSERT INTO "Lesson" (id, "courseId", code, "sortOrder", "updatedAt")
       VALUES ('mig-t2-l1', 'mig-t2', 'L1', 1, now())`,
    );
    await db.client.query(
      `INSERT INTO "KnowledgeQuestion" (id, "lessonId", "courseId", language, code, question, "sortOrder")
       VALUES ('mig-q-other', 'mig-t2-l1', 'mig-t2', 'en-GB', 'K-0101', 'Q', 1)`,
    );
    await expect(
      db.client.query(
        `INSERT INTO "KnowledgeQuestion" (id, "lessonId", "courseId", language, code, question, "sortOrder")
         VALUES ('mig-q-dup', 'mig-t-l1', 'mig-t', 'zh-CN', 'K-0101', 'Q', 1)`,
      ),
    ).rejects.toThrow(/KnowledgeQuestion_courseId_code_key/);
  });
});

describe('course migrations on an empty database', () => {
  it('apply cleanly in order', async () => {
    const db = await createScratchDatabase();
    try {
      await db.applyMigrations();
      const tables = await db.client.query<{ counter: string | null }>(
        `SELECT to_regclass('"CourseCodeCounter"')::text AS counter`,
      );
      expect(tables.rows[0].counter).not.toBeNull();
    } finally {
      await db.drop();
    }
  });
});
