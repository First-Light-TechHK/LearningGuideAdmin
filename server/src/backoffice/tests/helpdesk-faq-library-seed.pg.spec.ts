import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

import { createPgFaqGraphRepository } from '../modules/helpdesk/faqs/faqGraphRepository';
import { createFaqGraphService } from '../modules/helpdesk/faqs/faqGraphService';
import {
  parseFaqLibrary,
  parseSeedArgs,
  seedExitCode,
  seedVectorsProblem,
  seedFaqLibrary,
  seedIdempotencyKey,
  syncLibraryPopular,
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
      nodes: {
        created: ['a'],
        updated: [],
        unchanged: 0,
        kept: [],
        skipped: [],
      },
      edges: {
        created: 0,
        existing: 0,
        relabelled: 0,
        removed: 0,
        reordered: 0,
        kept: [],
        failed: [],
      },
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

  it('says so when the new release got no vectors although a vector model is set (2026-11-09: a 429 left only a warning)', () => {
    const built = { release: 1, model: 'baai/bge-m3', embedded: 3 };
    expect(seedVectorsProblem(true, [built])).toBeNull();
    expect(seedVectorsProblem(true, [])).toBeNull();
    // no vector model: nothing to build, nothing wrong
    expect(seedVectorsProblem(false, [null])).toBeNull();
    expect(seedVectorsProblem(true, [built, null])).toContain(
      'npm run helpdesk:faq-vectors',
    );
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
      `TRUNCATE helpdesk_faq_map_revisions, helpdesk_faq_placements, helpdesk_faq_map_nodes,
                helpdesk_faq_release_vectors, helpdesk_faq_embeddings,
                helpdesk_faq_release_nodes, helpdesk_faq_releases, helpdesk_faq_edge_revisions,
                helpdesk_faq_edges, helpdesk_faq_phrasings, helpdesk_faq_reviews, helpdesk_faq_revisions, helpdesk_faqs`,
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
      kept: [],
      skipped: [],
    });
    expect(first.edges).toEqual({
      created: 6,
      existing: 0,
      relabelled: 0,
      removed: 0,
      reordered: 0,
      kept: [],
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
      kept: [],
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
      removed: 0,
      reordered: 0,
      kept: [],
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
  it('keepStaffEdits: a changed library updates the cards still as the seed left them, keeps the ones staff edited, and publishes once', async () => {
    const seed = { employeeId: null };
    await seedFaqLibrary(deps(), parseFaqLibrary(SAMPLE), {
      actor: seed,
      release: true,
    });
    // a staff member edits one card in BackOffice (updatedBy is set)
    const staff = { employeeId: '0192f0e0-0000-7000-8000-00000000e001' };
    const support = (await deps().repository.getByKey('contact-support'))!;
    await deps().faqs.update(staff, support.id, {
      key: support.key,
      category: support.category,
      popular: support.popular,
      questionEn: support.questionEn,
      answerEn: 'Edited in BackOffice.',
      questionZh: support.questionZh,
      answerZh: support.answerZh,
      keywords: support.keywords,
      version: support.version,
    });
    // the library fixes two answers (grounding check), one of them on the edited card
    const fixed = JSON.parse(JSON.stringify(SAMPLE)) as {
      faqs: Record<string, unknown>[];
    };
    const byKey = (key: string) => fixed.faqs.find((f) => f.key === key)!;
    byKey('contact-support').answerEn = 'The library fix.';
    byKey('paid-not-active').answerEn = 'Corrected answer.';
    const library = parseFaqLibrary(fixed);

    const synced = await seedFaqLibrary(deps(), library, {
      actor: seed,
      release: true,
      keepStaffEdits: true,
    });
    expect(synced.nodes).toEqual({
      created: [],
      updated: ['paid-not-active'],
      unchanged: 5,
      kept: ['contact-support'],
      skipped: [],
    });
    expect(synced.release).toEqual({
      version: 2,
      status: 'published',
      created: true,
      published: true,
    });
    expect(
      (await deps().repository.getByKey('contact-support'))!.answerEn,
    ).toBe('Edited in BackOffice.');
    const en = publicRelease((await deps().source.current())!, 'en-GB');
    expect(en.nodes.find((n) => n.key === 'paid-not-active')!.answer).toBe(
      'Corrected answer.',
    );
    expect(en.nodes.find((n) => n.key === 'contact-support')!.answer).toBe(
      'Edited in BackOffice.',
    );
    // the links of a kept card are still there
    expect(
      en.edges.filter(
        (e) =>
          e.childId === en.nodes.find((n) => n.key === 'contact-support')!.id,
      ).length,
    ).toBeGreaterThan(0);

    const again = await seedFaqLibrary(deps(), library, {
      actor: seed,
      release: true,
      keepStaffEdits: true,
    });
    expect(again.nodes).toMatchObject({
      updated: [],
      kept: ['contact-support'],
    });
    expect(again.release).toMatchObject({ version: 2, created: false });
  });

  it("keepStaffEdits: follow-ups follow the library (dropped links go, labels and order follow the file) unless staff changed that card's follow-ups", async () => {
    const seed = { employeeId: null };
    await seedFaqLibrary(deps(), parseFaqLibrary(SAMPLE), {
      actor: seed,
      release: true,
    });
    // a staff member renames one option of payment-problem in BackOffice
    const staff = { employeeId: '0192f0e0-0000-7000-8000-00000000e001' };
    const problem = (await deps().repository.getByKey('payment-problem'))!;
    const { children } = await deps().graph.edges(problem.id);
    await deps().graph.updateEdge(staff, children[1].edge.id, {
      labelEn: 'Staff label',
      labelZh: '员工标签',
    });
    // the library's follow-ups change (grounding check)
    const fixed = JSON.parse(JSON.stringify(SAMPLE)) as {
      faqs: Record<string, unknown>[];
    };
    const byKey = (key: string) => fixed.faqs.find((f) => f.key === key)!;
    const failedCard = byKey('payment-failed');
    const [retry] = failedCard.followUps as unknown[];
    // labelled chip, and the order turns round
    failedCard.followUps = [
      { key: 'contact-support', labelEn: 'Talk to us', labelZh: '联系我们' },
      retry,
    ];
    // contact-support is no longer a follow-up of paid-not-active
    byKey('paid-not-active').followUps = [];
    // still-not-active loses its chip text: the chip shows its question again
    delete byKey('still-not-active').labelEn;
    delete byKey('still-not-active').labelZh;
    // ignored: staff changed payment-problem's options
    (byKey('payment-problem').options as Record<string, unknown>[])[1].labelEn =
      'Charged, plan not active';
    const library = parseFaqLibrary(fixed);

    const synced = await seedFaqLibrary(deps(), library, {
      actor: seed,
      release: true,
      keepStaffEdits: true,
    });
    expect(synced.edges).toEqual({
      created: 0,
      existing: 1,
      relabelled: 2,
      removed: 1,
      reordered: 1,
      kept: ['payment-problem'],
      failed: [],
    });
    expect(synced.release).toMatchObject({ version: 2, published: true });
    const en = publicRelease((await deps().source.current())!, 'en-GB');
    const id = (key: string) => en.nodes.find((n) => n.key === key)!.id;
    const chips = (key: string) =>
      en.edges.filter((e) => e.parentId === id(key)).map((e) => e.label);
    expect(chips('payment-failed')).toEqual([
      'Talk to us',
      en.nodes.find((n) => n.key === 'retry-charged-twice')!.question,
    ]);
    expect(chips('paid-not-active')).toEqual([
      en.nodes.find((n) => n.key === 'still-not-active')!.question,
    ]);
    expect(chips('payment-problem')).toEqual([
      'The payment failed',
      'Staff label',
    ]);

    const again = await seedFaqLibrary(deps(), library, {
      actor: seed,
      release: true,
      keepStaffEdits: true,
    });
    expect(again.edges).toEqual({
      created: 0,
      existing: 3,
      relabelled: 0,
      removed: 0,
      reordered: 0,
      kept: ['payment-problem'],
      failed: [],
    });
    expect(again.release).toMatchObject({ version: 2, created: false });
  });

  it('syncs only the popular flags: BackOffice edits stay, one new release is published, and a second run changes nothing', async () => {
    const actor = { employeeId: null };
    await seedFaqLibrary(deps(), parseFaqLibrary(SAMPLE), {
      actor,
      release: true,
    });
    // edited in BackOffice after the seed: the popular sync must not put the library text back
    const support = (await deps().repository.getByKey('contact-support'))!;
    await deps().faqs.update(actor, support.id, {
      key: support.key,
      category: support.category,
      popular: support.popular,
      questionEn: support.questionEn,
      answerEn: 'Edited in BackOffice.',
      questionZh: support.questionZh,
      answerZh: support.answerZh,
      keywords: support.keywords,
      version: support.version,
    });
    const picked = JSON.parse(JSON.stringify(SAMPLE)) as {
      faqs: Record<string, unknown>[];
    };
    // two picks, in the product's order: contact-support first, then paid-not-active
    for (const faq of picked.faqs) {
      faq.popular =
        faq.key === 'paid-not-active' || faq.key === 'contact-support';
      if (faq.key === 'contact-support') faq.popularRank = 1;
      if (faq.key === 'paid-not-active') faq.popularRank = 2;
    }
    const library = parseFaqLibrary(picked);

    const first = await syncLibraryPopular(deps(), library, {
      actor,
      release: true,
    });
    expect(first).toEqual({
      on: ['paid-not-active', 'contact-support'],
      off: ['how-do-i-reset-my-password'],
      reordered: [],
      missing: [],
      failed: [],
      release: {
        version: 2,
        status: 'published',
        created: true,
        published: true,
      },
    });
    const after = (await deps().repository.getByKey('contact-support'))!;
    expect(after.answerEn).toBe('Edited in BackOffice.');
    expect(after).toMatchObject({ popular: true, popularRank: 1 });
    expect(await deps().repository.getByKey('paid-not-active')).toMatchObject({
      popular: true,
      popularRank: 2,
    });
    const release = await deps().source.current();
    expect(release!.version).toBe(2);
    // the release lists the popular nodes first, in the product's order (Portal's popular chips follow it)
    expect(
      publicRelease(release!, 'en-GB')
        .nodes.filter((n) => n.popular)
        .map((n) => n.key),
    ).toEqual(['contact-support', 'paid-not-active']);
    // and the Help Centre list (release scope) is in the same order
    const listed = await createPgFaqRepository(db).listPublished({
      popular: true,
      limit: 10,
      release: 2,
      entryOnly: false,
    });
    expect(listed.map((f) => f.key)).toEqual([
      'contact-support',
      'paid-not-active',
    ]);

    const again = await syncLibraryPopular(deps(), library, {
      actor,
      release: true,
    });
    expect(again).toEqual({
      on: [],
      off: [],
      reordered: [],
      missing: [],
      failed: [],
      release: null,
    });

    // only the order changes: the two swap places, and one more release is published
    for (const faq of picked.faqs) {
      if (faq.key === 'contact-support') faq.popularRank = 2;
      if (faq.key === 'paid-not-active') faq.popularRank = 1;
    }
    const swapped = await syncLibraryPopular(deps(), parseFaqLibrary(picked), {
      actor,
      release: true,
    });
    expect(swapped).toMatchObject({
      on: [],
      off: [],
      reordered: ['paid-not-active', 'contact-support'],
      release: { version: 3, published: true },
    });
    expect(
      publicRelease((await deps().source.current())!, 'zh-CN')
        .nodes.filter((n) => n.popular)
        .map((n) => n.key),
    ).toEqual(['paid-not-active', 'contact-support']);
  });
});
