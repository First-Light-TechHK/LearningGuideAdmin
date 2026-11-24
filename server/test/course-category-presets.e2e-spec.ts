import {
  createScratchDatabase,
  type ScratchDatabase,
} from './helpers/migration-db';

/**
 * QA LOW-2: a freshly initialised database must contain the full preset set of
 * top-level course categories.
 *
 * Product requirement and where the list comes from:
 * - PRD v2.0 §9.1 (`docs/Course_Management_PRD_v2.0_CN.docx`): Category is
 *   required and "分类列表由开发预置" — the list itself is preset by
 *   development, not created through an Admin page.
 * - The preset names are Science / Chinese Humanities / European Humanities /
 *   Society. Sources: `client/src/backoffice/lib/categoryLabel.ts` (canonical
 *   names plus their zh-CN labels), migration `20261117000000_catalogue_single_source`
 *   (the same four names in the zh-CN localization table), and the category
 *   single-source design (docs/Course_Category_Single_Source_Design.md §6 M6,
 *   "预置补全：幂等补 Science 一级分类").
 * - Migration `20261101000000_add_course_categories` already says it adds the two
 *   Humanities categories "除 Science 外" and `20261112030000_course_category_society`
 *   adds Society, but no migration or seed ever created Science — a fresh
 *   database therefore showed only three top-level categories.
 *
 * The last preset migration is the one that has to complete this set; these
 * tests build their own throwaway databases (like `course-migrations.e2e-spec.ts`)
 * and never touch the shared one.
 */
jest.setTimeout(120000);

const PRESET_MIGRATION = '20261120000000_course_category_science';

/** Product-required preset top-level categories, in display order. */
const EXPECTED_PRESETS = [
  { name: 'Science', sortOrder: 0, zh: '科学' },
  { name: 'Chinese Humanities', sortOrder: 1, zh: '中国人文' },
  { name: 'European Humanities', sortOrder: 2, zh: '欧洲人文' },
  { name: 'Society', sortOrder: 3, zh: '社会' },
] as const;

interface PresetRow {
  id: string;
  name: string;
  sortOrder: number;
  status: string;
  localized: Record<string, { name: string }>;
}

async function topLevelPresets(db: ScratchDatabase): Promise<PresetRow[]> {
  const { rows } = await db.client.query<PresetRow>(
    `SELECT id, name, "sortOrder", status::text AS status, localized
     FROM "CourseCatalogueEntry"
     WHERE "parentId" IS NULL AND status = 'ACTIVE'
     ORDER BY "sortOrder", name`,
  );
  return rows;
}

interface CategoryRow {
  name: string;
  description: string;
  parentId: string | null;
  status: string;
  sortOrder: number;
  localized: unknown;
}

async function rowById(
  db: ScratchDatabase,
  id: string,
): Promise<CategoryRow | null> {
  const { rows } = await db.client.query<CategoryRow>(
    `SELECT name, description, "parentId", status::text AS status, "sortOrder", localized
     FROM "CourseCatalogueEntry" WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

describe('fresh database: preset top-level categories', () => {
  let db: ScratchDatabase;

  beforeAll(async () => {
    db = await createScratchDatabase();
    await db.applyMigrations();
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('contains exactly the four preset categories in display order', async () => {
    const presets = await topLevelPresets(db);
    expect(presets.map(({ name, sortOrder }) => ({ name, sortOrder }))).toEqual(
      EXPECTED_PRESETS.map(({ name, sortOrder }) => ({ name, sortOrder })),
    );
  });

  it('gives every preset its English and Chinese display name', async () => {
    const presets = await topLevelPresets(db);
    for (const expected of EXPECTED_PRESETS) {
      const row = presets.find((preset) => preset.name === expected.name);
      if (!row) throw new Error(`missing preset ${expected.name}`);
      expect(row.localized).toEqual({
        'en-GB': { name: expected.name },
        'zh-CN': { name: expected.zh },
      });
    }
  });
});

describe('upgrade: existing database with user-created categories', () => {
  let db: ScratchDatabase;
  let mathematicsBefore: Awaited<ReturnType<typeof rowById>>;
  let archivedBefore: Awaited<ReturnType<typeof rowById>>;

  beforeAll(async () => {
    db = await createScratchDatabase();
    // Everything before the preset-completion migration: this is the state a
    // deployed database is in when it upgrades.
    await db.applyMigrations({ before: PRESET_MIGRATION });
    await db.client.query(
      `INSERT INTO "CourseCatalogueEntry"
         (id, name, localized, description, "parentId", status, "sortOrder", "updatedAt")
       VALUES
         ('user-mathematics', 'Mathematics',
          '{"en-GB":{"name":"Mathematics"},"zh-CN":{"name":"数学"}}'::jsonb,
          'Created by the customer', NULL, 'ACTIVE', 5, now()),
         ('user-archived', 'Legacy Electives', '{}'::jsonb, 'No longer offered',
          NULL, 'ARCHIVED', 6, now()),
         ('user-algebra', 'Algebra', '{}'::jsonb, '', 'user-mathematics',
          'ACTIVE', 1, now())`,
    );
    mathematicsBefore = await rowById(db, 'user-mathematics');
    archivedBefore = await rowById(db, 'user-archived');
    await db.applyMigrations({ only: PRESET_MIGRATION });
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('adds the missing Science preset', async () => {
    const presets = await topLevelPresets(db);
    const science = presets.find((preset) => preset.name === 'Science');
    expect(science).toMatchObject({
      name: 'Science',
      sortOrder: 0,
      status: 'ACTIVE',
    });
    expect(science?.localized).toEqual({
      'en-GB': { name: 'Science' },
      'zh-CN': { name: '科学' },
    });
    // The three presets that already existed are kept, not duplicated, and the
    // user-created Mathematics category does not disturb the preset order.
    expect(
      presets
        .map((preset) => preset.name)
        .filter((name) =>
          EXPECTED_PRESETS.some((preset) => preset.name === name),
        ),
    ).toEqual(EXPECTED_PRESETS.map((preset) => preset.name));
  });

  it('leaves every user-created category exactly as it was', async () => {
    expect(await rowById(db, 'user-mathematics')).toEqual(mathematicsBefore);
    expect(await rowById(db, 'user-archived')).toEqual(archivedBefore);
    const algebra = await db.client.query(
      `SELECT "parentId", name FROM "CourseCatalogueEntry" WHERE id = 'user-algebra'`,
    );
    expect(algebra.rows[0]).toEqual({
      parentId: 'user-mathematics',
      name: 'Algebra',
    });
  });

  it('is idempotent: running the migration again changes nothing', async () => {
    const before = await db.client.query(
      `SELECT id, name, description, "parentId", status, "sortOrder", localized
       FROM "CourseCatalogueEntry" ORDER BY id`,
    );
    // applyMigrations({ only }) re-executes the migration SQL.
    await db.applyMigrations({ only: PRESET_MIGRATION });
    const after = await db.client.query(
      `SELECT id, name, description, "parentId", status, "sortOrder", localized
       FROM "CourseCatalogueEntry" ORDER BY id`,
    );
    expect(after.rows).toEqual(before.rows);
  });
});

describe('upgrade: the customer already made a category named science', () => {
  let db: ScratchDatabase;

  beforeAll(async () => {
    db = await createScratchDatabase();
    await db.applyMigrations({ before: PRESET_MIGRATION });
    await db.client.query(
      `INSERT INTO "CourseCatalogueEntry"
         (id, name, localized, description, "parentId", status, "sortOrder", "updatedAt")
       VALUES
         ('user-science', 'science', '{"en-GB":{"name":"science"}}'::jsonb,
          '', NULL, 'ACTIVE', 9, now())`,
    );
    await db.applyMigrations({ only: PRESET_MIGRATION });
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('does not add a second Science or change the existing one', async () => {
    const { rows } = await db.client.query(
      `SELECT id, name, description, "parentId", status::text AS status,
              "sortOrder", localized
       FROM "CourseCatalogueEntry"
       WHERE "parentId" IS NULL AND lower(btrim(name)) = 'science'`,
    );
    expect(rows).toEqual([
      {
        id: 'user-science',
        name: 'science',
        description: '',
        parentId: null,
        status: 'ACTIVE',
        sortOrder: 9,
        localized: { 'en-GB': { name: 'science' } },
      },
    ]);
  });

  it('is idempotent: a second run still leaves a single row', async () => {
    await db.applyMigrations({ only: PRESET_MIGRATION });
    const { rows } = await db.client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "CourseCatalogueEntry"
       WHERE "parentId" IS NULL AND lower(btrim(name)) = 'science'`,
    );
    expect(rows[0].count).toBe(1);
  });
});
