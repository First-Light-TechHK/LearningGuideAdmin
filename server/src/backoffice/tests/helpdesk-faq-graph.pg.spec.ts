import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

import type { HelpdeskQaSource } from '../../contracts/helpdesk-qa';
import { createPgFaqGraphRepository } from '../modules/helpdesk/faqs/faqGraphRepository';
import {
  createFaqGraphService,
  type FaqGraphService,
} from '../modules/helpdesk/faqs/faqGraphService';
import { faqKeySlug } from '../modules/helpdesk/faqs/faqKeys';
import { createHelpdeskQaSource } from '../modules/helpdesk/faqs/faqQaSource';
import { currentRelease } from '../modules/helpdesk/faqs/faqRelease';
import {
  createRetrievalGate,
  type FaqReleaseGate,
  type FaqReleaseGateInput,
} from '../modules/helpdesk/faqs/faqReleaseGate';
import {
  createFaqReleaseService,
  createPgFaqReleaseSource,
  type FaqReleaseService,
} from '../modules/helpdesk/faqs/faqReleaseService';
import {
  createPgFaqRepository,
  type FaqRepository,
  type SqlDb,
} from '../modules/helpdesk/faqs/faqRepository';
import {
  createFaqService,
  type FaqService,
} from '../modules/helpdesk/faqs/faqService';
import type { HelpdeskFaq } from '../modules/helpdesk/faqs/faqContracts';
import { HelpdeskError } from '../modules/helpdesk/portalHelpdeskClient';

/**
 * v5 FAQ 问题树在 PostgreSQL 上（helpdesk-v5-faq-graph-design §2、§2.2、§2.3、§8.1）：
 * 迁移的 key 回填与 SQL / TS slug 一致、边的增改删与修订、同事务的成环拒绝（含并发）、顺序与覆盖文字、
 * 问法与检索、归档前的父节点检查、树视图；发布：冻结（含答案块）、检查与评测门、原子发布、回滚、
 * 历史与差异；运行时的唯一开关（第一版发布之前读工作表，之后只读快照）、屏幕上卡片的子节点优先、
 * Portal 的 faq-release/current（ETag / 304，快照按版本缓存）。
 * 需要 HELPDESK_TEST_DATABASE_URL（本地临时库）；CI 里必须有。每次在独立 schema 里跑迁移。
 */
const url = process.env.HELPDESK_TEST_DATABASE_URL;
if (!url && process.env.CI === 'true')
  throw new Error('HELPDESK_TEST_DATABASE_URL is required when CI=true');
const describeDb = url ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '../../../prisma/migrations');
const GRAPH_MIGRATION = '20261030090000_helpdesk_faq_graph';

function migrationSql(filter: (dir: string) => boolean = () => true): string {
  return readdirSync(MIGRATIONS)
    .filter((dir) => dir.includes('helpdesk') && filter(dir))
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
const staff = { employeeId: EMP };

async function rejects(
  work: Promise<unknown>,
  status: number,
  code: string,
): Promise<HelpdeskError> {
  const error = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HelpdeskError);
  expect(error).toMatchObject({ status, code });
  return error as HelpdeskError;
}

describeDb('FAQ key backfill (migration 20261030090000)', () => {
  const schema = `hdgraphmig_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
    });
    await pool.query(migrationSql((dir) => dir < GRAPH_MIGRATION));
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('backfills a deterministic unique slug for existing rows (oldest first), as answer entries, without touching updated_at', async () => {
    const rows: [string, string, string][] = [
      // [id, question_en, created_at]
      [
        '0192ffff-0000-7000-8000-000000000003',
        'How do I reset my password?',
        '2026-10-03',
      ],
      [
        '0192ffff-0000-7000-8000-000000000001',
        'How do I reset my password?',
        '2026-10-01',
      ],
      // its own slug is what the duplicate above would get as a suffix
      [
        '0192ffff-0000-7000-8000-000000000002',
        'How do I reset my password 2',
        '2026-10-02',
      ],
      ['0192ffff-0000-7000-8000-000000000004', '如何？', '2026-10-04'],
    ];
    for (const [id, question, at] of rows)
      await pool.query(
        `INSERT INTO helpdesk_faqs (id, category, question_en, answer_en, question_zh, answer_zh,
                                    created_at, updated_at)
         VALUES ($1, 'other', $2, 'A', '问', '答', $3, '2026-10-09T00:00:00Z')`,
        [id, question, at],
      );
    await pool.query(
      readFileSync(join(MIGRATIONS, GRAPH_MIGRATION, 'migration.sql'), 'utf8'),
    );
    const { rows: after } = await pool.query<{
      id: string;
      key: string;
      node_type: string;
      entry: boolean;
      updated_at: Date;
    }>(
      'SELECT id, key, node_type, entry, updated_at FROM helpdesk_faqs ORDER BY id',
    );
    expect(after.map((r) => [r.id.slice(-1), r.key])).toEqual([
      ['1', 'how-do-i-reset-my-password'],
      ['2', 'how-do-i-reset-my-password-2'],
      ['3', 'how-do-i-reset-my-password-3'],
      ['4', 'faq'],
    ]);
    expect(after.every((r) => r.node_type === 'answer' && r.entry)).toBe(true);
    expect(
      after.every(
        (r) => r.updated_at.toISOString() === '2026-10-09T00:00:00.000Z',
      ),
    ).toBe(true);
  });
});

describeDb('Helpdesk FAQ question trees and releases (PostgreSQL)', () => {
  const schema = `hdgraph_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let db: SqlDb;
  let repo: FaqRepository;
  let faqs: FaqService;
  let graphService: FaqGraphService;
  let releases: FaqReleaseService;
  let graph: ReturnType<typeof createPgFaqGraphRepository>;
  let gateCalls: FaqReleaseGateInput[];
  let gatePasses: boolean;

  const fakeGate: FaqReleaseGate = {
    evaluate(input) {
      gateCalls.push(input);
      return Promise.resolve({
        kind: 'retrieval',
        passed: gatePasses,
        summary: gatePasses ? 'ok' : 'recall too low',
        ranAt: '2026-10-30T00:00:00.000Z',
        metrics: { recallAt8: gatePasses ? 1 : 0.5 },
        misses: [],
      });
    },
  };

  /** 每个用例一套新的服务（发布来源的缓存不跨用例）。 */
  function wire() {
    graph = createPgFaqGraphRepository(db);
    const source = createPgFaqReleaseSource(graph);
    faqs = createFaqService({
      repository: repo,
      releaseVersion: () => source.publishedVersion(),
      liveParents: (id) => graph.liveParents(id),
    });
    graphService = createFaqGraphService({ graph });
    releases = createFaqReleaseService({ graph, gate: fakeGate });
    const qa: HelpdeskQaSource = createHelpdeskQaSource({
      repository: repo,
      releases: source,
      liveEdges: () => graph.allEdges(),
    });
    return { source, qa };
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
    });
    await pool.query(migrationSql());
    db = sqlDb(pool);
    repo = createPgFaqRepository(db);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE helpdesk_faq_release_nodes, helpdesk_faq_releases, helpdesk_faq_edge_revisions,
                helpdesk_faq_edges, helpdesk_faq_phrasings, helpdesk_faq_revisions, helpdesk_faqs`,
    );
    gateCalls = [];
    gatePasses = true;
    wire();
  });

  let counter = 0;
  async function create(
    fields: Partial<Record<string, unknown>> = {},
  ): Promise<HelpdeskFaq> {
    counter += 1;
    return faqs.create(staff, {
      category: 'payments_subscriptions',
      popular: false,
      questionEn: `Question number ${counter}?`,
      answerEn: `Answer ${counter}.\n\n- step one\n- step two`,
      questionZh: `第${counter}个问题？`,
      answerZh: `答案。\n\n- 第一步\n- 第二步`,
      keywords: [],
      ...fields,
    });
  }

  async function choice(fields: Partial<Record<string, unknown>> = {}) {
    return create({
      type: 'choice',
      answerEn: 'Which of these is it?',
      answerZh: '你遇到的是哪种情况？',
      ...fields,
    });
  }

  async function link(
    parent: HelpdeskFaq,
    child: HelpdeskFaq,
    body: Record<string, unknown> = {},
  ) {
    return (
      await graphService.createEdge(staff, parent.id, {
        childId: child.id,
        ...body,
      })
    ).edge;
  }

  describe('keys and node fields', () => {
    it('derives the key from the English question in SQL exactly as faqKeySlug does', async () => {
      const corpus = [
        ...(
          JSON.parse(
            readFileSync(
              join(__dirname, '../../../eval/helpdesk/faqs.json'),
              'utf8',
            ),
          ) as { faqs: { questionEn: string }[] }
        ).faqs.map((f) => f.questionEn),
        ...(
          JSON.parse(
            readFileSync(
              join(__dirname, 'fixtures/helpdesk-faq-library-sample.json'),
              'utf8',
            ),
          ) as { faqs: { questionEn: string }[] }
        ).faqs.map((f) => f.questionEn),
        "Can't log in — what’s wrong?",
        '  --Hello__World!!  ',
        'Café crème & naïve résumé',
        '如何重置密码？',
        'emoji 😀 test',
        `${'abcdefghij '.repeat(8)}`,
        'Mixed CASE and 123 numbers',
      ];
      const { rows } = await pool.query<{ q: string; slug: string }>(
        'SELECT q, helpdesk_faq_slug(q) AS slug FROM unnest($1::text[]) AS q',
        [corpus],
      );
      for (const row of rows)
        expect([row.q, row.slug]).toEqual([row.q, faqKeySlug(row.q)]);
    });

    it('creates with a derived unique key, keeps a given key, refuses a taken or malformed one', async () => {
      const a = await create({ questionEn: 'Where is my invoice?' });
      const b = await create({ questionEn: 'Where is my invoice?' });
      expect([a.key, b.key]).toEqual([
        'where-is-my-invoice',
        'where-is-my-invoice-2',
      ]);
      expect([a.type, a.entry]).toEqual(['answer', true]);
      const c = await create({ key: 'Payment.Failed_v2' });
      expect(c.key).toBe('payment.failed_v2');
      await rejects(create({ key: 'payment.failed_v2' }), 409, 'FAQ_KEY_TAKEN');
      await rejects(create({ key: '-bad' }), 400, 'INVALID_INPUT');
      // a rename keeps the row; an old BackOffice save without key/type/entry keeps them
      const renamed = await faqs.update(staff, c.id, {
        ...c,
        key: 'payment-failed',
        entry: false,
      });
      expect([renamed.key, renamed.entry, renamed.version]).toEqual([
        'payment-failed',
        false,
        2,
      ]);
      const { key: _k, type: _t, entry: _e, ...old } = renamed;
      void _k;
      void _t;
      void _e;
      const kept = await faqs.update(staff, c.id, { ...old, popular: true });
      expect([kept.key, kept.entry, kept.type]).toEqual([
        'payment-failed',
        false,
        'answer',
      ]);
      await rejects(
        faqs.update(staff, c.id, { ...kept, key: 'where-is-my-invoice' }),
        409,
        'FAQ_KEY_TAKEN',
      );
    });

    it('a choice prompt states no facts: digits or links are refused', async () => {
      await rejects(
        choice({ answerZh: '是哪一种？3 天内' }),
        400,
        'INVALID_INPUT',
      );
      const ok = await choice();
      await rejects(
        faqs.update(staff, ok.id, {
          ...ok,
          answerEn: 'See https://example.com',
        }),
        400,
        'INVALID_INPUT',
      );
    });
  });

  describe('edges (§2.1)', () => {
    it('links with the kind of the parent, appends positions, overrides labels and audits every change', async () => {
      wire();
      const parent = await create();
      const one = await create();
      const two = await create();
      const first = await link(parent, one);
      const second = await link(parent, two, {
        labelEn: 'More?',
        labelZh: '还有吗？',
      });
      expect([first.kind, first.position, second.position]).toEqual([
        'follow_up',
        0,
        1,
      ]);
      expect([second.labelEn, second.labelZh]).toEqual(['More?', '还有吗？']);
      // the same link again: returned as it is, nothing written
      const again = await graphService.createEdge(staff, parent.id, {
        childId: one.id,
      });
      expect(again).toEqual({ edge: first, created: false });
      await rejects(
        graphService.createEdge(staff, parent.id, {
          childId: one.id,
          labelEn: 'Other',
          labelZh: '别的',
        }),
        409,
        'FAQ_EDGE_EXISTS',
      );
      await rejects(
        graphService.createEdge(staff, parent.id, {
          childId: one.id,
          kind: 'option',
        }),
        400,
        'INVALID_INPUT',
      );
      await rejects(
        graphService.createEdge(staff, parent.id, { childId: parent.id }),
        400,
        'INVALID_INPUT',
      );
      await rejects(
        graphService.createEdge(staff, parent.id, {
          childId: (await create()).id,
          labelEn: 'Only English',
        }),
        400,
        'INVALID_INPUT',
      );
      const relabelled = await graphService.updateEdge(staff, first.id, {
        labelEn: 'Retry?',
        labelZh: '重试？',
      });
      expect(relabelled.labelZh).toBe('重试？');
      await graphService.updateEdge(staff, first.id, {
        labelEn: 'Retry?',
        labelZh: '重试？',
      });
      const view = await graphService.edges(parent.id);
      expect(view.children.map((c) => c.label)).toEqual([
        { en: 'Retry?', zh: '重试？' },
        { en: 'More?', zh: '还有吗？' },
      ]);
      expect(
        (await graphService.edges(one.id)).parents.map((p) => p.node?.id),
      ).toEqual([parent.id]);
      expect(await graphService.deleteEdge(staff, second.id)).toMatchObject({
        deleted: true,
      });
      expect(await graphService.deleteEdge(staff, second.id)).toEqual({
        deleted: false,
        edge: null,
      });
      const { revisions } = await graphService.edgeRevisions(parent.id);
      expect(revisions.map((r) => r.action)).toEqual([
        'delete',
        'update',
        'create',
        'create',
      ]);
      expect(revisions[1]).toMatchObject({
        employeeId: EMP,
        before: expect.objectContaining({ labelEn: null }) as unknown,
        after: expect.objectContaining({ labelEn: 'Retry?' }) as unknown,
      });
      await expect(
        pool.query('DELETE FROM helpdesk_faq_edge_revisions'),
      ).rejects.toThrow(/append-only/);
    });

    it('a choice node has options: kind option, labels at most 24 zh / 40 en, at most 4', async () => {
      wire();
      const pay = await choice();
      const kids = await Promise.all([1, 2, 3, 4, 5].map(() => create()));
      await rejects(
        link(pay, kids[0], { labelEn: 'x'.repeat(41), labelZh: '短' }),
        400,
        'INVALID_INPUT',
      );
      for (const kid of kids.slice(0, 4))
        expect(
          (await link(pay, kid, { labelEn: 'Option', labelZh: '选项' })).kind,
        ).toBe('option');
      await rejects(link(pay, kids[4]), 409, 'FAQ_TOO_MANY_CHILDREN');
    });

    it('an answer has at most 6 follow-ups', async () => {
      wire();
      const parent = await create();
      for (let i = 0; i < 6; i++) await link(parent, await create());
      await rejects(link(parent, await create()), 409, 'FAQ_TOO_MANY_CHILDREN');
    });

    it('refuses an edge that would close a cycle (recursive CTE in the same transaction)', async () => {
      wire();
      const [a, b, c] = [await create(), await create(), await create()];
      await link(a, b);
      await link(b, c);
      await rejects(link(c, a), 409, 'FAQ_EDGE_CYCLE');
      await rejects(link(c, b), 409, 'FAQ_EDGE_CYCLE');
      expect((await graphService.edges(c.id)).children).toEqual([]);
    });

    it('two concurrent opposite edges cannot both pass the cycle check', async () => {
      wire();
      for (let round = 0; round < 5; round++) {
        const [a, b] = [await create(), await create()];
        const results = await Promise.allSettled([link(a, b), link(b, a)]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const failed = results.find((r) => r.status === 'rejected');
        expect((failed as PromiseRejectedResult).reason).toMatchObject({
          code: 'FAQ_EDGE_CYCLE',
        });
      }
    });

    it('reorders the children of a parent; a stale list is refused', async () => {
      wire();
      const parent = await create();
      const kids = [await create(), await create(), await create()];
      for (const kid of kids) await link(parent, kid);
      const { children } = await graphService.reorder(staff, parent.id, {
        childIds: [kids[2].id, kids[0].id, kids[1].id],
      });
      expect(children.map((c) => [c.edge.childId, c.edge.position])).toEqual([
        [kids[2].id, 0],
        [kids[0].id, 1],
        [kids[1].id, 2],
      ]);
      await rejects(
        graphService.reorder(staff, parent.id, {
          childIds: [kids[0].id, kids[1].id],
        }),
        409,
        'FAQ_CHILDREN_CHANGED',
      );
      const { revisions } = await graphService.edgeRevisions(parent.id);
      expect(revisions.filter((r) => r.action === 'update')).toHaveLength(3);
    });

    it('refuses to archive a node that live parents still use, listing them; archived nodes cannot be linked', async () => {
      wire();
      const parent = await create({ questionEn: 'Why was my card declined?' });
      const child = await create();
      const edge = await link(parent, child);
      const error = await rejects(
        faqs.archive(staff, child.id, { version: child.version }),
        409,
        'FAQ_HAS_PARENTS',
      );
      expect(error.message).toContain('Why was my card declined?');
      await graphService.deleteEdge(staff, edge.id);
      const archived = await faqs.archive(staff, child.id, {
        version: child.version,
      });
      expect(archived.status).toBe('archived');
      await rejects(link(parent, archived), 409, 'FAQ_ARCHIVED');
    });

    it('an archive racing a new link to the same node cannot leave an archived child with a live parent', async () => {
      wire();
      const parent = await create({ questionEn: 'Why was my card declined?' });
      const child = await create();
      // a link being created in another transaction, as createEdge does: the child row is held FOR SHARE
      const other = await pool.connect();
      try {
        await other.query('BEGIN');
        await other.query(
          'SELECT id FROM helpdesk_faqs WHERE id = ANY ($1::uuid[]) FOR SHARE',
          [[parent.id, child.id]],
        );
        await other.query(
          `INSERT INTO helpdesk_faq_edges (id, parent_id, child_id, kind, position, created_by)
           VALUES (gen_random_uuid(), $1, $2, 'follow_up', 0, NULL)`,
          [parent.id, child.id],
        );
        // the archive checks for parents before the link commits, then has to wait for the row
        const archiving = faqs
          .archive(staff, child.id, { version: child.version })
          .then(
            () => null,
            (error: unknown) => error,
          );
        await new Promise((resolve) => setTimeout(resolve, 150));
        await other.query('COMMIT');
        const refused = await archiving;
        expect(refused).toMatchObject({ status: 409, code: 'FAQ_HAS_PARENTS' });
        expect((refused as { message: string }).message).toContain(
          'Why was my card declined?',
        );
      } finally {
        other.release();
      }
      expect((await repo.get(child.id))?.status).toBe('published');
    });
  });

  describe('phrasings (§2.1)', () => {
    it('adds, dedupes case-insensitively per locale, deletes idempotently, and retrieval finds them', async () => {
      wire();
      const target = await create({
        questionEn: 'What should I do if my payment failed?',
        questionZh: '付款失败怎么办？',
      });
      await create({
        questionEn: 'Where is my invoice?',
        questionZh: '发票在哪里？',
      });
      const added = await graphService.addPhrasing(staff, target.id, {
        locale: 'en-GB',
        text: '  my   card got declined ',
      });
      expect(added).toMatchObject({
        created: true,
        phrasing: {
          text: 'my card got declined',
          source: 'staff',
          locale: 'en-GB',
        },
      });
      expect(
        await graphService.addPhrasing(staff, target.id, {
          locale: 'en-GB',
          text: 'My card got DECLINED',
        }),
      ).toMatchObject({ created: false, phrasing: { id: added.phrasing.id } });
      await graphService.addPhrasing(staff, target.id, {
        locale: 'zh-TW',
        text: '信用卡被拒絕了',
      });
      await rejects(
        graphService.addPhrasing(staff, target.id, {
          locale: 'fr-FR',
          text: 'x',
        }),
        400,
        'INVALID_INPUT',
      );
      // retrieval indexes phrasings: English full text and Chinese bigrams (Traditional too)
      const en = await repo.searchPublished({
        locale: 'en-GB',
        boost: null,
        text: 'declined',
        limit: 8,
      });
      expect(en.map((f) => f.id)).toEqual([target.id]);
      const zh = await repo.searchPublished({
        locale: 'zh-CN',
        boost: null,
        text: '信用卡被拒绝',
        limit: 8,
      });
      expect(zh[0]?.id).toBe(target.id);
      expect((await graphService.phrasings(target.id)).phrasings).toHaveLength(
        2,
      );
      expect(
        await graphService.deletePhrasing(staff, added.phrasing.id),
      ).toEqual({
        deleted: true,
      });
      expect(
        await graphService.deletePhrasing(staff, added.phrasing.id),
      ).toEqual({
        deleted: false,
      });
      expect(
        await repo.searchPublished({
          locale: 'en-GB',
          boost: null,
          text: 'declined',
          limit: 8,
        }),
      ).toEqual([]);
    });
  });

  describe('tree view', () => {
    it('outlines from an entry, shows where a shared node also appears and puts the working checks inline', async () => {
      wire();
      const root = await create({ questionEn: 'Payment help?' });
      const a = await create({ entry: false });
      const b = await create({ entry: false });
      const shared = await create({ questionEn: 'How do I contact support?' });
      const lonely = await create({ entry: false });
      await link(root, a);
      await link(root, b);
      await link(a, shared);
      await link(b, shared);
      const { root: tree, nodes } = await graphService.tree(root.id);
      expect(nodes).toBe(5);
      expect(tree.children.map((c) => c.node.id)).toEqual([a.id, b.id]);
      const underA = tree.children[0].children[0];
      expect(underA).toMatchObject({
        depth: 2,
        parentCount: 2,
        alsoAppearsIn: [expect.objectContaining({ id: b.id })],
        label: { en: 'How do I contact support?' },
      });
      expect(tree.warnings).toEqual([]);
      const orphan = await graphService.tree(lonely.id);
      expect(orphan.root.warnings.map((w) => w.rule)).toEqual(['orphan']);
    });
  });

  describe('releases (§2.2) and the runtime switch', () => {
    it('before the first release the runtime reads the live rows; afterwards only the published snapshot', async () => {
      const { qa, source } = wire();
      const reset = await create({
        category: 'account_technical',
        questionEn: 'How do I reset my password?',
        questionZh: '如何重置密码？',
        answerEn: 'Use **Forgot password**.',
        answerZh: '点击**忘记密码**。',
        keywords: ['password'],
      });
      expect(await source.current()).toBeNull();
      expect(await qa.releaseVersion?.()).toBeNull();
      expect(await currentRelease(source, 'en-GB', undefined)).toEqual({
        kind: 'none',
      });
      expect(
        (
          await qa.findCandidates({
            locale: 'en-GB',
            category: null,
            text: 'password',
            limit: 8,
          })
        )[0],
      ).toMatchObject({
        id: reset.id,
        question: 'How do I reset my password?',
        relation: 'search',
      });

      const { release, created } = await releases.create(staff);
      expect(created).toBe(true);
      expect(release).toMatchObject({
        version: 1,
        status: 'draft',
        publishable: true,
      });
      expect(gateCalls).toHaveLength(1);
      expect(gateCalls[0].snapshot.nodes[0].blocksEn).toEqual([
        { id: 'b1', text: 'Use **Forgot password**.' },
      ]);
      // a draft is not live yet
      expect(await source.current()).toBeNull();
      await releases.publish(staff, 1);
      expect(await qa.releaseVersion?.()).toBe(1);

      // staff edit the working row: learners still see the snapshot until the next release
      await faqs.update(staff, reset.id, {
        ...reset,
        questionEn: 'How do I change my password?',
        keywords: ['password', 'change'],
      });
      const [candidate] = await qa.findCandidates({
        locale: 'en-GB',
        category: null,
        text: 'password',
        limit: 8,
      });
      expect(candidate).toMatchObject({
        id: reset.id,
        question: 'How do I reset my password?',
        blocks: [{ id: 'b1', text: 'Use **Forgot password**.' }],
      });
      expect(
        await qa.findCandidates({
          locale: 'en-GB',
          category: null,
          text: 'change',
          limit: 8,
        }),
      ).toEqual([]);
      expect(await qa.findPublished(reset.id, 'zh-CN')).toMatchObject({
        question: '如何重置密码？',
      });
      // Portal's FAQ list and article read the snapshot too
      const list = await faqs.published({ locale: 'en-GB' });
      expect(list.body.faqs.map((f) => f.question)).toEqual([
        'How do I reset my password?',
      ]);
      expect(
        (await faqs.publishedOne(reset.id, { locale: 'en-GB' })).question,
      ).toBe('How do I reset my password?');
      // and the release endpoint serves it with an ETag
      const current = await currentRelease(source, 'en-GB', undefined);
      expect(current).toMatchObject({
        kind: 'ok',
        etag: '"v1"',
        notModified: false,
      });
      expect(await currentRelease(source, 'en-GB', 'W/"v1"')).toMatchObject({
        notModified: true,
      });
      // the next release picks the edit up
      const next = await releases.create(staff);
      await releases.publish(staff, next.release.version);
      expect((await qa.findPublished(reset.id, 'en-GB'))?.question).toBe(
        'How do I change my password?',
      );
    });

    it('creating again with no change returns the same release; checks failing rejects without running the eval', async () => {
      wire();
      await create();
      const first = await releases.create(staff);
      const again = await releases.create(staff);
      expect(again).toEqual({ release: first.release, created: false });
      await releases.publish(staff, 1);
      expect((await releases.create(staff)).created).toBe(false);

      // an orphan: the checks fail, the release is rejected, the gate never runs
      await create({ entry: false });
      gateCalls = [];
      const bad = await releases.create(staff);
      expect(bad.release).toMatchObject({
        version: 2,
        status: 'rejected',
        publishable: false,
        checks: {
          passed: false,
          problems: [expect.objectContaining({ rule: 'orphan' })],
        },
        evalReport: expect.objectContaining({
          kind: 'skipped',
          passed: false,
        }) as unknown,
      });
      expect(gateCalls).toEqual([]);
      await rejects(releases.publish(staff, 2), 409, 'FAQ_RELEASE_NOT_READY');
      expect((await releases.list()).published).toBe(1);
    });

    it('the eval gate blocks a release; a re-check after the gate passes makes it publishable', async () => {
      wire();
      await create();
      gatePasses = false;
      const { release } = await releases.create(staff);
      expect(release).toMatchObject({ status: 'rejected', publishable: false });
      await rejects(
        releases.publish(staff, release.version),
        409,
        'FAQ_RELEASE_NOT_READY',
      );
      gatePasses = true;
      expect(await releases.check(release.version)).toMatchObject({
        status: 'draft',
        publishable: true,
      });
      const published = await releases.publish(staff, release.version);
      expect(published).toMatchObject({
        status: 'published',
        publishedBy: EMP,
      });
      // publishing again is a no-op
      expect(await releases.publish(staff, release.version)).toEqual(published);
      await rejects(releases.check(release.version), 409, 'FAQ_RELEASE_LOCKED');
    });

    it('publishes atomically: exactly one published row, even when two drafts are published at once', async () => {
      wire();
      const node = await create();
      await releases.create(staff);
      await releases.publish(staff, 1);
      await faqs.update(staff, node.id, { ...node, popular: true });
      const two = (await releases.create(staff)).release.version;
      const latest = await repo.get(node.id);
      await faqs.update(staff, node.id, {
        ...latest!,
        popular: false,
        keywords: ['x'],
      });
      const three = (await releases.create(staff)).release.version;
      const outcomes = await Promise.allSettled([
        releases.publish(staff, two),
        releases.publish(staff, three),
      ]);
      // whichever takes the lock first wins; the other is refused as stale (v2 is older than v3, and
      // v3 was evaluated against v1, not the v2 that went live), never silently made live after it
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const loser = outcomes.find((o) => o.status === 'rejected');
      expect(loser?.reason).toMatchObject({
        status: 409,
        code: 'FAQ_RELEASE_STALE',
      });
      const { rows } = await pool.query<{ version: number; status: string }>(
        'SELECT version, status FROM helpdesk_faq_releases ORDER BY version',
      );
      expect(rows.filter((r) => r.status === 'published')).toHaveLength(1);
      expect(rows.filter((r) => r.status === 'superseded')).toEqual([
        { version: 1, status: 'superseded' },
      ]);
      expect(rows.filter((r) => r.status === 'draft')).toHaveLength(1);
      // the database itself refuses a second published row and any change to a snapshot
      await expect(
        pool.query(`UPDATE helpdesk_faq_releases SET status = 'published', published_at = now()
                     WHERE version = 1`),
      ).rejects.toThrow(/helpdesk_faq_releases_one_published/);
      await expect(
        pool.query(
          `UPDATE helpdesk_faq_releases SET snapshot = '{}'::jsonb WHERE version = 1`,
        ),
      ).rejects.toThrow(/immutable/);
      await expect(
        pool.query('DELETE FROM helpdesk_faq_releases'),
      ).rejects.toThrow(/never deleted/);
    });

    it('refuses a stale draft: one older than the live release, or evaluated against another live release', async () => {
      wire();
      const node = await create();
      await releases.create(staff);
      await releases.publish(staff, 1);
      await faqs.update(staff, node.id, { ...node, popular: true });
      const two = (await releases.create(staff)).release.version;
      const latest = await repo.get(node.id);
      await faqs.update(staff, node.id, {
        ...latest!,
        popular: false,
        keywords: ['x'],
      });
      const three = (await releases.create(staff)).release.version;
      const latest3 = await repo.get(node.id);
      await faqs.update(staff, node.id, { ...latest3!, keywords: ['y'] });
      const four = (await releases.create(staff)).release.version;
      // v2, v3 and v4 were all evaluated against v1
      await releases.publish(staff, three);
      await rejects(releases.publish(staff, two), 409, 'FAQ_RELEASE_STALE');
      const listed = await releases.list();
      const byVersion = new Map(listed.releases.map((r) => [r.version, r]));
      expect(byVersion.get(two)).toMatchObject({
        status: 'draft',
        publishable: false,
      });
      // v4 is newer, but its recall was compared with v1, not with the v3 now live: re-check first
      expect(byVersion.get(four)).toMatchObject({
        status: 'draft',
        publishable: false,
      });
      expect(await releases.get(four)).toMatchObject({ publishable: false });
      await rejects(releases.publish(staff, four), 409, 'FAQ_RELEASE_STALE');
      const rechecked = await releases.check(four);
      expect(rechecked).toMatchObject({ status: 'draft', publishable: true });
      expect(rechecked.evalReport).toMatchObject({ baselineVersion: three });
      expect(await releases.publish(staff, four)).toMatchObject({
        status: 'published',
      });
      // an older draft is never publishable again, and a re-check does not change that
      expect(await releases.check(two)).toMatchObject({ publishable: false });
      await rejects(releases.publish(staff, two), 409, 'FAQ_RELEASE_STALE');
    });

    it('rolls back by publishing an older snapshot as a new version, once', async () => {
      const { qa } = wire();
      const node = await create({ questionEn: 'Original question?' });
      await releases.create(staff);
      await releases.publish(staff, 1);
      await faqs.update(staff, node.id, {
        ...node,
        questionEn: 'Edited question?',
      });
      await releases.create(staff);
      await releases.publish(staff, 2);
      expect((await qa.findPublished(node.id, 'en-GB'))?.question).toBe(
        'Edited question?',
      );
      gateCalls = [];
      const back = await releases.rollback(staff, 1);
      expect(back).toMatchObject({
        created: true,
        release: {
          version: 3,
          status: 'published',
          sourceVersion: 1,
          evalReport: expect.objectContaining({
            kind: 'rollback',
            sourceVersion: 1,
          }) as unknown,
        },
      });
      expect(gateCalls).toEqual([]);
      expect((await qa.findPublished(node.id, 'en-GB'))?.question).toBe(
        'Original question?',
      );
      // the same rollback again changes nothing
      expect(await releases.rollback(staff, 1)).toMatchObject({
        created: false,
        release: { version: 3 },
      });
      const { releases: history } = await releases.list();
      expect(history.map((r) => [r.version, r.status])).toEqual([
        [3, 'published'],
        [2, 'superseded'],
        [1, 'superseded'],
      ]);
      // a draft was never live: it cannot be rolled back to
      await faqs.update(staff, node.id, {
        ...(await repo.get(node.id))!,
        questionEn: 'Third?',
      });
      const draft = await releases.create(staff);
      await rejects(
        releases.rollback(staff, draft.release.version),
        409,
        'FAQ_RELEASE_NOT_PUBLISHED',
      );
      // the diff of the draft against what is live
      const { diff, base, head } = await releases.diff(
        String(draft.release.version),
      );
      expect([base, head]).toEqual([3, 4]);
      expect(diff.nodes.changed).toEqual([
        expect.objectContaining({ id: node.id, fields: ['questionEn'] }),
      ]);
      await rejects(releases.get('7'), 404, 'FAQ_RELEASE_NOT_FOUND');
      await rejects(releases.get('x'), 400, 'INVALID_INPUT');
    });

    it('shows the working copy: checks and the diff against what is live, without writing anything', async () => {
      wire();
      const a = await create();
      await releases.create(staff);
      await releases.publish(staff, 1);
      const b = await create({ entry: false });
      await link(a, b);
      const working = await releases.working();
      expect(working.published).toBe(1);
      expect(working.checks.passed).toBe(true);
      expect(working.diff.nodes.added.map((n) => n.id)).toEqual([b.id]);
      expect(working.diff.edges.added).toEqual([
        expect.objectContaining({ parentId: a.id, childId: b.id, position: 0 }),
      ]);
      expect((await releases.list()).releases).toHaveLength(1);
    });

    it('previews the working copy (or one release) per locale, as Portal reads a release', async () => {
      wire();
      const a = await choice();
      const b = await create({ entry: false });
      const c = await create({ entry: false });
      await link(a, b, { labelEn: 'It failed', labelZh: '付款失败' });
      await link(a, c);
      const zh = await releases.preview('zh-CN');
      expect(zh.source).toBe('working');
      expect(zh.published).toBeNull();
      expect(zh.locale).toBe('zh-CN');
      const prompt = zh.nodes.find((n) => n.id === a.id);
      expect(prompt).toMatchObject({
        type: 'choice',
        answer: '你遇到的是哪种情况？',
        blocks: [],
      });
      expect(zh.nodes.find((n) => n.id === b.id)?.blocks).toEqual([
        { id: 'b1', text: '答案。' },
        { id: 'b2', text: '- 第一步\n- 第二步' },
      ]);
      expect(zh.edges).toEqual([
        {
          parentId: a.id,
          childId: b.id,
          kind: 'option',
          position: 0,
          label: '付款失败',
        },
        {
          parentId: a.id,
          childId: c.id,
          kind: 'option',
          position: 1,
          label: c.questionZh,
        },
      ]);
      expect(
        (await releases.preview('en-GB')).edges.map((e) => e.label),
      ).toEqual(['It failed', c.questionEn]);
      // 一个版本：它的快照（之后的编辑不影响）
      await releases.create(staff);
      await releases.publish(staff, 1);
      await graphService.updateEdge(
        staff,
        (await graphService.edges(a.id)).children[0].edge.id,
        {
          labelEn: 'Card declined',
          labelZh: '卡被拒',
        },
      );
      const v1 = await releases.preview('zh-CN', '1');
      expect(v1.source).toBe(1);
      expect(v1.published).toBe(1);
      expect(v1.edges[0].label).toBe('付款失败');
      expect((await releases.preview('zh-CN')).edges[0].label).toBe('卡被拒');
      await rejects(releases.preview('fr-FR'), 400, 'INVALID_INPUT');
      await rejects(
        releases.preview('zh-CN', '9'),
        404,
        'FAQ_RELEASE_NOT_FOUND',
      );
      expect((await releases.list()).releases).toHaveLength(1);
    });

    it('with a card on screen, its children come first, then matching siblings, then the entry search', async () => {
      const { qa } = wire();
      const pay = await choice({
        questionEn: 'Having trouble with a payment?',
      });
      const failed = await create({
        questionEn: 'What if my payment failed?',
        questionZh: '付款失败怎么办？',
      });
      const pending = await create({
        questionEn: 'Why is my payment pending?',
      });
      const retry = await create({
        entry: false,
        questionEn: 'Can I try another card?',
        answerEn: 'Yes, any card works.',
      });
      const twice = await create({
        entry: false,
        questionEn: 'Will I be charged twice?',
      });
      const other = await create({
        questionEn: 'How do I change my payment card?',
      });
      await link(pay, failed, { labelEn: 'It failed', labelZh: '付款失败' });
      await link(pay, pending, {
        labelEn: 'It is pending',
        labelZh: '还在处理',
      });
      await link(failed, retry);
      await link(failed, twice);
      await releases.create(staff);
      await releases.publish(staff, 1);

      const onFailed = await qa.findCandidates({
        locale: 'en-GB',
        category: null,
        text: 'another card',
        limit: 8,
        nodeId: failed.id,
      });
      expect(onFailed.map((c) => [c.id, c.relation])).toEqual([
        [retry.id, 'child'],
        [twice.id, 'child'],
        [other.id, 'search'],
      ]);
      expect(onFailed[0]).toMatchObject({
        type: 'answer',
        entry: false,
        score: expect.any(Number) as unknown,
      });
      expect(onFailed[0].score).toBeGreaterThan(0);
      expect(onFailed[1].score).toBe(0);

      const onRetry = await qa.findCandidates({
        locale: 'en-GB',
        category: null,
        text: 'charged twice',
        limit: 8,
        nodeId: retry.id,
      });
      expect(onRetry.map((c) => [c.id, c.relation])).toEqual([
        [twice.id, 'sibling'],
      ]);

      // a fresh question: entry answers only, and each knows the choice nodes it is an option of
      const fresh = await qa.findCandidates({
        locale: 'en-GB',
        category: null,
        text: 'payment',
        limit: 8,
      });
      expect(fresh.map((c) => c.id).sort()).toEqual(
        [failed.id, pending.id, other.id].sort(),
      );
      expect(fresh.find((c) => c.id === failed.id)?.optionOf).toEqual([pay.id]);
      const withChoices = await qa.findCandidates({
        locale: 'en-GB',
        category: null,
        text: 'payment',
        limit: 8,
        types: ['answer', 'choice'],
      });
      expect(withChoices.map((c) => c.id)).toContain(pay.id);
    });

    it('with a card on screen, children without a hit take at most the 4 shown slots and the search keeps 4', async () => {
      const { qa } = wire();
      const parent = await create({ questionEn: 'How do I use my account?' });
      const children: HelpdeskFaq[] = [];
      for (let i = 1; i <= 5; i++)
        children.push(
          await create({ entry: false, questionEn: `Side topic ${i}?` }),
        );
      // the 6th follow-up (not shown in Portal: at most 4 chips) does match the new question
      children.push(
        await create({
          entry: false,
          questionEn: 'Where do I find my certificate?',
        }),
      );
      for (const child of children) await link(parent, child);
      const entries: HelpdeskFaq[] = [];
      for (const what of ['download', 'print', 'share', 'rename', 'verify'])
        entries.push(
          await create({ questionEn: `How do I ${what} my certificate?` }),
        );
      await releases.create(staff);
      await releases.publish(staff, 1);

      const found = await qa.findCandidates({
        locale: 'en-GB',
        category: null,
        text: 'certificate',
        limit: 8,
        nodeId: parent.id,
      });
      expect(found).toHaveLength(8);
      // the child that matches comes first, then the first 3 follow-ups the learner sees, then 4 search hits
      expect(found.slice(0, 4).map((c) => [c.id, c.relation])).toEqual([
        [children[5].id, 'child'],
        [children[0].id, 'child'],
        [children[1].id, 'child'],
        [children[2].id, 'child'],
      ]);
      expect(found.slice(4).map((c) => c.relation)).toEqual([
        'search',
        'search',
        'search',
        'search',
      ]);
      expect(
        found.slice(4).every((c) => entries.some((e) => e.id === c.id)),
      ).toBe(true);
      // a follow-up the learner cannot see and that does not match is never a candidate
      expect(found.map((c) => c.id)).not.toContain(children[4].id);
    });

    it('the real retrieval gate searches the snapshot with each entry question and phrasing', async () => {
      wire();
      const node = await create({
        questionEn: 'How do I download my certificate?',
        questionZh: '如何下载证书？',
      });
      await create({
        questionEn: 'Where is my invoice?',
        questionZh: '发票在哪里？',
      });
      await graphService.addPhrasing(staff, node.id, {
        locale: 'zh-TW',
        text: '證書在哪裡下載',
      });
      const gated = createFaqReleaseService({
        graph,
        gate: createRetrievalGate(repo),
      });
      const { release } = await gated.create(staff);
      expect(release.status).toBe('draft');
      expect(release.evalReport).toMatchObject({
        kind: 'retrieval',
        passed: true,
        metrics: { cases: 5, recallAt8: 1 },
        misses: [],
      });
    });

    it('caches the published snapshot by release and reloads it only when another one is published', async () => {
      wire();
      await create();
      await releases.create(staff);
      await releases.publish(staff, 1);
      const reads = jest.spyOn(graph, 'release');
      const source = createPgFaqReleaseSource(graph);
      const first = await source.current();
      const second = await source.current();
      expect(second).toBe(first);
      expect(reads).toHaveBeenCalledTimes(1);
      reads.mockRestore();
    });
  });
});
