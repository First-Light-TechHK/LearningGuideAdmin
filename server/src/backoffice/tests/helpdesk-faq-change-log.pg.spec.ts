import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

import type { FaqChangePerson } from '../modules/helpdesk/faqs/faqChangeLog';
import { createPgFaqChangeLogRepository } from '../modules/helpdesk/faqs/faqChangeLogRepository';
import {
  createFaqChangeLogService,
  type FaqChangeLogService,
} from '../modules/helpdesk/faqs/faqChangeLogService';
import type { HelpdeskFaq } from '../modules/helpdesk/faqs/faqContracts';
import { createPgFaqGraphRepository } from '../modules/helpdesk/faqs/faqGraphRepository';
import {
  createFaqGraphService,
  type FaqGraphService,
} from '../modules/helpdesk/faqs/faqGraphService';
import {
  createFaqReleaseService,
  createPgFaqReleaseSource,
  type FaqReleaseService,
} from '../modules/helpdesk/faqs/faqReleaseService';
import type { FaqReleaseGate } from '../modules/helpdesk/faqs/faqReleaseGate';
import {
  createPgFaqRepository,
  type SqlDb,
} from '../modules/helpdesk/faqs/faqRepository';
import {
  createFaqService,
  type FaqService,
} from '../modules/helpdesk/faqs/faqService';
import { HelpdeskError } from '../modules/helpdesk/portalHelpdeskClient';

/**
 * BackOffice Change Log 在 PostgreSQL 上（Figma 草案 2.6–2.9，用户 2026-10-30）：每一种改动都留下
 * 谁 / 何时 / 改了什么（改前改后）——FAQ 新建、修改、归档；追问与选项的连上、改文字、排序、移除；
 * 问法的加与删（新表，同一事务，只追加，迁移补齐已有的）；版本的新建、发布、回滚。
 * 筛选（类型、人、时间、搜索）与翻页；「学员是否已看到」与「随 vN 上线」；一条 FAQ 的历史。
 * 需要 HELPDESK_TEST_DATABASE_URL；CI 里必须有。每次在独立 schema 里跑迁移。
 */
const url = process.env.HELPDESK_TEST_DATABASE_URL;
if (!url && process.env.CI === 'true')
  throw new Error('HELPDESK_TEST_DATABASE_URL is required when CI=true');
const describeDb = url ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '../../../prisma/migrations');
const PHRASING_MIGRATION = '20261103000000_helpdesk_faq_phrasing_revisions';

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

const OLIVIA = '0192aaaa-0000-7000-8000-000000000001';
const MARCO = '0192aaaa-0000-7000-8000-000000000002';
const olivia = { employeeId: OLIVIA };
const marco = { employeeId: MARCO };
const PEOPLE: Record<string, FaqChangePerson> = {
  [OLIVIA]: {
    id: OLIVIA,
    name: 'olivia.chen',
    role: 'OPERATION_ADMIN',
    email: 'olivia.chen@example.com',
  },
  [MARCO]: {
    id: MARCO,
    name: 'marco.li',
    role: 'ADMIN',
    email: 'marco.li@example.com',
  },
};

const passingGate: FaqReleaseGate = {
  evaluate: () =>
    Promise.resolve({
      kind: 'retrieval',
      passed: true,
      summary: 'ok',
      ranAt: '2026-10-30T00:00:00.000Z',
      metrics: { recallAt8: 1 },
      misses: [],
    }),
};

/** 让相邻两次写入的时间戳一定不同（排序与「冻结于之后」都按时间）。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

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

describeDb('phrasing revisions backfill (migration 20261103000000)', () => {
  const schema = `hdphrmig_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
    });
    await pool.query(migrationSql((dir) => dir < PHRASING_MIGRATION));
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('adds one "added" row per existing phrasing with its own author and time', async () => {
    const faq = '0192ffff-0000-7000-8000-000000000001';
    await pool.query(
      `INSERT INTO helpdesk_faqs (id, key, category, question_en, answer_en, question_zh, answer_zh)
       VALUES ($1, 'reset', 'other', 'How do I reset?', 'A', '问', '答')`,
      [faq],
    );
    await pool.query(
      `INSERT INTO helpdesk_faq_phrasings (id, faq_id, locale, text, search_text, source, created_by, created_at)
       VALUES ('0192ffff-0000-7000-8000-0000000000a1', $1, 'en-GB', 'forgot password', 'forgot password',
               'staff', $2, '2026-10-20T08:00:00Z'),
              ('0192ffff-0000-7000-8000-0000000000a2', $1, 'zh-CN', '忘记密码', '忘记 记密 密码',
               'flywheel', NULL, '2026-10-21T08:00:00Z')`,
      [faq, OLIVIA],
    );
    await pool.query(
      readFileSync(
        join(MIGRATIONS, PHRASING_MIGRATION, 'migration.sql'),
        'utf8',
      ),
    );
    const { rows } = await pool.query<{
      phrasing_id: string;
      action: string;
      text: string;
      source: string;
      employee_id: string | null;
      at: Date;
    }>(
      'SELECT phrasing_id, action, text, source, employee_id, at FROM helpdesk_faq_phrasing_revisions ORDER BY at',
    );
    expect(
      rows.map((r) => [
        r.phrasing_id.slice(-2),
        r.action,
        r.text,
        r.source,
        r.employee_id,
        r.at.toISOString(),
      ]),
    ).toEqual([
      [
        'a1',
        'create',
        'forgot password',
        'staff',
        OLIVIA,
        '2026-10-20T08:00:00.000Z',
      ],
      [
        'a2',
        'create',
        '忘记密码',
        'flywheel',
        null,
        '2026-10-21T08:00:00.000Z',
      ],
    ]);
  });
});

describeDb('Helpdesk FAQ change log (PostgreSQL)', () => {
  const schema = `hdchanges_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let db: SqlDb;
  let faqs: FaqService;
  let graphService: FaqGraphService;
  let releases: FaqReleaseService;
  let changes: FaqChangeLogService;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
    });
    await pool.query(migrationSql());
    db = sqlDb(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE helpdesk_faq_release_nodes, helpdesk_faq_releases, helpdesk_faq_edge_revisions,
                helpdesk_faq_edges, helpdesk_faq_phrasing_revisions, helpdesk_faq_phrasings,
                helpdesk_faq_revisions, helpdesk_faqs`,
    );
    const graph = createPgFaqGraphRepository(db);
    const source = createPgFaqReleaseSource(graph);
    faqs = createFaqService({
      repository: createPgFaqRepository(db),
      releaseVersion: () => source.publishedVersion(),
      liveParents: (id) => graph.liveParents(id),
    });
    graphService = createFaqGraphService({ graph });
    releases = createFaqReleaseService({ graph, gate: passingGate });
    changes = createFaqChangeLogService({
      log: createPgFaqChangeLogRepository(db),
      releases: () => graph.releases(),
      people: (ids) =>
        Promise.resolve(
          new Map(ids.filter((id) => PEOPLE[id]).map((id) => [id, PEOPLE[id]])),
        ),
    });
  });

  let counter = 0;
  async function create(
    actor: { employeeId: string | null },
    fields: Partial<Record<string, unknown>> = {},
  ): Promise<HelpdeskFaq> {
    counter += 1;
    const faq = await faqs.create(actor, {
      category: 'payments_subscriptions',
      popular: false,
      questionEn: `Question number ${counter}?`,
      answerEn: `Answer ${counter}.`,
      questionZh: `第${counter}个问题？`,
      answerZh: '答案。',
      keywords: [],
      ...fields,
    });
    await tick();
    return faq;
  }

  describe('phrasing revisions', () => {
    it('logs an add and a delete in the same transaction; repeats write nothing; the log is append-only', async () => {
      const faq = await create(olivia);
      const first = await graphService.addPhrasing(olivia, faq.id, {
        locale: 'en-GB',
        text: 'Cancel my  plan',
      });
      const again = await graphService.addPhrasing(marco, faq.id, {
        locale: 'en-GB',
        text: 'cancel my plan',
      });
      expect([first.created, again.created]).toEqual([true, false]);
      expect(
        await graphService.deletePhrasing(marco, first.phrasing.id),
      ).toEqual({ deleted: true });
      expect(
        await graphService.deletePhrasing(marco, first.phrasing.id),
      ).toEqual({ deleted: false });
      const { rows } = await pool.query<{
        phrasing_id: string;
        faq_id: string;
        action: string;
        locale: string;
        text: string;
        employee_id: string;
      }>(
        'SELECT phrasing_id, faq_id, action, locale, text, employee_id FROM helpdesk_faq_phrasing_revisions ORDER BY at, action',
      );
      expect(rows).toEqual([
        {
          phrasing_id: first.phrasing.id,
          faq_id: faq.id,
          action: 'create',
          locale: 'en-GB',
          text: 'Cancel my plan',
          employee_id: OLIVIA,
        },
        {
          phrasing_id: first.phrasing.id,
          faq_id: faq.id,
          action: 'delete',
          locale: 'en-GB',
          text: 'Cancel my plan',
          employee_id: MARCO,
        },
      ]);
      await expect(
        pool.query("UPDATE helpdesk_faq_phrasing_revisions SET text = 'x'"),
      ).rejects.toThrow(/append-only/i);
      await expect(
        pool.query('DELETE FROM helpdesk_faq_phrasing_revisions'),
      ).rejects.toThrow(/append-only/i);
    });

    it('a failed revision write rolls the phrasing change back too', async () => {
      const faq = await create(olivia);
      await pool.query(
        'ALTER TABLE helpdesk_faq_phrasing_revisions ADD CONSTRAINT no_writes CHECK (false) NOT VALID',
      );
      try {
        await expect(
          graphService.addPhrasing(olivia, faq.id, {
            locale: 'en-GB',
            text: 'never saved',
          }),
        ).rejects.toThrow();
        expect((await graphService.phrasings(faq.id)).phrasings).toHaveLength(
          0,
        );
      } finally {
        await pool.query(
          'ALTER TABLE helpdesk_faq_phrasing_revisions DROP CONSTRAINT no_writes',
        );
      }
    });
  });

  describe('the timeline', () => {
    it('answers who, when and what for every kind of change, newest first', async () => {
      const parent = await create(olivia, {
        questionEn: 'How do I cancel?',
        keywords: ['cancel', 'refund'],
      });
      const child = await create(olivia, {
        questionEn: 'Will I get a refund?',
      });
      const other = await create(marco, { questionEn: 'Can I pause instead?' });
      const edited = await faqs.update(marco, parent.id, {
        ...parent,
        answerEn: 'Go to Settings > Plan > Cancel.',
        keywords: ['cancel', 'stop plan'],
        version: parent.version,
      });
      await tick();
      const edge = (
        await graphService.createEdge(olivia, parent.id, { childId: child.id })
      ).edge;
      await tick();
      const second = (
        await graphService.createEdge(olivia, parent.id, { childId: other.id })
      ).edge;
      await tick();
      await graphService.reorder(marco, parent.id, {
        childIds: [other.id, child.id],
      });
      await tick();
      await graphService.updateEdge(marco, edge.id, {
        labelEn: 'Refund?',
        labelZh: '退款吗？',
      });
      await tick();
      const phrasing = await graphService.addPhrasing(olivia, parent.id, {
        locale: 'zh-CN',
        text: '怎么退订',
      });
      await tick();
      await graphService.deletePhrasing(marco, phrasing.phrasing.id);
      await tick();
      await graphService.deleteEdge(marco, second.id);
      await tick();
      await faqs.archive(marco, other.id, { version: other.version });

      const page = await changes.list({ pageSize: '50' });
      const rows = page.changes.map((c) => [
        c.subject,
        c.action,
        c.employee?.name ?? null,
        c.faq?.questionEn ?? null,
        c.child?.questionEn ?? null,
      ]);
      expect(rows).toEqual([
        ['faq', 'archived', 'marco.li', 'Can I pause instead?', null],
        [
          'follow_up',
          'removed',
          'marco.li',
          'How do I cancel?',
          'Can I pause instead?',
        ],
        ['phrasing', 'removed', 'marco.li', 'How do I cancel?', null],
        ['phrasing', 'added', 'olivia.chen', 'How do I cancel?', null],
        [
          'follow_up',
          'changed',
          'marco.li',
          'How do I cancel?',
          'Will I get a refund?',
        ],
        // the reorder moves both children: one revision per moved edge
        [
          'follow_up',
          'reordered',
          'marco.li',
          'How do I cancel?',
          expect.any(String),
        ],
        [
          'follow_up',
          'reordered',
          'marco.li',
          'How do I cancel?',
          expect.any(String),
        ],
        [
          'follow_up',
          'added',
          'olivia.chen',
          'How do I cancel?',
          'Can I pause instead?',
        ],
        [
          'follow_up',
          'added',
          'olivia.chen',
          'How do I cancel?',
          'Will I get a refund?',
        ],
        ['faq', 'edited', 'marco.li', 'How do I cancel?', null],
        ['faq', 'created', 'marco.li', 'Can I pause instead?', null],
        ['faq', 'created', 'olivia.chen', 'Will I get a refund?', null],
        ['faq', 'created', 'olivia.chen', 'How do I cancel?', null],
      ]);
      expect(page.total).toBe(13);
      expect(page.people.map((p) => p.name)).toEqual([
        'marco.li',
        'olivia.chen',
      ]);

      const edit = page.changes[9];
      expect(edit.version).toEqual({ from: 1, to: edited.version });
      expect(edit.changes).toEqual([
        {
          field: 'answerEn',
          before: parent.answerEn,
          after: 'Go to Settings > Plan > Cancel.',
        },
        {
          field: 'keywords',
          before: ['cancel', 'refund'],
          after: ['cancel', 'stop plan'],
        },
      ]);
      expect(page.changes[4].changes).toEqual([
        { field: 'labelEn', before: null, after: 'Refund?' },
        { field: 'labelZh', before: null, after: '退款吗？' },
      ]);
      expect(page.changes[5].changes.map((c) => c.field)).toEqual(['position']);
      expect(page.changes[3].phrasing).toEqual({
        locale: 'zh-CN',
        text: '怎么退订',
        source: 'staff',
      });
      expect(page.changes[0].changes).toEqual([
        { field: 'status', before: 'published', after: 'archived' },
      ]);
      const created = page.changes[12];
      expect(created.version).toEqual({ from: null, to: 1 });
      expect(created.changes.map((c) => c.field)).toEqual([
        'key',
        'type',
        'entry',
        'category',
        'popular',
        'questionEn',
        'answerEn',
        'questionZh',
        'answerZh',
        'keywords',
        'status',
      ]);
      // nothing has ever been published: saving is going live
      expect(
        page.changes.every((c) => c.learners === 'live' && c.liveIn === null),
      ).toBe(true);
      expect(new Set(page.changes.map((c) => c.id)).size).toBe(13);
    });

    it('filters by type, person, time and text; pages with a stable total', async () => {
      const a = await create(olivia, { questionEn: 'Where is my invoice?' });
      await create(marco, { questionEn: 'How do I change my email?' });
      await graphService.addPhrasing(marco, a.id, {
        locale: 'en-GB',
        text: 'receipt missing',
      });
      await tick();
      // a seed / system write has no employee
      await create({ employeeId: null }, { questionEn: 'Seeded question?' });

      const total = (await changes.list({})).total;
      expect(total).toBe(4);
      expect(
        (await changes.list({ subject: 'phrasing' })).changes.map(
          (c) => c.phrasing?.text,
        ),
      ).toEqual(['receipt missing']);
      expect(
        (await changes.list({ employee: MARCO })).changes.map((c) => c.subject),
      ).toEqual(['phrasing', 'faq']);
      const system = await changes.list({ employee: 'system' });
      expect(
        system.changes.map((c) => [c.employee, c.faq?.questionEn]),
      ).toEqual([[null, 'Seeded question?']]);
      // search matches the FAQ's question, its key and the phrasing text
      expect((await changes.list({ q: 'INVOICE' })).total).toBe(2);
      expect((await changes.list({ q: 'receipt' })).total).toBe(1);
      expect((await changes.list({ q: 'how-do-i-change' })).total).toBe(1);
      // LIKE wildcards are literal
      expect((await changes.list({ q: '%' })).total).toBe(0);

      const today = new Date().toISOString().slice(0, 10);
      expect((await changes.list({ from: today, to: today })).total).toBe(4);
      expect((await changes.list({ to: '2020-01-01' })).total).toBe(0);
      expect((await changes.list({ from: '2999-01-01' })).total).toBe(0);

      const one = await changes.list({ page: '2', pageSize: '3' });
      expect([one.changes.length, one.total, one.page, one.pageSize]).toEqual([
        1, 4, 2, 3,
      ]);
      const all = [
        ...(await changes.list({ page: '1', pageSize: '3' })).changes,
        ...one.changes,
      ];
      expect(all.map((c) => c.id)).toEqual(
        (await changes.list({ pageSize: '10' })).changes.map((c) => c.id),
      );
    });

    it('rejects bad filters with 400', async () => {
      for (const input of [
        { subject: 'everything' },
        { employee: 'olivia' },
        { from: 'yesterday' },
        { to: '2026-02-30' },
        { from: '2026-10-02', to: '2026-10-01' },
        { q: 'x'.repeat(201) },
        { page: '0' },
        { pageSize: '51' },
        { q: ['a', 'b'] },
        { faq: 'not-a-uuid' },
      ])
        await rejects(changes.list(input), 400, 'INVALID_INPUT');
      await rejects(changes.forFaq('nope', {}), 400, 'INVALID_INPUT');
    });
  });

  describe('do learners see it yet', () => {
    it('pending until a release that includes it is published; then live with the version it went live in', async () => {
      const faq = await create(olivia, { questionEn: 'How do refunds work?' });
      await releases.create(olivia);
      await releases.publish(marco, 1);
      await tick();
      const edited = await faqs.update(olivia, faq.id, {
        ...faq,
        answerEn: 'Refunds take 5 days.',
        version: faq.version,
      });
      await tick();

      let log = await changes.list({ subject: 'faq' });
      expect(log.changes.map((c) => [c.action, c.learners, c.liveIn])).toEqual([
        ['edited', 'pending', null],
        ['created', 'live', 1],
      ]);

      await releases.create(olivia);
      await tick();
      await releases.publish(marco, 2);
      await tick();
      log = await changes.list({ subject: 'faq' });
      expect(log.changes.map((c) => [c.action, c.learners, c.liveIn])).toEqual([
        ['edited', 'live', 2],
        ['created', 'live', 1],
      ]);

      // rolling back to v1 takes the edit off the screen again (v3 is a copy of v1)
      await releases.rollback(marco, 1);
      await tick();
      log = await changes.list({ subject: 'faq' });
      expect(log.changes.map((c) => [c.action, c.learners, c.liveIn])).toEqual([
        ['edited', 'pending', 2],
        ['created', 'live', 1],
      ]);

      const versions = await changes.list({ subject: 'release' });
      expect(
        versions.changes.map((c) => [
          c.action,
          c.release?.version,
          c.release?.sourceVersion,
          c.employee?.name,
          c.learners,
        ]),
      ).toEqual([
        ['published', 3, 1, 'marco.li', null],
        ['rolled_back', 3, 1, 'marco.li', null],
        ['published', 2, null, 'marco.li', null],
        ['version_created', 2, null, 'olivia.chen', null],
        ['published', 1, null, 'marco.li', null],
        ['version_created', 1, null, 'olivia.chen', null],
      ]);
      expect(edited.version).toBe(2);
    });
  });

  describe('one FAQ’s history', () => {
    it('lists its own edits, its links as parent and as child, its phrasings and when they went live; no other FAQ', async () => {
      const parent = await create(olivia, { questionEn: 'Billing help' });
      const faq = await create(olivia, { questionEn: 'Change card' });
      await create(marco, { questionEn: 'Unrelated question' });
      await graphService.createEdge(marco, parent.id, { childId: faq.id });
      await tick();
      await graphService.addPhrasing(olivia, faq.id, {
        locale: 'en-GB',
        text: 'update payment method',
      });
      await tick();
      await releases.create(olivia);
      await tick();
      await releases.publish(marco, 1);
      await tick();
      await faqs.update(marco, faq.id, {
        ...faq,
        questionZh: '更换银行卡',
        version: faq.version,
      });

      const history = await changes.forFaq(faq.id, { pageSize: '50' });
      expect(
        history.changes.map((c) => [
          c.subject,
          c.action,
          c.release?.version ?? null,
          c.learners,
        ]),
      ).toEqual([
        ['faq', 'edited', null, 'pending'],
        ['release', 'published', 1, null],
        ['phrasing', 'added', null, 'live'],
        ['follow_up', 'added', null, 'live'],
        ['faq', 'created', null, 'live'],
      ]);
      expect(history.total).toBe(5);
      expect(history.truncated).toBe(false);
      expect(history.changes[3].faq?.questionEn).toBe('Billing help');
      expect(history.changes[3].child?.questionEn).toBe('Change card');

      const parentHistory = await changes.forFaq(parent.id, {});
      expect(parentHistory.changes.map((c) => [c.subject, c.action])).toEqual([
        ['release', 'published'],
        ['follow_up', 'added'],
        ['faq', 'created'],
      ]);
      // the Change Log filtered to this FAQ: the same rows without the went-live entries
      expect(
        (await changes.list({ faq: faq.id })).changes.map((c) => [
          c.subject,
          c.action,
        ]),
      ).toEqual([
        ['faq', 'edited'],
        ['phrasing', 'added'],
        ['follow_up', 'added'],
        ['faq', 'created'],
      ]);
      const paged = await changes.forFaq(faq.id, { page: '2', pageSize: '2' });
      expect(paged.changes.map((c) => c.subject)).toEqual([
        'phrasing',
        'follow_up',
      ]);
    });
  });
});
