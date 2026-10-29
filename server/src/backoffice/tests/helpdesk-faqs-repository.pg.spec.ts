import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

import type { HelpdeskFaq } from '../modules/helpdesk/faqs/faqContracts';
import {
  FAQ_CANDIDATES_SQL,
  createPgFaqRepository,
  createPgHelpdeskQaSource,
  searchTerms,
  type FaqRepository,
  type SqlDb,
} from '../modules/helpdesk/faqs/faqRepository';

/**
 * PostgreSQL 实测（Tickets v2 §1 / §2）：版本号条件更新、修订与修改同事务、只追加修订、
 * 新建的 Idempotency-Key、已发布过滤、筛选与分页、英文全文（GIN 索引）+ 关键词 + 中文双字 +
 * 同类加权的候选检索。
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
function faq(overrides: Partial<HelpdeskFaq> = {}): HelpdeskFaq {
  counter += 1;
  return {
    id: `0192cccc-0000-7000-8000-${String(counter).padStart(12, '0')}`,
    category: 'account_technical',
    popular: false,
    questionEn: `Question ${counter}`,
    answerEn: 'Answer',
    questionZh: `问题 ${counter}`,
    answerZh: '答案',
    keywords: [],
    status: 'published',
    version: 1,
    createdBy: EMP,
    updatedBy: EMP,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describeDb('Helpdesk FAQ repository (PostgreSQL)', () => {
  const schema = `hdfaq_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let repo: FaqRepository;

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
    repo = createPgFaqRepository(db);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE helpdesk_faq_revisions, helpdesk_faqs, helpdesk_suggestions',
    );
  });

  async function revisionCount(id: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM helpdesk_faq_revisions WHERE faq_id = $1',
      [id],
    );
    return rows[0].n;
  }

  /** 让 updated_at 有确定的先后（同一事务里 now() 相同）。 */
  async function touch(id: string, iso: string) {
    await pool.query('UPDATE helpdesk_faqs SET updated_at = $2 WHERE id = $1', [
      id,
      iso,
    ]);
  }

  it('inserts with a create revision holding the full bilingual snapshot', async () => {
    const { faq: created, created: isNew } = await repo.insert(
      faq({ keywords: ['a', 'b'], popular: true }),
      EMP,
      null,
    );
    expect(isNew).toBe(true);
    expect(created.version).toBe(1);
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const revisions = await repo.revisions(created.id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      faqId: created.id,
      version: 1,
      action: 'create',
      employeeId: EMP,
    });
    expect(revisions[0].snapshot).toMatchObject({
      id: created.id,
      questionEn: created.questionEn,
      answerZh: '答案',
      keywords: ['a', 'b'],
      popular: true,
      status: 'published',
    });
  });

  it('creates once per Idempotency-Key: a retry returns the first row without a second revision', async () => {
    const key = '0192dddd-0000-4000-8000-000000000001';
    const first = await repo.insert(faq(), EMP, key);
    const retry = await repo.insert(faq(), EMP, key);
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.faq.id).toBe(first.faq.id);
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM helpdesk_faqs',
    );
    expect(rows[0].n).toBe(1);
    expect(await revisionCount(first.faq.id)).toBe(1);
  });

  it('updates only WHERE id AND version, bumping the version with a revision in the same transaction', async () => {
    const { faq: created } = await repo.insert(faq(), EMP, null);
    const ok = await repo.update(
      created.id,
      1,
      { questionEn: 'Edited', popular: true },
      'update',
      EMP,
    );
    expect(ok).toMatchObject({
      kind: 'ok',
      value: { questionEn: 'Edited', popular: true, version: 2 },
    });
    const stale = await repo.update(
      created.id,
      1,
      { questionEn: 'Lost' },
      'update',
      EMP,
    );
    expect(stale).toEqual({ kind: 'conflict', currentVersion: 2 });
    expect((await repo.get(created.id))?.questionEn).toBe('Edited');
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
    const { faq: created } = await repo.insert(faq(), EMP, null);
    const results = await Promise.all([
      repo.update(created.id, 1, { questionEn: 'A' }, 'update', EMP),
      repo.update(created.id, 1, { questionEn: 'B' }, 'update', EMP),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual(['conflict', 'ok']);
    expect(await revisionCount(created.id)).toBe(2);
  });

  it('rolls the FAQ back if the revision cannot be written', async () => {
    const { faq: created } = await repo.insert(faq(), EMP, null);
    await expect(
      repo.update(created.id, 1, { questionEn: 'X' }, 'bogus' as never, EMP),
    ).rejects.toThrow();
    const after = await repo.get(created.id);
    expect(after).toMatchObject({
      questionEn: created.questionEn,
      version: 1,
    });
  });

  it('keeps revisions append-only', async () => {
    const { faq: created } = await repo.insert(faq(), EMP, null);
    await expect(
      pool.query("UPDATE helpdesk_faq_revisions SET action = 'update'"),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query('DELETE FROM helpdesk_faq_revisions'),
    ).rejects.toThrow(/append-only/);
    expect(await revisionCount(created.id)).toBe(1);
  });

  it('enforces the table rules (category, status, lengths, keyword count)', async () => {
    for (const bad of [
      faq({ category: 'technical_support' as never }),
      faq({ status: 'draft' as never }),
      faq({ questionEn: 'q'.repeat(201) }),
      faq({ questionZh: '' }),
      faq({ answerEn: 'a'.repeat(4001) }),
      faq({ answerZh: '答'.repeat(4001) }),
      faq({ keywords: Array.from({ length: 21 }, (_, i) => `k${i}`) }),
    ]) {
      await expect(repo.insert(bad, EMP, null)).rejects.toThrow();
    }
  });

  it('lists published FAQs newest first, filters, searches both languages and pages with a total', async () => {
    const pw = (
      await repo.insert(
        faq({ questionEn: 'Reset password', keywords: ['login'] }),
        EMP,
        null,
      )
    ).faq;
    const inv = (
      await repo.insert(
        faq({
          questionEn: 'Invoice',
          questionZh: '发票在哪里',
          keywords: ['receipt'],
          category: 'payments_subscriptions',
          popular: true,
        }),
        EMP,
        null,
      )
    ).faq;
    const gone = (await repo.insert(faq(), EMP, null)).faq;
    await repo.update(gone.id, 1, { status: 'archived' }, 'archive', EMP);
    await touch(pw.id, '2026-10-20T00:00:00Z');
    await touch(inv.id, '2026-10-28T00:00:00Z');

    const all = await repo.list({ offset: 0, limit: 10 });
    expect(all.faqs.map((f) => f.id)).toEqual([inv.id, pw.id]);
    expect(all.total).toBe(2);
    expect(
      (await repo.list({ q: 'RECEIPT', offset: 0, limit: 10 })).faqs.map(
        (f) => f.id,
      ),
    ).toEqual([inv.id]);
    expect(
      (await repo.list({ q: '发票', offset: 0, limit: 10 })).faqs.map(
        (f) => f.id,
      ),
    ).toEqual([inv.id]);
    expect((await repo.list({ q: '100%_', offset: 0, limit: 10 })).total).toBe(
      0,
    );
    expect(
      (
        await repo.list({
          category: 'payments_subscriptions',
          offset: 0,
          limit: 10,
        })
      ).faqs.map((f) => f.id),
    ).toEqual([inv.id]);
    expect(
      (await repo.list({ popular: false, offset: 0, limit: 10 })).faqs.map(
        (f) => f.id,
      ),
    ).toEqual([pw.id]);
    const page2 = await repo.list({ offset: 1, limit: 1 });
    expect(page2.faqs.map((f) => f.id)).toEqual([pw.id]);
    expect(page2.total).toBe(2);
    expect((await repo.list({ offset: 5, limit: 10 })).total).toBe(2);
  });

  it('lists published FAQs for Portal popular first, then newest, with filters and a limit', async () => {
    const a = (await repo.insert(faq(), EMP, null)).faq;
    const b = (await repo.insert(faq({ popular: true }), EMP, null)).faq;
    const c = (await repo.insert(faq({ category: 'other' }), EMP, null)).faq;
    const gone = (await repo.insert(faq({ popular: true }), EMP, null)).faq;
    await repo.update(gone.id, 1, { status: 'archived' }, 'archive', EMP);
    await touch(a.id, '2026-10-01T00:00:00Z');
    await touch(b.id, '2026-09-01T00:00:00Z');
    await touch(c.id, '2026-10-02T00:00:00Z');
    expect((await repo.listPublished({ limit: 50 })).map((f) => f.id)).toEqual([
      b.id,
      c.id,
      a.id,
    ]);
    expect(
      (await repo.listPublished({ popular: true, limit: 50 })).map((f) => f.id),
    ).toEqual([b.id]);
    expect(
      (await repo.listPublished({ category: 'other', limit: 50 })).map(
        (f) => f.id,
      ),
    ).toEqual([c.id]);
    expect(await repo.listPublished({ limit: 1 })).toHaveLength(1);
  });

  it('the real candidate query (FAQ_CANDIDATES_SQL) is served by the English full-text GIN index', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // a realistic library: a few thousand published rows, statistics up to date
      await client.query(
        `INSERT INTO helpdesk_faqs
           (id, category, question_en, answer_en, question_zh, answer_zh, keywords)
         SELECT gen_random_uuid(), 'other',
                'Filler question ' || g, 'Filler answer about topic ' || g,
                '问题' || g, '答案' || g, ARRAY['filler' || g]
           FROM generate_series(1, 3000) AS g`,
      );
      await client.query(
        `INSERT INTO helpdesk_faqs
           (id, category, question_en, answer_en, question_zh, answer_zh, keywords)
         VALUES (gen_random_uuid(), 'account_technical',
                 'How do I reset my password?', 'Use Forgot password.',
                 '如何重置密码？', '点击忘记密码。', ARRAY['password'])`,
      );
      await client.query('ANALYZE helpdesk_faqs');
      await client.query(
        `PREPARE hd_candidates(text, text, text, text, text[], int, text, boolean, text[], text[], int[]) AS ${FAQ_CANDIDATES_SQL}`,
      );
      const terms = searchTerms('how do i reset my password?');
      const args = `'en-GB', 'account_technical', 'password:* | reset:*', 'how do i reset my password?', ARRAY[]::text[], 8, NULL, NULL, ARRAY['password', 'reset'], ARRAY[${terms.typo.keys.map((k) => `'${k}'`).join(', ')}]::text[], ARRAY[${terms.typo.word.join(', ')}]::int[]`;
      const { rows } = await client.query(
        `EXPLAIN EXECUTE hd_candidates(${args})`,
      );
      const plan = rows
        .map((r: Record<string, string>) => r['QUERY PLAN'])
        .join('\n');
      expect(plan).toContain('helpdesk_faqs_search_en_idx');
      const found = await client.query<{ question: string }>(
        `EXECUTE hd_candidates(${args})`,
      );
      expect(found.rows.map((r) => r.question)).toEqual([
        'How do I reset my password?',
      ]);
      // 拼写容错一路：结果对，且谓词（typo_keys && 查询键）是 GIN 索引用得上的写法。
      // 选不选索引看代价（这么小的表、8 个键，规划器常宁可扫描），所以单独用同一谓词看索引可用
      const typo = searchTerms('pasword');
      const typoArgs = `'en-GB', '', '', 'pasword', ARRAY[]::text[], 8, NULL, NULL, ARRAY[]::text[], ARRAY[${typo.typo.keys.map((k) => `'${k}'`).join(', ')}]::text[], ARRAY[${typo.typo.word.join(', ')}]::int[]`;
      const typoFound = await client.query<{ question: string }>(
        `EXECUTE hd_candidates(${typoArgs})`,
      );
      expect(typoFound.rows.map((r) => r.question)).toEqual([
        'How do I reset my password?',
      ]);
      expect(FAQ_CANDIDATES_SQL).toContain('f.typo_keys && $10::text[]');
      await client.query('SET LOCAL enable_seqscan = off');
      const typoPlan = (
        await client.query(
          `EXPLAIN SELECT id FROM helpdesk_faqs WHERE typo_keys && $1::text[]`,
          [['pasword', 'psword']],
        )
      ).rows
        .map((r: Record<string, string>) => r['QUERY PLAN'])
        .join('\n');
      expect(typoPlan).toContain('helpdesk_faqs_typo_keys_idx');
      await client.query('DEALLOCATE hd_candidates');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  describe('candidates (suggest and Help Centre search)', () => {
    let reset: HelpdeskFaq;
    let invoice: HelpdeskFaq;
    let videoTech: HelpdeskFaq;
    let videoCourse: HelpdeskFaq;

    beforeEach(async () => {
      reset = (
        await repo.insert(
          faq({
            questionEn: 'How do I reset my password?',
            answerEn: 'Use **Forgot password** on the sign-in page.',
            questionZh: '如何重置密码？',
            answerZh: '在登录页点击“忘记密码”。',
            keywords: ['password', 'reset', '密码'],
          }),
          EMP,
          null,
        )
      ).faq;
      invoice = (
        await repo.insert(
          faq({
            questionEn: 'Where can I find my invoice?',
            answerEn: 'Invoices are under Account > Orders.',
            questionZh: '在哪里找到发票？',
            answerZh: '发票在账户 > 订单里。',
            keywords: ['invoice', 'receipt'],
            category: 'payments_subscriptions',
          }),
          EMP,
          null,
        )
      ).faq;
      videoTech = (
        await repo.insert(
          faq({
            questionEn: 'Video player problems',
            answerEn: 'Try another browser.',
          }),
          EMP,
          null,
        )
      ).faq;
      videoCourse = (
        await repo.insert(
          faq({
            questionEn: 'Video lesson problems',
            answerEn: 'Tell us which lesson.',
            category: 'courses_learning',
          }),
          EMP,
          null,
        )
      ).faq;
      const archived = (
        await repo.insert(
          faq({ questionEn: 'Password archived', keywords: ['password'] }),
          EMP,
          null,
        )
      ).faq;
      await repo.update(archived.id, 1, { status: 'archived' }, 'archive', EMP);
    });

    const find = (
      locale: string,
      boost: HelpdeskFaq['category'] | null,
      text: string,
      extra: { category?: HelpdeskFaq['category']; popular?: boolean } = {},
    ) => repo.searchPublished({ locale, boost, text, limit: 8, ...extra });

    it('ranks a full-text and keyword match first and returns the locale fields', async () => {
      const found = await find(
        'en-GB',
        'account_technical',
        'I forgot my password and cannot reset it',
      );
      expect(found[0]).toMatchObject({ id: reset.id });
      expect(found.map((c) => c.id)).not.toContain(invoice.id);
      const source = createPgHelpdeskQaSource(repo);
      const [candidate] = await source.findCandidates({
        locale: 'zh-CN',
        category: null,
        text: '忘记密码',
        limit: 8,
      });
      expect(candidate).toMatchObject({
        id: reset.id,
        category: 'account_technical',
        question: '如何重置密码？',
        answer: '在登录页点击“忘记密码”。',
      });
    });

    it('finds matches in other categories, but the boosted category wins a tie', async () => {
      expect(
        (await find('en-GB', 'account_technical', 'invoice please'))[0].id,
      ).toBe(invoice.id);
      expect(
        (await find('en-GB', 'courses_learning', 'video problems')).map(
          (c) => c.id,
        ),
      ).toEqual([videoCourse.id, videoTech.id]);
      expect(
        (await find('en-GB', 'account_technical', 'video problems')).map(
          (c) => c.id,
        ),
      ).toEqual([videoTech.id, videoCourse.id]);
    });

    it('filters by category and popular when asked (Help Centre search)', async () => {
      expect(
        (
          await find('en-GB', null, 'video problems', {
            category: 'courses_learning',
          })
        ).map((c) => c.id),
      ).toEqual([videoCourse.id]);
      expect(
        await find('en-GB', null, 'video problems', { popular: true }),
      ).toEqual([]);
    });

    it('matches a search word inside the question or a keyword (search as you type)', async () => {
      expect((await find('en-GB', null, 'invoi')).map((c) => c.id)).toEqual([
        invoice.id,
      ]);
      expect((await find('en-GB', null, 'receip')).map((c) => c.id)).toEqual([
        invoice.id,
      ]);
    });

    it('never returns archived FAQs', async () => {
      const found = await find(
        'en-GB',
        'account_technical',
        'password archived',
      );
      expect(found.map((c) => c.id)).toEqual([reset.id]);
    });

    it('matches Chinese by keyword and by two-character overlap in question or answer', async () => {
      expect((await find('zh-CN', null, '我忘记了密码'))[0].id).toBe(reset.id);
      expect((await find('zh-CN', null, '怎么重置'))[0].id).toBe(reset.id);
      expect((await find('zh-CN', null, '订单在哪'))[0].id).toBe(invoice.id);
      expect(await find('zh-CN', null, '课程视频')).toEqual([]);
    });

    it('matches Traditional Chinese and Cantonese against the Simplified FAQ text', async () => {
      expect((await find('zh-CN', null, '密碼點樣重設'))[0].id).toBe(reset.id);
      expect((await find('zh-CN', null, '我忘記咗密碼'))[0].id).toBe(reset.id);
      expect((await find('zh-CN', null, '發票喺邊度搵'))[0].id).toBe(
        invoice.id,
      );
      expect((await find('zh-CN', null, '訂單在哪'))[0].id).toBe(invoice.id);
      expect(await find('zh-CN', null, '課程影片')).toEqual([]);
    });

    it('matches Chinese and English whatever the interface language', async () => {
      expect((await find('en-GB', null, '忘记密码'))[0].id).toBe(reset.id);
      expect((await find('zh-CN', null, '我的 invoice 在哪'))[0].id).toBe(
        invoice.id,
      );
      const [candidate] = await createPgHelpdeskQaSource(repo).findCandidates({
        locale: 'zh-CN',
        category: null,
        text: 'reset password',
        limit: 8,
      });
      expect(candidate).toMatchObject({
        id: reset.id,
        question: '如何重置密码？',
      });
    });

    it('tolerates one-letter English typos in question and keyword words', async () => {
      expect(
        (await find('en-GB', null, 'how do i resset my pasword'))[0].id,
      ).toBe(reset.id);
      expect((await find('en-GB', null, 'invoce for june'))[0].id).toBe(
        invoice.id,
      );
      expect((await find('en-GB', null, 'reciept'))[0].id).toBe(invoice.id);
      expect(await find('en-GB', null, 'refund')).toEqual([]);
      const { rows } = await pool.query<{ typo_keys: string[] }>(
        'SELECT typo_keys FROM helpdesk_faqs WHERE id = $1',
        [reset.id],
      );
      expect(rows[0].typo_keys).toEqual(
        expect.arrayContaining(['password', 'pasword', 'reset', 'rese']),
      );
      // 生成列随修改更新
      await repo.update(reset.id, 1, { keywords: ['passcode'] }, 'update', EMP);
      const after = await pool.query<{ typo_keys: string[] }>(
        'SELECT typo_keys FROM helpdesk_faqs WHERE id = $1',
        [reset.id],
      );
      expect(after.rows[0].typo_keys).toEqual(
        expect.arrayContaining(['passcode', 'pascode']),
      );
    });

    it('weights Chinese bigrams by how rare they are, and ignores bigrams almost every FAQ has', async () => {
      for (let i = 0; i < 20; i++) {
        await repo.insert(
          faq({
            questionZh: `其他问题 ${i}`,
            answerZh: '不知道怎么办就联系客服。',
          }),
          EMP,
          null,
        );
      }
      // 「怎么」在 20 / 24 条已发布 FAQ 里：单靠它不算命中
      expect(await find('zh-CN', null, '怎么')).toEqual([]);
      // 稀有的「重置」压过常见的「怎么」
      expect((await find('zh-CN', null, '怎么重置'))[0].id).toBe(reset.id);
    });

    it('returns nothing when nothing matches, and at most the limit', async () => {
      expect(await find('en-GB', null, 'xyzzy plugh')).toEqual([]);
      expect(await find('en-GB', null, '   ')).toEqual([]);
      for (let i = 0; i < 10; i++) {
        await repo.insert(
          faq({ questionEn: `Refund question ${i}`, keywords: ['refund'] }),
          EMP,
          null,
        );
      }
      expect(await find('en-GB', 'other', 'refund')).toHaveLength(8);
    });

    it('treats query text as data, not SQL, LIKE or tsquery syntax', async () => {
      await expect(
        find('en-GB', null, "password' OR 1=1; -- & | ! ( ) :* <-> %_"),
      ).resolves.toEqual([expect.objectContaining({ id: reset.id })]);
    });

    it('reads one published FAQ by id for a chip, never an archived one', async () => {
      const source = createPgHelpdeskQaSource(repo);
      expect(await source.findPublished(invoice.id, 'en-GB')).toMatchObject({
        id: invoice.id,
        question: 'Where can I find my invoice?',
        answer: 'Invoices are under Account > Orders.',
      });
      await repo.update(invoice.id, 1, { status: 'archived' }, 'archive', EMP);
      expect(await source.findPublished(invoice.id, 'en-GB')).toBeNull();
      expect(
        await source.findPublished(
          '0192cccc-0000-7000-8000-ffffffffffff',
          'en-GB',
        ),
      ).toBeNull();
    });
  });
});
