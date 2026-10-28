import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

import type { HelpdeskQuestion } from '../modules/helpdesk/questions/questionContracts';
import {
  CANDIDATES_SQL,
  createPgQuestionRepository,
  type QuestionRepository,
  type SqlDb,
} from '../modules/helpdesk/questions/questionRepository';

/**
 * PostgreSQL 实测（Helpdesk addendum §A / §C 检索）：版本号条件更新、修订与修改同事务、
 * 已发布过滤、全文 + 关键词 + 同类加权的候选检索。
 * 需要 HELPDESK_TEST_DATABASE_URL（本地临时库）；未设置时跳过。每次在独立 schema 里跑迁移。
 */
const url = process.env.HELPDESK_TEST_DATABASE_URL;
// CI 必须真的跑这些用例（.github/workflows/ci.yml 的 postgres 服务）：没给库就失败，不是静默跳过
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

const EMP = '0192aaaa-0000-7000-8000-000000000001';
let counter = 0;
function row(overrides: Partial<HelpdeskQuestion> = {}): HelpdeskQuestion {
  counter += 1;
  return {
    id: `0192cccc-0000-7000-8000-${String(counter).padStart(12, '0')}`,
    locale: 'en-GB',
    category: 'technical_support',
    question: `Question ${counter}`,
    answer: 'Answer',
    keywords: [],
    status: 'published',
    featured: false,
    sortOrder: counter * 10,
    version: 1,
    createdBy: EMP,
    updatedBy: EMP,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describeDb('Helpdesk questions repository (PostgreSQL)', () => {
  const schema = `hdtest_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let repo: QuestionRepository;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
    });
    await pool.query(migrationSql());
    const db: SqlDb = {
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
    repo = createPgQuestionRepository(db);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE helpdesk_question_revisions, helpdesk_questions, helpdesk_suggestions',
    );
  });

  async function revisionCount(id: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM helpdesk_question_revisions WHERE question_id = $1',
      [id],
    );
    return rows[0].n;
  }

  it('inserts with a create revision holding the snapshot', async () => {
    const created = await repo.insert(row({ keywords: ['a', 'b'] }), EMP);
    expect(created.version).toBe(1);
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const revisions = await repo.revisions(created.id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      questionId: created.id,
      version: 1,
      action: 'create',
      employeeId: EMP,
    });
    expect(revisions[0].snapshot).toMatchObject({
      id: created.id,
      keywords: ['a', 'b'],
      status: 'published',
    });
  });

  it('updates only WHERE id AND version, bumping the version with a revision in the same transaction', async () => {
    const created = await repo.insert(row({ status: 'draft' }), EMP);
    const ok = await repo.update(
      created.id,
      1,
      { question: 'Edited', status: 'published' },
      'publish',
      EMP,
    );
    expect(ok).toMatchObject({
      kind: 'ok',
      value: { question: 'Edited', status: 'published', version: 2 },
    });
    const stale = await repo.update(
      created.id,
      1,
      { question: 'Lost' },
      'update',
      EMP,
    );
    expect(stale).toEqual({ kind: 'conflict', currentVersion: 2 });
    expect((await repo.get(created.id))?.question).toBe('Edited');
    expect(await revisionCount(created.id)).toBe(2);
    expect(
      await repo.update(
        '0192cccc-0000-7000-8000-ffffffffffff',
        1,
        {},
        'update',
        EMP,
      ),
    ).toEqual({ kind: 'not_found' });
  });

  it('lets exactly one of two concurrent writers with the same version win', async () => {
    const created = await repo.insert(row(), EMP);
    const results = await Promise.all([
      repo.update(created.id, 1, { question: 'A' }, 'update', EMP),
      repo.update(created.id, 1, { question: 'B' }, 'update', EMP),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual(['conflict', 'ok']);
    expect(await revisionCount(created.id)).toBe(2);
  });

  it('rolls the question back if the revision cannot be written', async () => {
    const created = await repo.insert(row(), EMP);
    await expect(
      repo.update(created.id, 1, { question: 'X' }, 'bogus' as never, EMP),
    ).rejects.toThrow();
    const after = await repo.get(created.id);
    expect(after).toMatchObject({ question: created.question, version: 1 });
  });

  it('enforces the table rules (locale, category, status, lengths)', async () => {
    for (const bad of [
      row({ locale: 'fr-FR' as never }),
      row({ category: 'account' as never }),
      row({ status: 'deleted' as never }),
      row({ question: 'q'.repeat(201) }),
      row({ answer: 'a'.repeat(4001) }),
    ]) {
      await expect(repo.insert(bad, EMP)).rejects.toThrow();
    }
  });

  it('reorders all-or-nothing', async () => {
    const a = await repo.insert(row({ sortOrder: 10 }), EMP);
    const b = await repo.insert(row({ sortOrder: 20 }), EMP);
    const conflict = await repo.reorder(
      [
        { id: b.id, version: 1 },
        { id: a.id, version: 7 },
      ],
      EMP,
    );
    expect(conflict.kind).toBe('conflict');
    expect((await repo.get(b.id))?.sortOrder).toBe(20);
    const ok = await repo.reorder(
      [
        { id: b.id, version: 1 },
        { id: a.id, version: 1 },
      ],
      EMP,
    );
    expect(ok.kind).toBe('ok');
    expect((await repo.get(b.id))?.sortOrder).toBe(10);
    expect((await repo.get(a.id))?.sortOrder).toBe(20);
    expect(await revisionCount(b.id)).toBe(2);
  });

  it('lists published questions of one locale by sort order, optionally featured only', async () => {
    const second = await repo.insert(
      row({ sortOrder: 20, featured: true }),
      EMP,
    );
    const first = await repo.insert(row({ sortOrder: 10 }), EMP);
    await repo.insert(row({ status: 'draft', featured: true }), EMP);
    await repo.insert(row({ status: 'archived', featured: true }), EMP);
    await repo.insert(row({ locale: 'zh-CN', featured: true }), EMP);
    expect((await repo.listPublished('en-GB', false)).map((q) => q.id)).toEqual(
      [first.id, second.id],
    );
    expect((await repo.listPublished('en-GB', true)).map((q) => q.id)).toEqual([
      second.id,
    ]);
  });

  it('filters the employee list and searches question, answer and keywords', async () => {
    const pw = await repo.insert(
      row({ question: 'Reset password', status: 'draft' }),
      EMP,
    );
    const inv = await repo.insert(
      row({
        question: 'Invoice',
        keywords: ['receipt'],
        category: 'payments_subscriptions',
      }),
      EMP,
    );
    await repo.insert(row({ status: 'archived' }), EMP);
    const all = ['draft', 'published', 'archived'] as const;
    expect(
      (await repo.list({ statuses: ['draft', 'published'] })).map((q) => q.id),
    ).toEqual([pw.id, inv.id]);
    expect(
      (await repo.list({ statuses: [...all], q: 'RECEIPT' })).map((q) => q.id),
    ).toEqual([inv.id]);
    expect(
      (
        await repo.list({
          statuses: [...all],
          category: 'payments_subscriptions',
        })
      ).map((q) => q.id),
    ).toEqual([inv.id]);
    expect(await repo.nextSortOrder('en-GB')).toBeGreaterThan(30);
    expect(await repo.nextSortOrder('zh-CN')).toBe(10);
  });

  it('the real candidate query (CANDIDATES_SQL) is served by the full-text GIN index', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // a realistic library: a few thousand published rows, statistics up to date
      await client.query(
        `INSERT INTO helpdesk_questions
           (id, locale, category, question, answer, keywords, status, sort_order)
         SELECT gen_random_uuid(), 'en-GB', 'other',
                'Filler question ' || g, 'Filler answer about topic ' || g,
                ARRAY['filler' || g], 'published', g
           FROM generate_series(1, 3000) AS g`,
      );
      await client.query(
        `INSERT INTO helpdesk_questions
           (id, locale, category, question, answer, keywords, status, sort_order)
         VALUES (gen_random_uuid(), 'en-GB', 'technical_support',
                 'How do I reset my password?', 'Use Forgot password.',
                 ARRAY['password'], 'published', 1)`,
      );
      await client.query('ANALYZE helpdesk_questions');
      await client.query(
        `PREPARE hd_candidates(text, text, text, text, text[], int) AS ${CANDIDATES_SQL}`,
      );
      const args = `'en-GB', 'technical_support', 'password | reset', 'How do I reset my password?', ARRAY[]::text[], 8`;
      const { rows } = await client.query(
        `EXPLAIN EXECUTE hd_candidates(${args})`,
      );
      const plan = rows
        .map((r: Record<string, string>) => r['QUERY PLAN'])
        .join('\n');
      expect(plan).toContain('helpdesk_questions_search_idx');
      const found = await client.query<{ question: string }>(
        `EXECUTE hd_candidates(${args})`,
      );
      expect(found.rows.map((r) => r.question)).toEqual([
        'How do I reset my password?',
      ]);
      await client.query('DEALLOCATE hd_candidates');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  describe('suggestion candidates', () => {
    let reset: HelpdeskQuestion;
    let invoice: HelpdeskQuestion;
    let videoTech: HelpdeskQuestion;
    let videoCourse: HelpdeskQuestion;
    let zh: HelpdeskQuestion;

    beforeEach(async () => {
      reset = await repo.insert(
        row({
          question: 'How do I reset my password?',
          answer: 'Use Forgot password on the sign-in page.',
          keywords: ['password', 'reset'],
        }),
        EMP,
      );
      invoice = await repo.insert(
        row({
          question: 'Where can I find my invoice?',
          answer: 'Invoices are under Account > Orders.',
          keywords: ['invoice', 'receipt'],
          category: 'payments_subscriptions',
        }),
        EMP,
      );
      videoTech = await repo.insert(
        row({
          question: 'Video player problems',
          answer: 'Try another browser.',
        }),
        EMP,
      );
      videoCourse = await repo.insert(
        row({
          question: 'Video lesson problems',
          answer: 'Tell us which lesson.',
          category: 'course_content',
        }),
        EMP,
      );
      zh = await repo.insert(
        row({
          locale: 'zh-CN',
          question: '如何重置密码？',
          answer: '在登录页点击“忘记密码”。',
          keywords: ['重置密码', '密码'],
        }),
        EMP,
      );
      await repo.insert(
        row({
          question: 'Password draft',
          keywords: ['password'],
          status: 'draft',
        }),
        EMP,
      );
    });

    const find = (locale: string, category: string, text: string) =>
      repo.searchCandidates({ locale, category, text, limit: 8 });

    it('ranks a full-text and keyword match first', async () => {
      const found = await find(
        'en-GB',
        'technical_support',
        'I forgot my password and cannot reset it',
      );
      expect(found[0]).toMatchObject({
        id: reset.id,
        question: reset.question,
        answer: reset.answer,
        category: 'technical_support',
      });
      expect(found.map((c) => c.id)).not.toContain(invoice.id);
    });

    it('finds matches in other categories, but the same category wins a tie', async () => {
      expect(
        (await find('en-GB', 'technical_support', 'invoice please'))[0].id,
      ).toBe(invoice.id);
      expect(
        (await find('en-GB', 'course_content', 'video problems')).map(
          (c) => c.id,
        ),
      ).toEqual([videoCourse.id, videoTech.id]);
      expect(
        (await find('en-GB', 'technical_support', 'video problems')).map(
          (c) => c.id,
        ),
      ).toEqual([videoTech.id, videoCourse.id]);
    });

    it('never returns drafts, archived questions or other locales', async () => {
      const found = await find(
        'en-GB',
        'technical_support',
        'password draft 如何重置密码',
      );
      expect(found.map((c) => c.id)).toEqual([reset.id]);
    });

    it('matches Chinese by keyword and by two-character overlap', async () => {
      expect((await find('zh-CN', 'other', '我忘记了密码'))[0].id).toBe(zh.id);
      expect((await find('zh-CN', 'other', '怎么重置'))[0].id).toBe(zh.id);
      expect(await find('zh-CN', 'other', '课程视频')).toEqual([]);
    });

    it('returns nothing when nothing matches, and at most the limit', async () => {
      expect(await find('en-GB', 'technical_support', 'xyzzy plugh')).toEqual(
        [],
      );
      expect(await find('en-GB', 'technical_support', '   ')).toEqual([]);
      for (let i = 0; i < 10; i++) {
        await repo.insert(
          row({ question: `Refund question ${i}`, keywords: ['refund'] }),
          EMP,
        );
      }
      expect(await find('en-GB', 'other', 'refund')).toHaveLength(8);
    });

    it('treats query text as data, not SQL or tsquery syntax', async () => {
      await expect(
        find('en-GB', 'other', "password' OR 1=1; -- & | ! ( ) :* <->"),
      ).resolves.toEqual([expect.objectContaining({ id: reset.id })]);
    });
  });
});
