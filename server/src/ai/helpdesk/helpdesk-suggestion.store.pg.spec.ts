import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import type { PrismaService } from '../../prisma/prisma.service';
import { uuidv7 } from '../../common/uuidv7';
import { PrismaHelpdeskSuggestionStore } from './helpdesk-suggestion.store';

/**
 * helpdesk_suggestions 实测（Helpdesk addendum §C）：记一行、结果首个为准、
 * Common Questions 计数（shown / solved / declined）、90 天后清空 query_text。
 * 需要 HELPDESK_TEST_DATABASE_URL；未设置时跳过。
 */
const url = process.env.HELPDESK_TEST_DATABASE_URL;
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

  function entry(qaId: string | null) {
    return {
      id: uuidv7(),
      learnerId: 'portal-user-1',
      locale: 'en-GB' as const,
      category: 'technical_support' as const,
      queryText: 'Cannot log in',
      candidateIds: [qa1, qa2],
      qaId,
      model: qaId ? 'test/model' : null,
      latencyMs: 12,
    };
  }

  it('records a suggestion and keeps the first outcome', async () => {
    const row = entry(qa1);
    await store.record(row);
    await expect(store.setOutcome(row.id, 'declined')).resolves.toEqual({
      outcome: 'declined',
      changed: true,
    });
    await expect(store.setOutcome(row.id, 'solved')).resolves.toEqual({
      outcome: 'declined',
      changed: false,
    });
    await expect(store.setOutcome(uuidv7(), 'solved')).resolves.toBeNull();
  });

  it('lets only one of two concurrent outcomes win', async () => {
    const row = entry(qa1);
    await store.record(row);
    const results = await Promise.all([
      store.setOutcome(row.id, 'solved'),
      store.setOutcome(row.id, 'edited'),
    ]);
    expect(results.filter((r) => r?.changed)).toHaveLength(1);
    expect(results[0]?.outcome).toBe(results[1]?.outcome);
  });

  it('counts shown / solved / declined per question', async () => {
    const a = entry(qa2);
    const b = entry(qa2);
    const c = entry(qa2);
    for (const r of [a, b, c, entry(null)]) await store.record(r);
    await store.setOutcome(a.id, 'solved');
    await store.setOutcome(b.id, 'declined');
    await store.setOutcome(c.id, 'edited');
    const stats = await store.statsFor([
      qa2,
      '0192bbbb-0000-7000-8000-0000000000ff',
    ]);
    expect(stats.get(qa2)).toEqual({ shown: 3, solved: 1, declined: 1 });
    expect(stats.has('0192bbbb-0000-7000-8000-0000000000ff')).toBe(false);
    await expect(store.statsFor([])).resolves.toEqual(new Map());
  });

  it('clears query text older than the cut-off and keeps the counters', async () => {
    const old = entry(qa1);
    await store.record(old);
    await admin.query(
      `UPDATE ${schema}.helpdesk_suggestions SET created_at = now() - interval '91 days' WHERE id = $1`,
      [old.id],
    );
    const cleared = await store.purgeQueryText(
      new Date(Date.now() - 90 * 86_400_000),
    );
    expect(cleared).toBeGreaterThanOrEqual(1);
    const { rows } = await admin.query<{
      query_text: string | null;
      qa_id: string;
    }>(
      `SELECT query_text, qa_id FROM ${schema}.helpdesk_suggestions WHERE id = $1`,
      [old.id],
    );
    expect(rows[0]).toEqual({ query_text: null, qa_id: qa1 });
  });
});
