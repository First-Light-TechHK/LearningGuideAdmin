import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

import { createPgFaqGraphRepository } from '../modules/helpdesk/faqs/faqGraphRepository';
import { createFaqGraphService } from '../modules/helpdesk/faqs/faqGraphService';
import {
  parseFaqLibrary,
  parseSeedArgs,
  seedExitCode,
  seedFaqLibrary,
  seedIdempotencyKey,
  type SeedDeps,
  type SeedReport,
} from '../modules/helpdesk/faqs/faqLibrarySeed';
import { publicRelease } from '../modules/helpdesk/faqs/faqRelease';
import { createRetrievalGate } from '../modules/helpdesk/faqs/faqReleaseGate';
import {
  createFaqReleaseService,
  createPgFaqReleaseSource,
} from '../modules/helpdesk/faqs/faqReleaseService';
import {
  createPgFaqRepository,
  type SqlDb,
} from '../modules/helpdesk/faqs/faqRepository';
import { createFaqService } from '../modules/helpdesk/faqs/faqService';
import { isUuid } from '../../common/uuidv7';

/**
 * 从 FAQ 库文件导入问题树（graph design §8.2；eval/helpdesk/seed-faq-library.ts 是命令行入口）：
 * 读文件是纯函数（v1 / v2 两种形状）；导入经正常的服务层、按 key 幂等，再建发布版本 v1 并发布。
 * 用仓库里的小样本 fixtures/helpdesk-faq-library-sample.json（不依赖正式库文件）。
 */
const SAMPLE = JSON.parse(
  readFileSync(
    join(__dirname, 'fixtures/helpdesk-faq-library-sample.json'),
    'utf8',
  ),
) as unknown;

describe('FAQ library file (parse, pure)', () => {
  it('reads the v1 and v2 shapes: keys, choice options, inline follow-ups, parentKey, shared nodes, phrasings, signals', () => {
    const library = parseFaqLibrary(SAMPLE);
    expect(library.nodes.map((n) => [n.key, n.type, n.entry])).toEqual([
      // v1 shape: no key, so the key is the slug of the English question
      ['how-do-i-reset-my-password', 'answer', true],
      ['payment-problem', 'choice', true],
      ['payment-failed', 'answer', true],
      // inline follow-up: not an entry unless the file says so
      ['retry-charged-twice', 'answer', false],
      ['paid-not-active', 'answer', true],
      ['contact-support', 'answer', true],
      // parentKey: not an entry
      ['still-not-active', 'answer', false],
    ]);
    expect(library.edges).toEqual([
      {
        parentKey: 'payment-problem',
        childKey: 'payment-failed',
        labelEn: 'The payment failed',
        labelZh: '付款失败',
      },
      {
        parentKey: 'payment-problem',
        childKey: 'paid-not-active',
        labelEn: 'Paid but not active',
        labelZh: '扣款了没开通',
      },
      {
        parentKey: 'payment-failed',
        childKey: 'retry-charged-twice',
        labelEn: null,
        labelZh: null,
      },
      {
        parentKey: 'payment-failed',
        childKey: 'contact-support',
        labelEn: null,
        labelZh: null,
      },
      {
        parentKey: 'paid-not-active',
        childKey: 'contact-support',
        labelEn: null,
        labelZh: null,
      },
      {
        parentKey: 'paid-not-active',
        childKey: 'still-not-active',
        labelEn: 'Still not active?',
        labelZh: '还是没开通？',
      },
    ]);
    const failed = library.nodes.find((n) => n.key === 'payment-failed')!;
    expect(failed.signals).toEqual(['payment_failed']);
    expect(failed.phrasings).toEqual([
      { locale: 'en-GB', text: 'card was declined' },
      { locale: 'zh-TW', text: '付款失敗怎麼辦' },
      { locale: 'zh-CN', text: '扣款失败' },
    ]);
    expect(library.nodes[1].phrasings).toEqual([
      { locale: 'zh-CN', text: '付款出问题了' },
      { locale: 'en-GB', text: 'my payment is not working' },
    ]);
    expect(library.nodes[0]).toMatchObject({
      signals: undefined,
      existingId: '0192f0e0-0000-7000-8000-0000000000aa',
    });
    expect(library.warnings).toEqual([
      'payment-failed: unknown signal not_a_signal skipped',
    ]);
  });

  it('refuses a broken file instead of importing half of it', () => {
    expect(() => parseFaqLibrary({ nope: [] })).toThrow(/list or \{ faqs/);
    expect(() =>
      parseFaqLibrary([
        { questionEn: 'A?', category: 'other', followUps: ['missing'] },
      ]),
    ).toThrow(/no FAQ with key missing/);
    expect(() =>
      parseFaqLibrary([
        { key: 'same', questionEn: 'A?', category: 'other' },
        { key: 'same', questionEn: 'B?', category: 'other' },
      ]),
    ).toThrow(/used by two different FAQs/);
    expect(() =>
      parseFaqLibrary([{ questionEn: 'A?', category: 'nope' }]),
    ).toThrow(/unknown category/);
  });

  it('derives a stable UUID-shaped Idempotency-Key from the key', () => {
    expect(seedIdempotencyKey('payment-failed')).toBe(
      seedIdempotencyKey('payment-failed'),
    );
    expect(seedIdempotencyKey('payment-failed')).not.toBe(
      seedIdempotencyKey('payment-pending'),
    );
    expect(isUuid(seedIdempotencyKey('payment-failed'))).toBe(true);
  });
});

describe('seed command line (eval/helpdesk/seed-faq-library.ts)', () => {
  it('takes the library path, an optional employee id and --no-release', () => {
    expect(parseSeedArgs(['lib.json'])).toEqual({
      ok: true,
      path: 'lib.json',
      employeeId: null,
      release: true,
    });
    expect(
      parseSeedArgs([
        'lib.json',
        '--employee-id',
        '0192aaaa-0000-7000-8000-000000000001',
        '--no-release',
      ]),
    ).toEqual({
      ok: true,
      path: 'lib.json',
      employeeId: '0192aaaa-0000-7000-8000-000000000001',
      release: false,
    });
  });

  it('refuses a missing path, a bad employee id and unknown flags with exit code 2', () => {
    const missing = parseSeedArgs([]);
    expect(missing).toMatchObject({ ok: false, exitCode: 2 });
    expect(Object.keys(missing).sort()).toEqual(['exitCode', 'message', 'ok']);
    expect((missing as { message: string }).message).toContain(
      'Usage: seed-faq-library',
    );
    expect(parseSeedArgs(['lib.json', '--employee-id', 'nope'])).toEqual({
      ok: false,
      exitCode: 2,
      message: '--employee-id must be a UUID',
    });
    expect(parseSeedArgs(['lib.json', '--publish-now'])).toMatchObject({
      ok: false,
      exitCode: 2,
    });
  });

  it('exits 1 when anything was skipped or failed, or the release was not published', () => {
    const clean: SeedReport = {
      nodes: { created: ['a'], updated: [], unchanged: 0, skipped: [] },
      edges: { created: 0, existing: 0, relabelled: 0, failed: [] },
      phrasings: { created: 0, existing: 0, failed: [] },
      release: {
        version: 1,
        status: 'published',
        created: true,
        published: true,
      },
      warnings: [],
    };
    expect(seedExitCode(clean)).toBe(0);
    expect(seedExitCode({ ...clean, release: null })).toBe(0);
    expect(
      seedExitCode({
        ...clean,
        nodes: { ...clean.nodes, skipped: [{ key: 'a', reason: 'archived' }] },
      }),
    ).toBe(1);
    expect(
      seedExitCode({
        ...clean,
        edges: { ...clean.edges, failed: [{ link: 'a → b', reason: 'x' }] },
      }),
    ).toBe(1);
    expect(
      seedExitCode({
        ...clean,
        release: {
          version: 2,
          status: 'rejected',
          created: true,
          published: false,
        },
      }),
    ).toBe(1);
  });
});

const url = process.env.HELPDESK_TEST_DATABASE_URL;
if (!url && process.env.CI === 'true')
  throw new Error('HELPDESK_TEST_DATABASE_URL is required when CI=true');
const describeDb = url ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '../../../prisma/migrations');

describeDb('FAQ library seed (PostgreSQL)', () => {
  const schema = `hdseed_${process.pid}_${Date.now()}`;
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
    await pool.query(
      readdirSync(MIGRATIONS)
        .filter((dir) => dir.includes('helpdesk'))
        .sort()
        .map((dir) =>
          readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8'),
        )
        .join('\n'),
    );
    db = {
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
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE helpdesk_faq_release_nodes, helpdesk_faq_releases, helpdesk_faq_edge_revisions,
                helpdesk_faq_edges, helpdesk_faq_phrasings, helpdesk_faq_revisions, helpdesk_faqs`,
    );
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  function deps(): SeedDeps & {
    source: ReturnType<typeof createPgFaqReleaseSource>;
  } {
    const repository = createPgFaqRepository(db);
    const graph = createPgFaqGraphRepository(db);
    const source = createPgFaqReleaseSource(graph);
    return {
      source,
      faqs: createFaqService({
        repository,
        releaseVersion: () => source.publishedVersion(),
        liveParents: (id) => graph.liveParents(id),
      }),
      repository,
      graph: createFaqGraphService({ graph }),
      // the free retrieval eval over the snapshot, as in production
      releases: createFaqReleaseService({
        graph,
        gate: createRetrievalGate(repository),
      }),
    };
  }

  it('imports the library through the services, publishes release v1, and a second run changes nothing', async () => {
    // an FAQ that existed before the graph: matched by its id, and given the library's key
    await pool.query(
      `INSERT INTO helpdesk_faqs (id, category, question_en, answer_en, question_zh, answer_zh, key)
       VALUES ('0192f0e0-0000-7000-8000-0000000000aa', 'account_technical',
               'How do I reset my password?', 'Old answer.', '如何重置密码？', '旧答案。', 'old-reset')`,
    );
    const library = parseFaqLibrary(SAMPLE);
    const actor = { employeeId: null };
    const first = await seedFaqLibrary(deps(), library, {
      actor,
      release: true,
    });
    expect(first.nodes).toEqual({
      created: [
        'payment-problem',
        'payment-failed',
        'retry-charged-twice',
        'paid-not-active',
        'contact-support',
        'still-not-active',
      ],
      updated: ['how-do-i-reset-my-password'],
      unchanged: 0,
      skipped: [],
    });
    expect(first.edges).toEqual({
      created: 6,
      existing: 0,
      relabelled: 0,
      failed: [],
    });
    expect(first.phrasings).toEqual({ created: 5, existing: 0, failed: [] });
    expect(first.release).toEqual({
      version: 1,
      status: 'published',
      created: true,
      published: true,
    });
    expect(first.warnings).toEqual([
      'payment-failed: unknown signal not_a_signal skipped',
    ]);

    const { source } = deps();
    const release = await source.current();
    const zh = publicRelease(release!, 'zh-CN');
    const byKey = new Map(zh.nodes.map((n) => [n.key, n]));
    expect(byKey.get('how-do-i-reset-my-password')).toMatchObject({
      id: '0192f0e0-0000-7000-8000-0000000000aa',
      answer:
        '1. 在登录页点击**忘记密码**。\n2. 打开我们发送的邮件并设置新密码。',
    });
    const choice = byKey.get('payment-problem')!;
    expect(choice).toMatchObject({ type: 'choice', blocks: [] });
    expect(
      zh.edges
        .filter((e) => e.parentId === choice.id)
        .map((e) => [e.kind, e.position, e.label]),
    ).toEqual([
      ['option', 0, '付款失败'],
      ['option', 1, '扣款了没开通'],
    ]);
    // the shared node has two parents, follow-ups keep the library order
    const support = byKey.get('contact-support')!;
    expect(zh.edges.filter((e) => e.childId === support.id)).toHaveLength(2);
    expect(byKey.get('payment-failed')).toMatchObject({
      signals: ['payment_failed'],
    });
    expect(release!.snapshot.phrasings).toHaveLength(5);

    const second = await seedFaqLibrary(deps(), library, {
      actor,
      release: true,
    });
    expect(second.nodes).toEqual({
      created: [],
      updated: [],
      unchanged: 7,
      skipped: [],
    });
    expect(second.edges).toMatchObject({ created: 0, existing: 6 });
    expect(second.phrasings).toMatchObject({ created: 0, existing: 5 });
    expect(second.release).toEqual({
      version: 1,
      status: 'published',
      created: false,
      published: true,
    });
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM helpdesk_faq_releases',
    );
    expect(rows[0].n).toBe(1);
  });
  it('matches FAQs already in the table under the migration slug key by their English question, instead of duplicating them', async () => {
    // rows from before the graph: the migration gave them the slug of the English question as key
    await pool.query(
      `INSERT INTO helpdesk_faqs (id, category, question_en, answer_en, question_zh, answer_zh, key)
       VALUES ('0192f0e0-0000-7000-8000-0000000000b1', 'payments_subscriptions',
               'What should I do if my payment failed?', 'Old answer.', '付款失败怎么办？', '旧答案。',
               'what-should-i-do-if-my-payment-failed'),
              ('0192f0e0-0000-7000-8000-0000000000b2', 'other',
               '  how do I contact   support? ', 'Old answer.', '如何联系客服？', '旧答案。',
               'how-do-i-contact-support')`,
    );
    const report = await seedFaqLibrary(deps(), parseFaqLibrary(SAMPLE), {
      actor: { employeeId: null },
      release: false,
    });
    expect(report.nodes.created).not.toContain('payment-failed');
    expect(report.nodes.created).not.toContain('contact-support');
    expect(report.nodes.updated).toEqual(
      expect.arrayContaining(['payment-failed', 'contact-support']),
    );
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        'payment-failed: matched the existing FAQ what-should-i-do-if-my-payment-failed by its English question and gave it this key',
        'contact-support: matched the existing FAQ how-do-i-contact-support by its English question and gave it this key',
      ]),
    );
    const { rows } = await pool.query<{ key: string; id: string }>(
      'SELECT key, id FROM helpdesk_faqs ORDER BY key',
    );
    expect(rows).toHaveLength(7);
    expect(rows.find((r) => r.key === 'payment-failed')?.id).toBe(
      '0192f0e0-0000-7000-8000-0000000000b1',
    );
    expect(rows.find((r) => r.key === 'contact-support')?.id).toBe(
      '0192f0e0-0000-7000-8000-0000000000b2',
    );
    // and a second run finds them by key
    const again = await seedFaqLibrary(deps(), parseFaqLibrary(SAMPLE), {
      actor: { employeeId: null },
      release: false,
    });
    expect(again.nodes).toMatchObject({ created: [], updated: [] });
  });

  it('re-seeding a changed library after v1 relabels links, updates answers, adds links and publishes v2', async () => {
    const actor = { employeeId: null };
    const first = await seedFaqLibrary(deps(), parseFaqLibrary(SAMPLE), {
      actor,
      release: true,
    });
    expect(first.release).toMatchObject({ version: 1, published: true });
    const changed = JSON.parse(JSON.stringify(SAMPLE)) as {
      faqs: Record<string, unknown>[];
    };
    const byKey = (key: string) => changed.faqs.find((f) => f.key === key)!;
    const options = byKey('payment-problem').options as Record<
      string,
      unknown
    >[];
    options[0].labelEn = 'Payment did not go through';
    options[0].labelZh = '付款没成功';
    byKey('contact-support').answerEn =
      'Select **Contact Support** at the bottom of any page, or reply to any of our emails.';
    byKey('still-not-active').followUps = ['contact-support'];
    const second = await seedFaqLibrary(deps(), parseFaqLibrary(changed), {
      actor,
      release: true,
    });
    expect(second.nodes).toMatchObject({
      created: [],
      updated: ['contact-support'],
      skipped: [],
    });
    expect(second.edges).toEqual({
      created: 1,
      existing: 5,
      relabelled: 1,
      failed: [],
    });
    expect(second.release).toEqual({
      version: 2,
      status: 'published',
      created: true,
      published: true,
    });
    const release = await deps().source.current();
    const en = publicRelease(release!, 'en-GB');
    const ids = new Map(en.nodes.map((n) => [n.key, n.id]));
    expect(
      en.edges
        .filter((e) => e.parentId === ids.get('payment-problem'))
        .map((e) => e.label),
    ).toEqual(['Payment did not go through', 'Paid but not active']);
    expect(
      en.edges.filter(
        (e) =>
          e.parentId === ids.get('still-not-active') &&
          e.childId === ids.get('contact-support'),
      ),
    ).toHaveLength(1);
  });
});
