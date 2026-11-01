import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

import type { FaqNodeType } from '../../contracts/helpdesk-qa';
import type { HelpdeskFaq } from '../modules/helpdesk/faqs/faqContracts';
import { createPgFaqGraphRepository } from '../modules/helpdesk/faqs/faqGraphRepository';
import {
  createFaqGraphService,
  type FaqGraphService,
} from '../modules/helpdesk/faqs/faqGraphService';
import {
  createPgFaqMapRepository,
  type FaqMapRepository,
  type MapNodeInput,
} from '../modules/helpdesk/faqs/faqMapRepository';
import { parseMapSeed, seedFaqMap } from '../modules/helpdesk/faqs/faqMapSeed';
import {
  createHelpdeskQaSource,
  type LocatorMode,
} from '../modules/helpdesk/faqs/faqQaSource';
import type { FaqReleaseGate } from '../modules/helpdesk/faqs/faqReleaseGate';
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
import { HelpdeskError } from '../modules/helpdesk/portalHelpdeskClient';

/**
 * 流程树与对象表在 PostgreSQL 上（迁移 20261031120000，设计文档「Helpdesk 定位方式对比」第五节）：
 * 表的层级约束、按 key 幂等建节点、乐观锁、挂载整组写入（只写差异、主位置互换）、删节点的保护、
 * 每次改动一行审计；发布时随快照冻结、发布检查拦住没有主位置的卡；运行时 HELPDESK_LOCATOR=hybrid
 * 把结构排序的前几张放在 A 的候选前面，A 的候选一张不少，flat 时和以前完全一样。
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

const node = (
  key: string,
  kind: MapNodeInput['kind'],
  parentKey: string | null,
  extra: Partial<MapNodeInput> = {},
): MapNodeInput => ({
  key,
  kind,
  parentKey,
  stageKey: null,
  attribute: null,
  position: 0,
  labelEn: key,
  labelZh: key,
  ...extra,
});

/** 两个阶段、两步、一个岔子、一个对象一格（够覆盖每种节点）。 */
const SKELETON: MapNodeInput[] = [
  node('manage', 'stage', null),
  node('manage.cancel', 'step', 'manage'),
  node('manage.cancel.button-missing', 'deviation', 'manage.cancel'),
  node('purchase', 'stage', null),
  node('purchase.pay', 'step', 'purchase'),
  node('rules.trial', 'object', null, { stageKey: 'purchase' }),
  node('rules.trial.price', 'cell', 'rules.trial', { attribute: 'price' }),
];

describeDb('Helpdesk FAQ process map and rule table (PostgreSQL)', () => {
  const schema = `hdmap_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let db: SqlDb;
  let repo: FaqRepository;
  let map: FaqMapRepository;
  let faqs: FaqService;
  let graphService: FaqGraphService;
  let releases: FaqReleaseService;
  let locator: LocatorMode;

  const passingGate: FaqReleaseGate = {
    evaluate: () =>
      Promise.resolve({
        kind: 'retrieval',
        passed: true,
        summary: 'ok',
        ranAt: '2026-10-31T00:00:00.000Z',
        metrics: { recallAt8: 1 },
        misses: [],
      }),
  };

  function wire() {
    const graph = createPgFaqGraphRepository(db);
    const source = createPgFaqReleaseSource(graph);
    faqs = createFaqService({
      repository: repo,
      releaseVersion: () => source.publishedVersion(),
      liveParents: (id) => graph.liveParents(id),
    });
    graphService = createFaqGraphService({ graph });
    releases = createFaqReleaseService({ graph, gate: passingGate });
    return createHelpdeskQaSource({
      repository: repo,
      releases: source,
      liveEdges: () => graph.allEdges(),
      locator: () => locator,
    });
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
    map = createPgFaqMapRepository(db);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE helpdesk_faq_map_revisions, helpdesk_faq_placements, helpdesk_faq_map_nodes,
                helpdesk_faq_release_vectors, helpdesk_faq_embeddings,
                helpdesk_faq_release_nodes, helpdesk_faq_releases, helpdesk_faq_edge_revisions,
                helpdesk_faq_edges, helpdesk_faq_phrasings, helpdesk_faq_reviews, helpdesk_faq_revisions, helpdesk_faqs`,
    );
    locator = 'flat';
    wire();
  });

  async function skeleton() {
    for (const input of SKELETON) await map.upsertNode(input, staff);
  }

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

  async function revisionCount(): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM helpdesk_faq_map_revisions',
    );
    return Number(rows[0].n);
  }

  describe('nodes', () => {
    it('builds every kind of node by key, idempotently, with one revision per change', async () => {
      await skeleton();
      expect((await map.nodes()).map((n) => [n.key, n.kind])).toEqual([
        ['manage', 'stage'],
        ['manage.cancel', 'step'],
        ['manage.cancel.button-missing', 'deviation'],
        ['purchase', 'stage'],
        ['purchase.pay', 'step'],
        ['rules.trial', 'object'],
        ['rules.trial.price', 'cell'],
      ]);
      expect(await revisionCount()).toBe(SKELETON.length);

      // 同样的再建一次：什么都不写
      for (const input of SKELETON) {
        const again = await map.upsertNode(input, staff);
        expect([again.created, again.changed]).toEqual([false, false]);
      }
      expect(await revisionCount()).toBe(SKELETON.length);

      // 文字变了：改掉，version + 1，记一条 update（改前 / 改后、是谁）
      const renamed = await map.upsertNode(
        { ...SKELETON[1], labelZh: '取消订阅' },
        staff,
      );
      expect(renamed).toMatchObject({ created: false, changed: true });
      expect(renamed.node).toMatchObject({ labelZh: '取消订阅', version: 2 });
      const [latest] = await map.revisions(renamed.node.id);
      expect(latest).toMatchObject({
        entity: 'node',
        action: 'update',
        employeeId: EMP,
        before: expect.objectContaining({
          labelZh: 'manage.cancel',
        }) as unknown,
        after: expect.objectContaining({ labelZh: '取消订阅' }) as unknown,
      });
    });

    it('refuses nodes at the wrong level and moves of an existing key', async () => {
      await skeleton();
      // 岔子只能挂在步骤下（数据库触发器）
      await rejects(
        map.upsertNode(node('manage.oops', 'deviation', 'manage'), staff),
        400,
        'INVALID_INPUT',
      );
      // 对象要属于一个阶段（CHECK）
      await rejects(
        map.upsertNode(node('rules.plan', 'object', null), staff),
        400,
        'INVALID_INPUT',
      );
      // 同一个对象的同一个属性只有一格
      await rejects(
        map.upsertNode(
          node('rules.trial.cost', 'cell', 'rules.trial', {
            attribute: 'price',
          }),
          staff,
        ),
        409,
        'FAQ_MAP_CONFLICT',
      );
      // 换父节点 = 搬家，要先删再建
      await rejects(
        map.upsertNode(node('manage.cancel', 'step', 'purchase'), staff),
        400,
        'INVALID_INPUT',
      );
      await rejects(
        map.upsertNode(node('x.y', 'step', 'nowhere'), staff),
        400,
        'INVALID_INPUT',
      );
      expect(await map.nodes()).toHaveLength(SKELETON.length);
    });

    it('updates with an optimistic lock', async () => {
      await skeleton();
      const step = (await map.nodes()).find((n) => n.key === 'purchase.pay')!;
      const first = await map.updateNode(
        step.id,
        { labelEn: 'Pay' },
        step.version,
        staff,
      );
      expect(first).toMatchObject({ labelEn: 'Pay', version: 2 });
      // 拿着旧的 version 再改：别人先改了
      await rejects(
        map.updateNode(step.id, { labelEn: 'Checkout' }, step.version, staff),
        409,
        'FAQ_MAP_CONFLICT',
      );
      await rejects(
        map.updateNode(
          '0192aaaa-0000-7000-8000-00000000ffff',
          { labelEn: 'x' },
          1,
          staff,
        ),
        404,
        'FAQ_MAP_NODE_NOT_FOUND',
      );
    });
  });

  describe('placements', () => {
    it('writes only the difference, swaps the primary place, and is idempotent', async () => {
      await skeleton();
      const card = await create({ questionEn: 'How do I cancel?' });
      const first = await map.setPlacements(
        card.id,
        [
          { nodeKey: 'manage.cancel', primary: true },
          { nodeKey: 'rules.trial.price', primary: false },
        ],
        staff,
      );
      expect(first.changed).toBe(2);
      expect(
        (
          await map.setPlacements(
            card.id,
            [
              { nodeKey: 'rules.trial.price', primary: false },
              { nodeKey: 'manage.cancel', primary: true },
            ],
            staff,
          )
        ).changed,
      ).toBe(0);

      // 主位置换到另一个：一降一升，部分唯一索引一直成立
      const swapped = await map.setPlacements(
        card.id,
        [
          { nodeKey: 'manage.cancel', primary: false },
          { nodeKey: 'rules.trial.price', primary: true },
        ],
        staff,
      );
      expect(swapped.changed).toBe(2);
      const byNode = new Map(
        (await map.nodes()).map((n) => [n.id, n.key] as const),
      );
      expect(
        swapped.placements.map((p) => [byNode.get(p.nodeId), p.primary]),
      ).toEqual(
        expect.arrayContaining([
          ['manage.cancel', false],
          ['rules.trial.price', true],
        ]),
      );

      // 去掉一个
      const removed = await map.setPlacements(
        card.id,
        [{ nodeKey: 'rules.trial.price', primary: true }],
        staff,
      );
      expect(removed.placements).toHaveLength(1);
      const { rows } = await pool.query<{
        action: string;
        employee_id: string;
      }>(
        `SELECT action, employee_id FROM helpdesk_faq_map_revisions
          WHERE entity = 'placement' ORDER BY at, id`,
      );
      expect(rows.map((r) => r.action)).toEqual([
        'create',
        'create',
        'update',
        'update',
        'delete',
      ]);
      expect(rows.every((r) => r.employee_id === EMP)).toBe(true);
    });

    it('refuses a stage or object, two primaries, the same place twice and unknown nodes', async () => {
      await skeleton();
      const card = await create();
      await rejects(
        map.setPlacements(
          card.id,
          [{ nodeKey: 'manage', primary: true }],
          staff,
        ),
        400,
        'INVALID_INPUT',
      );
      await rejects(
        map.setPlacements(
          card.id,
          [{ nodeKey: 'rules.trial', primary: true }],
          staff,
        ),
        400,
        'INVALID_INPUT',
      );
      await rejects(
        map.setPlacements(
          card.id,
          [
            { nodeKey: 'manage.cancel', primary: true },
            { nodeKey: 'purchase.pay', primary: true },
          ],
          staff,
        ),
        400,
        'INVALID_INPUT',
      );
      await rejects(
        map.setPlacements(
          card.id,
          [
            { nodeKey: 'manage.cancel', primary: true },
            { nodeKey: 'manage.cancel', primary: false },
          ],
          staff,
        ),
        400,
        'INVALID_INPUT',
      );
      await rejects(
        map.setPlacements(
          card.id,
          [{ nodeKey: 'nowhere', primary: true }],
          staff,
        ),
        400,
        'INVALID_INPUT',
      );
      expect(await map.placements(card.id)).toEqual([]);
      expect(await revisionCount()).toBe(SKELETON.length);
    });

    it('keeps a node while cards or children hang on it; deleting twice is a no-op', async () => {
      await skeleton();
      const card = await create();
      await map.setPlacements(
        card.id,
        [{ nodeKey: 'purchase.pay', primary: true }],
        staff,
      );
      const nodes = await map.nodes();
      const pay = nodes.find((n) => n.key === 'purchase.pay')!;
      const purchase = nodes.find((n) => n.key === 'purchase')!;
      await rejects(map.deleteNode(pay.id, staff), 409, 'FAQ_MAP_CONFLICT');
      await rejects(
        map.deleteNode(purchase.id, staff),
        409,
        'FAQ_MAP_CONFLICT',
      );
      await map.setPlacements(card.id, [], staff);
      expect(await map.deleteNode(pay.id, staff)).toMatchObject({
        key: 'purchase.pay',
      });
      expect(await map.deleteNode(pay.id, staff)).toBeNull();
      expect((await map.revisions(pay.id))[0]).toMatchObject({
        action: 'delete',
        after: null,
      });
    });
  });

  describe('seed', () => {
    it('imports the structure files and is idempotent on the second run', async () => {
      const card = await create({ questionEn: 'No activation email' });
      const seed = parseMapSeed(
        {
          stages: [
            {
              key: 'account',
              labelEn: 'Sign up and sign in',
              labelZh: '注册与登录',
              steps: [
                {
                  key: 'account.verify',
                  labelEn: 'Verify',
                  labelZh: '激活邮箱',
                },
              ],
            },
          ],
          objects: [
            {
              key: 'account',
              labelEn: 'Account',
              labelZh: '账号',
              stage: 'S1',
            },
          ],
          attributes: [{ key: 'timing', labelEn: 'Timing', labelZh: '时效' }],
        },
        [
          {
            key: card.key,
            primary: {
              node: 'deviation',
              step: 'account.verify',
              deviation: {
                key: 'account.verify.no-email',
                en: 'No email',
                zh: '收不到邮件',
              },
            },
            secondary: [
              { node: 'cell', object: 'account', attribute: 'timing' },
            ],
          },
          {
            key: 'not-a-card',
            primary: { node: 'step', step: 'account.verify' },
          },
        ],
      );
      const deps = { map, faqs: repo };
      const first = await seedFaqMap(deps, seed, staff);
      expect(first.nodes.created).toEqual([
        'account',
        'account.verify',
        'rules.account',
        'account.verify.no-email',
        'rules.account.timing',
      ]);
      expect(first.placements).toEqual({
        cards: 1,
        changed: 2,
        missingCards: ['not-a-card'],
      });
      const again = await seedFaqMap(deps, seed, staff);
      expect(again.nodes).toEqual({ created: [], changed: [], unchanged: 5 });
      expect(again.placements.changed).toBe(0);
      expect(await revisionCount()).toBe(5 + 2);
    });
  });

  describe('releases and the runtime locator', () => {
    /**
     * 「怎么取消订阅」：答案是「管理订阅」下面的追问（不是入口）；入口里还有几张都提到 subscription 的卡。
     */
    async function library() {
      const manage = await create({ questionEn: 'Managing my subscription' });
      const cancel = await create({
        entry: false,
        questionEn: 'How do I cancel my subscription renewal?',
      });
      await graphService.createEdge(staff, manage.id, { childId: cancel.id });
      const button = await create({
        entry: false,
        questionEn: 'The cancel subscription button is missing',
      });
      await graphService.createEdge(staff, manage.id, { childId: button.id });
      const others: HelpdeskFaq[] = [];
      for (const what of ['pay for', 'upgrade', 'gift', 'share', 'pause'])
        others.push(
          await create({ questionEn: `How do I ${what} a subscription?` }),
        );
      const price = await create({
        questionEn: 'How much does a subscription cost after the trial?',
      });
      return { manage, cancel, button, others, price };
    }

    const search = (text: string) => ({
      locale: 'en-GB',
      category: null,
      text,
      limit: 10,
      entryOnly: true,
      types: ['answer', 'choice'] as FaqNodeType[],
      deepReserved: 2,
    });

    it('freezes the map into the release and blocks a release with a card that has no primary place', async () => {
      await skeleton();
      const { cancel } = await library();
      await map.setPlacements(
        cancel.id,
        [{ nodeKey: 'manage.cancel', primary: false }],
        staff,
      );
      const bad = await releases.create(staff);
      expect(bad.release.checks?.passed).toBe(false);
      expect(bad.release.checks?.problems.map((p) => [p.rule, p.key])).toEqual([
        ['map_primary', cancel.key],
      ]);

      await map.setPlacements(
        cancel.id,
        [{ nodeKey: 'manage.cancel', primary: true }],
        staff,
      );
      const good = await releases.create(staff);
      expect(good.created).toBe(true);
      expect(good.release.checks?.passed).toBe(true);
      const { rows } = await pool.query<{ snapshot: { map?: unknown } }>(
        'SELECT snapshot FROM helpdesk_faq_releases WHERE version = $1',
        [good.release.version],
      );
      expect(rows[0].snapshot.map).toMatchObject({
        nodes: expect.arrayContaining([
          expect.objectContaining({ key: 'manage.cancel', kind: 'step' }),
        ]) as unknown,
        placements: [{ faqId: cancel.id, primary: true }],
      });
      // 只改了结构也是新的一版
      await map.setPlacements(
        cancel.id,
        [
          { nodeKey: 'manage.cancel', primary: true },
          { nodeKey: 'rules.trial.price', primary: false },
        ],
        staff,
      );
      expect((await releases.create(staff)).created).toBe(true);
    });

    it('hybrid puts the structured head first and keeps every flat candidate; flat and follow-up turns are unchanged', async () => {
      await skeleton();
      const lib = await library();
      await map.setPlacements(
        lib.cancel.id,
        [{ nodeKey: 'manage.cancel', primary: true }],
        staff,
      );
      await map.setPlacements(
        lib.button.id,
        [{ nodeKey: 'manage.cancel.button-missing', primary: true }],
        staff,
      );
      await map.setPlacements(
        lib.others[0].id,
        [{ nodeKey: 'purchase.pay', primary: true }],
        staff,
      );
      await map.setPlacements(
        lib.price.id,
        [{ nodeKey: 'rules.trial.price', primary: true }],
        staff,
      );
      await releases.create(staff);
      await releases.publish(staff, 1);

      const qa = wire();
      const text = 'how do I cancel my subscription';
      locator = 'flat';
      const flat = await qa.findCandidates(search(text));
      locator = 'hybrid';
      const hybrid = await qa.findCandidates(search(text));

      // hybrid = 结构排序的前 k 张（k ≤ 3）+ flat 的候选去掉这几张、顺序不变：flat 的一张不少
      const ids = hybrid.map((c) => c.id);
      const flatIds = flat.map((c) => c.id);
      const k = [1, 2, 3].find(
        (n) =>
          JSON.stringify(ids) ===
          JSON.stringify([
            ...ids.slice(0, n),
            ...flatIds.filter((id) => !ids.slice(0, n).includes(id)),
          ]),
      );
      expect(k).toBeDefined();
      // flat 里这张追问只排在入口卡后面的保留位上；hybrid 把它放到第一
      expect(flatIds.indexOf(lib.cancel.id)).toBeGreaterThan(0);
      expect(ids[0]).toBe(lib.cancel.id);
      // 「怎么取消」是流程问题：价格那格不在前几张
      expect(ids.slice(0, k)).not.toContain(lib.price.id);
      expect(flatIds.every((id) => ids.includes(id))).toBe(true);

      // 屏幕上有卡片（追问）：不加结构的前几张
      const followUp = await qa.findCandidates({
        ...search(text),
        nodeId: lib.manage.id,
      });
      locator = 'flat';
      const followUpFlat = await qa.findCandidates({
        ...search(text),
        nodeId: lib.manage.id,
      });
      expect(followUp.map((c) => c.id)).toEqual(followUpFlat.map((c) => c.id));
    });

    it('hybrid without a map in the release is the flat list', async () => {
      const lib = await library();
      await releases.create(staff);
      await releases.publish(staff, 1);
      const qa = wire();
      locator = 'flat';
      const flat = await qa.findCandidates(search('cancel subscription'));
      locator = 'hybrid';
      const hybrid = await qa.findCandidates(search('cancel subscription'));
      expect(hybrid.map((c) => c.id)).toEqual(flat.map((c) => c.id));
      expect(flat.some((c) => c.id === lib.cancel.id)).toBe(true);
    });
  });
});
