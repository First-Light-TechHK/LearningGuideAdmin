import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import type { PrismaService } from '../../prisma/prisma.service';
import { uuidv7 } from '../../common/uuidv7';
import { PrismaHelpdeskSuggestionStore } from './helpdesk-suggestion.store';

/**
 * helpdesk_suggestions 实测（Helpdesk addendum §C；Tickets v2 §1）：记一行（来源、faq_id、
 * 可空类型）、结果首个为准且必须属于该来源、90 天后清空 query_text。
 * （v1 的 Common Questions 计数随 Common Questions 一起下线。）
 * 需要 HELPDESK_TEST_DATABASE_URL；未设置时跳过。
 */
const url = process.env.HELPDESK_TEST_DATABASE_URL;
// CI 必须真的跑这些用例（.github/workflows/ci.yml 的 postgres 服务）：没给库就失败，不是静默跳过
if (!url && process.env.CI === 'true')
  throw new Error('HELPDESK_TEST_DATABASE_URL is required when CI=true');
const describeDb = url ? describe : describe.skip;
const MIGRATIONS = join(__dirname, '../../../prisma/migrations');

describeDb('PrismaHelpdeskSuggestionStore (PostgreSQL)', () => {
  const schema = `hdsug_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let prisma: PrismaClient;
  let store: PrismaHelpdeskSuggestionStore;
  const qa1 = '0192bbbb-0000-7000-8000-000000000001';
  const qa2 = '0192bbbb-0000-7000-8000-000000000002';

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const sql = readdirSync(MIGRATIONS)
      .filter((dir) => dir.includes('helpdesk'))
      .sort()
      .map((dir) =>
        readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8'),
      )
      .join('\n');
    await admin.query(`SET search_path TO ${schema}; ${sql}`);
    await admin.query('SET search_path TO public');
    const withSchema = new URL(url as string);
    withSchema.searchParams.set('schema', schema);
    prisma = new PrismaClient({
      datasources: { db: { url: withSchema.toString() } },
    });
    store = new PrismaHelpdeskSuggestionStore(
      prisma as unknown as PrismaService,
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  function entry(
    faqId: string | null,
    source: 'submit' | 'chat' | 'chip' = 'submit',
  ) {
    return {
      id: uuidv7(),
      learnerId: 'portal-user-1',
      locale: 'en-GB' as const,
      source,
      category: source === 'submit' ? 'technical_support' : null,
      queryText: 'Cannot log in',
      candidateIds: [qa1, qa2],
      faqId,
      model: faqId ? 'test/model' : null,
      latencyMs: 12,
    };
  }

  it('records a suggestion and keeps the first outcome', async () => {
    const row = entry(qa1);
    await store.record(row);
    await expect(store.setOutcome(row.id, 'declined')).resolves.toEqual({
      kind: 'recorded',
      outcome: 'declined',
      changed: true,
    });
    await expect(store.setOutcome(row.id, 'solved')).resolves.toEqual({
      kind: 'recorded',
      outcome: 'declined',
      changed: false,
    });
    await expect(store.setOutcome(uuidv7(), 'solved')).resolves.toEqual({
      kind: 'not_found',
    });
  });

  it('stores source, faq_id and a null category, and takes chat outcomes', async () => {
    const row = entry(qa2, 'chat');
    await store.record(row);
    const { rows } = await admin.query<{
      source: string;
      faq_id: string;
      category: string | null;
      qa_id: string | null;
    }>(
      `SELECT source, faq_id::text, category, qa_id::text FROM ${schema}.helpdesk_suggestions WHERE id = $1`,
      [row.id],
    );
    expect(rows[0]).toEqual({
      source: 'chat',
      faq_id: qa2,
      category: null,
      qa_id: null,
    });
    await expect(store.setOutcome(row.id, 'helpful')).resolves.toEqual({
      kind: 'recorded',
      outcome: 'helpful',
      changed: true,
    });
    await expect(store.setOutcome(row.id, 'not_helpful')).resolves.toEqual({
      kind: 'recorded',
      outcome: 'helpful',
      changed: false,
    });
  });

  it('refuses an outcome from the other surface and leaves the row alone', async () => {
    const submit = entry(qa1);
    const chip = entry(qa1, 'chip');
    for (const r of [submit, chip]) await store.record(r);
    await expect(store.setOutcome(submit.id, 'helpful')).resolves.toEqual({
      kind: 'wrong_source',
      source: 'submit',
    });
    await expect(store.setOutcome(chip.id, 'solved')).resolves.toEqual({
      kind: 'wrong_source',
      source: 'chip',
    });
    const { rows } = await admin.query<{ outcome: string | null }>(
      `SELECT outcome FROM ${schema}.helpdesk_suggestions WHERE id = ANY($1::uuid[])`,
      [[submit.id, chip.id]],
    );
    expect(rows.map((r) => r.outcome)).toEqual([null, null]);
  });

  it('enforces the source and outcome values in the database', async () => {
    const row = entry(qa1);
    await store.record(row);
    await expect(
      admin.query(
        `UPDATE ${schema}.helpdesk_suggestions SET source = 'email' WHERE id = $1`,
        [row.id],
      ),
    ).rejects.toThrow(/helpdesk_suggestions_source_check/);
    await expect(
      admin.query(
        `UPDATE ${schema}.helpdesk_suggestions SET outcome = 'maybe' WHERE id = $1`,
        [row.id],
      ),
    ).rejects.toThrow(/helpdesk_suggestions_outcome_check/);
  });

  it('lets only one of two concurrent outcomes win', async () => {
    const row = entry(qa1);
    await store.record(row);
    const results = await Promise.all([
      store.setOutcome(row.id, 'solved'),
      store.setOutcome(row.id, 'edited'),
    ]);
    const recorded = results.map((r) =>
      r.kind === 'recorded' ? r : { outcome: null, changed: false },
    );
    expect(recorded.filter((r) => r.changed)).toHaveLength(1);
    expect(recorded[0].outcome).toBe(recorded[1].outcome);
    expect(recorded[0].outcome).not.toBeNull();
  });

  it('clears query text older than the cut-off, keeps recent text and the counters', async () => {
    const old = entry(qa1);
    const recent = { ...entry(qa1), queryText: 'Still within 90 days' };
    const edge = { ...entry(qa2), queryText: 'Exactly 89 days old' };
    for (const r of [old, recent, edge]) await store.record(r);
    await admin.query(
      `UPDATE ${schema}.helpdesk_suggestions SET created_at = now() - interval '91 days' WHERE id = $1`,
      [old.id],
    );
    await admin.query(
      `UPDATE ${schema}.helpdesk_suggestions SET created_at = now() - interval '89 days' WHERE id = $1`,
      [edge.id],
    );
    const cleared = await store.purgeQueryText(
      new Date(Date.now() - 90 * 86_400_000),
    );
    // only the 91-day-old row; every other row in the table is younger than 90 days
    expect(cleared).toBe(1);
    const { rows } = await admin.query<{
      id: string;
      query_text: string | null;
      faq_id: string;
    }>(
      `SELECT id::text, query_text, faq_id::text FROM ${schema}.helpdesk_suggestions WHERE id = ANY($1::uuid[])`,
      [[old.id, recent.id, edge.id]],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(old.id)).toMatchObject({ query_text: null, faq_id: qa1 });
    expect(byId.get(recent.id)).toMatchObject({
      query_text: 'Still within 90 days',
      faq_id: qa1,
    });
    expect(byId.get(edge.id)).toMatchObject({
      query_text: 'Exactly 89 days old',
      faq_id: qa2,
    });
    // a second run finds nothing left to clear
    await expect(
      store.purgeQueryText(new Date(Date.now() - 90 * 86_400_000)),
    ).resolves.toBe(0);
  });
});
