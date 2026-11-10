import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

import * as db from '../lib/db';
import {
  DEMO_CONTENT_MARKER_KEY,
  DEMO_CONTENT_TAG,
  DEMO_MAP_MARKER_KEY,
  DEMO_MAP_TAG,
  DEMO_MARKER_KEY,
  DEMO_POPULAR_MARKER_KEY,
  DEMO_POPULAR_TAG,
  LIBRARY_MARKER_KEY,
  autoSeedLibraryOnce,
  helpdeskBootSeed,
  shouldAutoSeedLibrary,
} from '../modules/helpdesk/demo/helpdeskDemoSeed';
import { DEMO_PREFIX } from '../modules/helpdesk/demo/helpdeskDemo';

/**
 * SIT / UAT 启动时只导卡库（卡片、流程树、发布），不灌演示行。纯函数部分判定哪个环境导什么；
 * PostgreSQL 部分在临时 schema 里真跑一次启动导入。需要 HELPDESK_TEST_DATABASE_URL，没有就跳过（CI=true 时必须给）。
 */
describe('helpdesk FAQ library seed: which environment seeds what', () => {
  const deployed = (APP_ENV?: string, extra: NodeJS.ProcessEnv = {}) => ({
    APP_ENV,
    NODE_ENV: 'production',
    ...extra,
  });

  it('seeds only the library on deployed SIT and UAT by default', () => {
    for (const APP_ENV of ['SIT', 'UAT', ' uat ']) {
      expect(shouldAutoSeedLibrary(deployed(APP_ENV))).toBe(true);
      expect(helpdeskBootSeed(deployed(APP_ENV))).toBe('library');
    }
  });

  it('keeps deployed DEV on the demo path and seeds nothing on PROD, PPE or a missing APP_ENV', () => {
    expect(helpdeskBootSeed(deployed('DEV'))).toBe('demo');
    for (const APP_ENV of ['PROD', 'PPE', '', undefined]) {
      expect(shouldAutoSeedLibrary(deployed(APP_ENV))).toBe(false);
      expect(helpdeskBootSeed(deployed(APP_ENV))).toBeNull();
    }
    // DEV 关掉演示数据就什么都不导（和以前一样）
    expect(
      helpdeskBootSeed(deployed('DEV', { HELPDESK_DEMO_DATA: 'off' })),
    ).toBeNull();
  });

  it('HELPDESK_FAQ_LIBRARY_SEED=on opts any deployed environment in, =off opts SIT and UAT out', () => {
    for (const APP_ENV of ['PROD', 'PPE', undefined])
      expect(
        helpdeskBootSeed(
          deployed(APP_ENV, { HELPDESK_FAQ_LIBRARY_SEED: ' ON ' }),
        ),
      ).toBe('library');
    expect(
      helpdeskBootSeed(
        deployed('DEV', {
          HELPDESK_DEMO_DATA: 'off',
          HELPDESK_FAQ_LIBRARY_SEED: 'on',
        }),
      ),
    ).toBe('library');
    for (const APP_ENV of ['SIT', 'UAT'])
      expect(
        helpdeskBootSeed(
          deployed(APP_ENV, { HELPDESK_FAQ_LIBRARY_SEED: 'off' }),
        ),
      ).toBeNull();
  });

  it('never seeds a local or test run', () => {
    for (const NODE_ENV of ['development', 'test', undefined])
      expect(
        shouldAutoSeedLibrary({
          APP_ENV: 'UAT',
          NODE_ENV,
          HELPDESK_FAQ_LIBRARY_SEED: 'on',
        }),
      ).toBe(false);
  });
});

const url = process.env.HELPDESK_TEST_DATABASE_URL;
if (!url && process.env.CI === 'true')
  throw new Error('HELPDESK_TEST_DATABASE_URL is required when CI=true');
const describeDb = url ? describe : describe.skip;
const MIGRATIONS = join(__dirname, '../../../prisma/migrations');

describeDb('helpdesk FAQ library seed on boot (PostgreSQL)', () => {
  const schema = `hdlib_${process.pid}_${Date.now()}`;
  const saved = {
    url: process.env.DATABASE_URL,
    key: process.env.OPENROUTER_API_KEY,
  };
  let admin: Pool;
  const count = async (table: string, where = 'true') =>
    (
      await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
      )
    )[0].n;
  const marker = async (key: string) =>
    (
      await db.query<{ value: string }>(
        'SELECT value FROM backoffice_settings WHERE key = $1',
        [key],
      )
    )[0]?.value ?? null;
  const logs: string[] = [];
  const logger = {
    log: (message: string) => logs.push(message),
    warn: (message: string) => logs.push(`WARN ${message}`),
  };

  // 连接池在第一次查询时才读 DATABASE_URL：指到一个临时 schema，启动导入走的就是生产那条连接
  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url as string);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    await db.closePool();
    process.env.DATABASE_URL = scoped.toString();
    // 不算向量（不连模型服务）
    delete process.env.OPENROUTER_API_KEY;
    await db.query(
      readdirSync(MIGRATIONS)
        .filter(
          (dir) =>
            dir.includes('helpdesk') || dir.endsWith('backoffice_employees'),
        )
        .sort()
        .map((dir) =>
          readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8'),
        )
        .join('\n'),
    );
  }, 60_000);

  afterAll(async () => {
    await db.closePool();
    process.env.DATABASE_URL = saved.url;
    if (saved.key !== undefined) process.env.OPENROUTER_API_KEY = saved.key;
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('imports cards, the SOP tree and a published release into an empty database, with no demo rows', async () => {
    expect(await autoSeedLibraryOnce(logger)).toBe('seeded');

    const cards = await count('helpdesk_faqs');
    expect(cards).toBeGreaterThan(600);
    expect(await count('helpdesk_faqs', `status = 'published'`)).toBe(cards);
    expect(await count('helpdesk_faqs', 'popular')).toBe(25);
    expect(await count('helpdesk_faq_releases', `status = 'published'`)).toBe(
      1,
    );
    expect(await count('helpdesk_faq_map_nodes')).toBeGreaterThan(0);
    // 卡都挂上了树
    expect(logs.some((line) => line.startsWith('WARN'))).toBe(false);

    // 演示行一条都没有
    for (const table of [
      'helpdesk_faq_reviews',
      'helpdesk_insight_turns',
      'helpdesk_flywheel_runs',
    ])
      expect(await count(table, `id::text LIKE '${DEMO_PREFIX}%'`)).toBe(0);
    expect(await count('helpdesk_faq_candidates')).toBe(0);

    expect(await marker(LIBRARY_MARKER_KEY)).not.toBeNull();
    expect(await marker(DEMO_MARKER_KEY)).toBeNull();
    expect(await marker(DEMO_POPULAR_MARKER_KEY)).toBe(DEMO_POPULAR_TAG);
    expect(await marker(DEMO_CONTENT_MARKER_KEY)).toBe(DEMO_CONTENT_TAG);
    expect(await marker(DEMO_MAP_MARKER_KEY)).toBe(DEMO_MAP_TAG);
  }, 600_000);

  it('does nothing on the next boot', async () => {
    const releases = await count('helpdesk_faq_releases');
    expect(await autoSeedLibraryOnce(logger)).toBe('skipped');
    expect(await count('helpdesk_faq_releases')).toBe(releases);
  }, 120_000);

  it('syncs a new library version on boot and keeps a card staff edited', async () => {
    const [edited] = await db.query<{ id: string; answer_en: string }>(
      `SELECT id, answer_en FROM helpdesk_faqs WHERE popular ORDER BY key LIMIT 1`,
    );
    const [other] = await db.query<{ id: string; answer_en: string }>(
      `SELECT id, answer_en FROM helpdesk_faqs WHERE NOT popular AND id <> $1 ORDER BY key LIMIT 1`,
      [edited.id],
    );
    // 员工在 BackOffice 改过一张卡（updated_by 不为空），另一张卡被谁改乱了（系统写的，没有员工署名）
    await db.query(
      `UPDATE helpdesk_faqs SET answer_en = 'Staff wording', updated_by = '0192aaaa-0000-7000-8000-000000000001' WHERE id = $1`,
      [edited.id],
    );
    await db.query(
      `UPDATE helpdesk_faqs SET answer_en = 'Out of date' WHERE id = $1`,
      [other.id],
    );
    // 下一版库文件：内容标记变了
    await db.query(
      `UPDATE backoffice_settings SET value = 'content-older' WHERE key = $1`,
      [DEMO_CONTENT_MARKER_KEY],
    );

    expect(await autoSeedLibraryOnce(logger)).toBe('synced');
    const answer = async (id: string) =>
      (
        await db.query<{ answer_en: string }>(
          'SELECT answer_en FROM helpdesk_faqs WHERE id = $1',
          [id],
        )
      )[0].answer_en;
    expect(await answer(edited.id)).toBe('Staff wording');
    expect(await answer(other.id)).toBe(other.answer_en);
    expect(await marker(DEMO_CONTENT_MARKER_KEY)).toBe(DEMO_CONTENT_TAG);
    expect(await count('helpdesk_faq_releases', `status = 'published'`)).toBe(
      1,
    );
  }, 600_000);
});
