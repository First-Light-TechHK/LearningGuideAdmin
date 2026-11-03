import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

import type { SqlDb } from '../modules/helpdesk/faqs/faqRepository';
import { createPgFaqMapRepository } from '../modules/helpdesk/faqs/faqMapRepository';
import { createPgFaqRepository } from '../modules/helpdesk/faqs/faqRepository';
import {
  createFaqReviewService,
  createPgFaqReviewRepository,
} from '../modules/helpdesk/faqs/faqReview';
import { createFaqService } from '../modules/helpdesk/faqs/faqService';
import { HelpdeskError } from '../modules/helpdesk/portalHelpdeskClient';

/**
 * FAQ 逐张审核（owner 2026-10-31）：审核记一行（只追加）；状态按卡的当前版本算，改过回到未审核；
 * 版本不对 409；幂等键回放；队列按状态筛选、带三类计数；历史 = 字段改动 + 位置 + 审核，带显示名。
 * 需要 HELPDESK_TEST_DATABASE_URL（本地临时库）；CI 里必须有。每次在独立 schema 里跑迁移。
 */
const url = process.env.HELPDESK_TEST_DATABASE_URL;
if (!url && process.env.CI === 'true')
  throw new Error('HELPDESK_TEST_DATABASE_URL is required when CI=true');
const describeDb = url ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '../../../prisma/migrations');

function migrationSql(): string {
  return readdirSync(MIGRATIONS)
    .filter((dir) => dir.includes('helpdesk'))
    .sort()
    .map((dir) => readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8'))
    .join('\n');
}

function sqlDb(pool: Pool): SqlDb {
  return {
    query: async (sql, params = []) =>
      (await pool.query<Record<string, unknown>>(sql, params as unknown[]))
        .rows,
    withTransaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const value = await fn(client);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

const EMP = '0192aaaa-0000-7000-8000-000000000001';
const OTHER = '0192aaaa-0000-7000-8000-000000000002';
const KEY = (n: number) =>
  `0192bbbb-0000-7000-8000-${String(n).padStart(12, '0')}`;

async function rejects(
  work: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  const error = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HelpdeskError);
  expect(error).toMatchObject({ status, code });
}

describeDb('FAQ review (PostgreSQL)', () => {
  const schema = `hdfaqreview_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let db: SqlDb;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
    });
    await pool.query(migrationSql());
    // 员工表只取显示名要的两列（真库由员工模块的迁移建）
    await pool.query(
      `CREATE TABLE employees (employee_id UUID PRIMARY KEY, login_email TEXT NOT NULL)`,
    );
    await pool.query(
      `INSERT INTO employees VALUES ($1, 'mia.chan@example.com'), ($2, 'ops@example.com')`,
      [EMP, OTHER],
    );
    db = sqlDb(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE helpdesk_faq_reviews, helpdesk_faq_map_revisions, helpdesk_faq_placements,
                helpdesk_faq_map_nodes, helpdesk_faq_revisions, helpdesk_faqs CASCADE`,
    );
  });

  function services() {
    const faqs = createFaqService({ repository: createPgFaqRepository(db) });
    const reviews = createFaqReviewService({
      reviews: createPgFaqReviewRepository(db, db.withTransaction),
      faqs,
    });
    return { faqs, reviews };
  }

  async function card(n: number, category = 'payments_subscriptions') {
    return services().faqs.create(
      { employeeId: EMP },
      {
        category,
        popular: false,
        questionEn: `How long does refund ${n} take?`,
        answerEn: `Refund ${n} takes 5 working days.`,
        questionZh: `退款${n}要多久？`,
        answerZh: `退款${n}要 5 个工作日。`,
        keywords: [],
      },
    );
  }

  it('records a review on the current version; an edit sends the card back to unreviewed', async () => {
    const { faqs, reviews } = services();
    const faq = await card(1);
    const first = await reviews.review({ employeeId: EMP }, faq.id, {
      status: 'ok',
      version: faq.version,
    });
    expect(first.review).toMatchObject({
      status: 'ok',
      faqVersion: faq.version,
      by: { id: EMP, name: 'mia.chan' },
    });
    expect(first.replayed).toBe(false);

    // 卡改过 → 未审核；旧版本上的审核 409
    const edited = await faqs.update({ employeeId: OTHER }, faq.id, {
      category: faq.category,
      popular: faq.popular,
      questionEn: faq.questionEn,
      answerEn: 'Refund 1 takes 3 to 5 working days.',
      questionZh: faq.questionZh,
      answerZh: faq.answerZh,
      keywords: [],
      version: faq.version,
    });
    const page = await reviews.queue({ status: 'all' });
    expect(page.reviews[faq.id]).toMatchObject({
      status: 'unreviewed',
      faqVersion: faq.version,
    });
    await rejects(
      reviews.review({ employeeId: EMP }, faq.id, {
        status: 'ok',
        version: faq.version,
      }),
      409,
      'VERSION_CONFLICT',
    );
    // 要改必须写原因；原因里的个人信息会被抹掉
    await rejects(
      reviews.review({ employeeId: EMP }, faq.id, {
        status: 'needs_change',
        version: edited.version,
      }),
      400,
      'INVALID_INPUT',
    );
    const second = await reviews.review({ employeeId: EMP }, faq.id, {
      status: 'needs_change',
      note: '英文写 3 到 5 天，中文还是 5 天；联系 mia.chan@example.com',
      version: edited.version,
    });
    expect(second.review.status).toBe('needs_change');
    expect(second.review.note).not.toContain('mia.chan@example.com');
  });

  it('replays with the same Idempotency-Key and refuses the key on another card', async () => {
    const { reviews } = services();
    const a = await card(1);
    const b = await card(2);
    const body = { status: 'ok', version: a.version };
    const one = await reviews.review({ employeeId: EMP }, a.id, body, KEY(1));
    const again = await reviews.review({ employeeId: EMP }, a.id, body, KEY(1));
    expect(again.replayed).toBe(true);
    expect(again.review).toEqual(one.review);
    const rows = await pool.query(
      'SELECT count(*)::int AS n FROM helpdesk_faq_reviews',
    );
    expect((rows.rows[0] as { n: number }).n).toBe(1);
    await rejects(
      reviews.review(
        { employeeId: EMP },
        b.id,
        { status: 'ok', version: b.version },
        KEY(1),
      ),
      400,
      'INVALID_INPUT',
    );
    // 只追加
    await expect(
      pool.query('DELETE FROM helpdesk_faq_reviews'),
    ).rejects.toThrow(/append-only/);
  });

  it('filters the queue by status and counts all three, archived cards left out', async () => {
    const { faqs, reviews } = services();
    const a = await card(1);
    const b = await card(2, 'account_technical');
    const c = await card(3);
    const gone = await card(4);
    await reviews.review({ employeeId: EMP }, a.id, {
      status: 'ok',
      version: a.version,
    });
    await reviews.review({ employeeId: EMP }, b.id, {
      status: 'needs_change',
      note: '步骤少了一步',
      version: b.version,
    });
    await faqs.archive({ employeeId: EMP }, gone.id, { version: gone.version });

    const unreviewed = await reviews.queue({});
    expect(unreviewed.faqs.map((f) => f.id)).toEqual([c.id]);
    expect(unreviewed.counts).toEqual({
      unreviewed: 1,
      ok: 1,
      needs_change: 1,
    });
    expect(unreviewed.total).toBe(1);

    const all = await reviews.queue({ status: 'all', pageSize: '2' });
    expect(all.total).toBe(3);
    expect(all.faqs).toHaveLength(2);
    expect(Object.keys(all.reviews).sort()).toEqual(
      all.faqs.map((f) => f.id).sort(),
    );

    const payments = await reviews.queue({
      status: 'all',
      category: 'payments_subscriptions',
    });
    expect(payments.counts).toEqual({ unreviewed: 1, ok: 1, needs_change: 0 });
    const search = await reviews.queue({ status: 'all', q: '退款2' });
    expect(search.faqs.map((f) => f.id)).toEqual([b.id]);

    await rejects(reviews.queue({ status: 'done' }), 400, 'INVALID_INPUT');
    await rejects(reviews.queue({ category: 'x' }), 400, 'INVALID_INPUT');
    await rejects(
      reviews.queue({ status: ['ok', 'all'] }),
      400,
      'INVALID_INPUT',
    );
  });

  it('builds one timeline: field changes per version, placements and reviews, newest first, with names', async () => {
    const { faqs, reviews } = services();
    const faq = await card(1);
    const map = createPgFaqMapRepository(db);
    const node = (
      key: string,
      kind: 'stage' | 'step',
      parentKey: string | null,
    ) => ({
      key,
      kind,
      parentKey,
      stageKey: null,
      attribute: null,
      position: 0,
      labelEn: key,
      labelZh: key,
    });
    await map.upsertNode(node('refund', 'stage', null), { employeeId: EMP });
    await map.upsertNode(node('refund.request', 'step', 'refund'), {
      employeeId: EMP,
    });
    await map.setPlacements(
      faq.id,
      [{ nodeKey: 'refund.request', primary: true }],
      { employeeId: OTHER },
    );
    const edited = await faqs.update({ employeeId: OTHER }, faq.id, {
      category: faq.category,
      popular: true,
      questionEn: faq.questionEn,
      answerEn: 'Refund 1 takes 3 to 5 working days.',
      questionZh: faq.questionZh,
      answerZh: faq.answerZh,
      keywords: [],
      version: faq.version,
    });
    await reviews.review({ employeeId: EMP }, faq.id, {
      status: 'ok',
      version: edited.version,
    });

    const out = await reviews.history(faq.id);
    expect(out.version).toBe(edited.version);
    expect(out.review.status).toBe('ok');
    expect(out.history.map((h) => h.kind)).toEqual([
      'review',
      'card',
      'placement',
      'card',
    ]);
    const [review, update, placement, create] = out.history;
    expect(review).toMatchObject({ action: 'ok', by: { name: 'mia.chan' } });
    expect(update).toMatchObject({ action: 'update', by: { name: 'ops' } });
    expect(
      update.kind === 'card' && update.changes.map((c) => c.field).sort(),
    ).toEqual(['answerEn', 'popular']);
    expect(
      update.kind === 'card' &&
        update.changes.find((c) => c.field === 'answerEn'),
    ).toEqual({
      field: 'answerEn',
      before: 'Refund 1 takes 5 working days.',
      after: 'Refund 1 takes 3 to 5 working days.',
    });
    expect(placement).toMatchObject({
      action: 'create',
      nodeKey: 'refund.request',
      primary: { before: null, after: true },
    });
    expect(create).toMatchObject({ action: 'create' });
    expect(
      create.kind === 'card' && create.changes.map((c) => c.field),
    ).toContain('answerZh');

    await rejects(reviews.history('nope'), 400, 'INVALID_INPUT');
    await faqs.archive({ employeeId: EMP }, faq.id, {
      version: edited.version,
    });
    await rejects(reviews.history(faq.id), 404, 'FAQ_NOT_FOUND');
  });
});
