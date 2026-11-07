import type { HelpdeskFaq } from '../modules/helpdesk/faqs/faqContracts';
import type { FaqMapNode } from '../modules/helpdesk/faqs/faqMap';
import {
  mapSeedNodes,
  parseMapSeed,
  pruneFaqMap,
  seedFaqMap,
} from '../modules/helpdesk/faqs/faqMapSeed';
import { HelpdeskError } from '../modules/helpdesk/portalHelpdeskClient';

/** 结构文件的读取与导入（faqMapSeed.ts）：纯函数部分与按 key 的导入顺序；数据库上的幂等见 helpdesk-faq-map.pg.spec.ts。 */

const SKELETON = {
  stages: [
    {
      key: 'account',
      label: 'S1 注册与登录',
      labelEn: 'Sign up and sign in',
      steps: [
        { key: 'account.verify', label: '激活邮箱', labelEn: 'Verify email' },
      ],
    },
    {
      key: 'purchase',
      labelZh: 'S3 购买',
      labelEn: 'Buy',
      steps: [{ key: 'purchase.pay', label: '付款', labelEn: 'Pay' }],
    },
  ],
  objects: [{ key: 'account', label: '账号', labelEn: 'Account', stage: 'S1' }],
  attributes: [
    { key: 'definition', label: '定义', labelEn: 'Definition' },
    { key: 'price', label: '价格', labelEn: 'Price' },
  ],
};

const PLACEMENTS = [
  {
    key: 'no-activation-email',
    primary: {
      node: 'deviation',
      step: 'account.verify',
      deviation: {
        key: 'account.verify.no-email',
        en: 'The email does not arrive',
        zh: '收不到邮件',
      },
    },
    secondary: [{ node: 'cell', object: 'account', attribute: 'definition' }],
    note: 'ignored',
  },
  { key: 'how-to-pay', primary: { node: 'step', step: 'purchase.pay' } },
  {
    key: 'gone-card',
    primary: { node: 'cell', object: 'account', attribute: 'price' },
  },
];

describe('parseMapSeed', () => {
  it('reads stages, objects (stage by key or S-number), attributes and placements', () => {
    const seed = parseMapSeed(SKELETON, PLACEMENTS);
    expect(seed.stages.map((s) => [s.key, s.labelZh, s.steps.length])).toEqual([
      ['account', 'S1 注册与登录', 1],
      ['purchase', 'S3 购买', 1],
    ]);
    expect(seed.objects).toEqual([
      { key: 'account', labelEn: 'Account', labelZh: '账号', stage: 'account' },
    ]);
    expect(seed.placements[0].secondary).toEqual([
      { node: 'cell', object: 'account', attribute: 'definition' },
    ]);
    expect(seed.placements[1].secondary).toEqual([]);
  });

  it('refuses unknown stages, attributes and node kinds', () => {
    const bad = (skeleton: unknown, placements: unknown[] = []) =>
      expect(() => parseMapSeed(skeleton, placements)).toThrow(HelpdeskError);
    bad({
      ...SKELETON,
      objects: [{ key: 'x', label: 'x', labelEn: 'x', stage: 'S9' }],
    });
    bad({
      ...SKELETON,
      attributes: [{ key: 'colour', label: 'x', labelEn: 'x' }],
    });
    bad(SKELETON, [{ key: 'a', primary: { node: 'stage', step: 'account' } }]);
    bad(SKELETON, [
      {
        key: 'a',
        primary: { node: 'cell', object: 'account', attribute: 'colour' },
      },
    ]);
  });
});

describe('mapSeedNodes', () => {
  it('lists parents before children, puts the rule table under rules. and takes deviations and cells from the placements', () => {
    const nodes = mapSeedNodes(parseMapSeed(SKELETON, PLACEMENTS));
    expect(nodes.map((n) => [n.key, n.kind, n.parentKey, n.stageKey])).toEqual([
      ['account', 'stage', null, null],
      ['account.verify', 'step', 'account', null],
      ['purchase', 'stage', null, null],
      ['purchase.pay', 'step', 'purchase', null],
      ['rules.account', 'object', null, 'account'],
      ['account.verify.no-email', 'deviation', 'account.verify', null],
      ['rules.account.definition', 'cell', 'rules.account', null],
      ['rules.account.price', 'cell', 'rules.account', null],
    ]);
    expect(nodes.find((n) => n.kind === 'deviation')).toMatchObject({
      labelEn: 'The email does not arrive',
      labelZh: '收不到邮件',
    });
    expect(nodes.find((n) => n.key === 'rules.account.price')).toMatchObject({
      attribute: 'price',
      labelEn: 'Price',
      labelZh: '价格',
    });
  });
});

describe('seedFaqMap', () => {
  it('builds the nodes, then each card with its primary place first, and reports cards it cannot find', async () => {
    const upserted: string[] = [];
    const placed: [string, { nodeKey: string; primary: boolean }[]][] = [];
    const report = await seedFaqMap(
      {
        map: {
          upsertNode: (input) => {
            upserted.push(input.key);
            return Promise.resolve({
              node: { key: input.key } as never,
              created: input.key !== 'account',
              changed: input.key !== 'account',
            });
          },
          setPlacements: (faqId, wanted) => {
            placed.push([faqId, [...wanted]]);
            return Promise.resolve({ placements: [], changed: wanted.length });
          },
        },
        faqs: {
          getByKey: (key) =>
            Promise.resolve(
              key === 'gone-card' ? null : ({ id: `id-${key}` } as HelpdeskFaq),
            ),
        },
      },
      parseMapSeed(SKELETON, PLACEMENTS),
      { employeeId: null },
    );
    expect(upserted).toHaveLength(8);
    expect(placed).toEqual([
      [
        'id-no-activation-email',
        [
          { nodeKey: 'account.verify.no-email', primary: true },
          { nodeKey: 'rules.account.definition', primary: false },
        ],
      ],
      ['id-how-to-pay', [{ nodeKey: 'purchase.pay', primary: true }]],
    ]);
    expect(report).toEqual({
      nodes: { created: upserted.slice(1), changed: [], unchanged: 1 },
      placements: { cards: 2, changed: 3, missingCards: ['gone-card'] },
    });
  });
});

/** v2（2026-11-02）：岔子写在 skeleton 的步骤里，没有卡也建；挂载只写岔子的 key。 */
const SKELETON_V2 = {
  ...SKELETON,
  stages: [
    {
      ...SKELETON.stages[0],
      steps: [
        {
          key: 'account.verify',
          label: '激活邮箱',
          labelEn: 'Verify email',
          deviations: [
            {
              key: 'account.verify.not-received',
              en: 'The email does not arrive',
              zh: '收不到激活邮件',
            },
            {
              key: 'account.verify.link-expired',
              labelEn: 'The link has expired',
              labelZh: '链接已过期',
            },
          ],
        },
      ],
    },
    SKELETON.stages[1],
  ],
};

describe('SOP tree v2 seeds (deviations in the skeleton)', () => {
  it('builds every skeleton deviation in order, with or without a card, and resolves a deviation placed by key', () => {
    const seed = parseMapSeed(SKELETON_V2, [
      {
        key: 'no-activation-email',
        primary: {
          node: 'deviation',
          deviation: 'account.verify.not-received',
        },
      },
    ]);
    expect(seed.placements[0].primary).toEqual({
      node: 'deviation',
      step: 'account.verify',
      deviation: {
        key: 'account.verify.not-received',
        en: 'The email does not arrive',
        zh: '收不到激活邮件',
      },
    });
    const deviations = mapSeedNodes(seed).filter((n) => n.kind === 'deviation');
    expect(
      deviations.map((n) => [n.key, n.parentKey, n.position, n.labelZh]),
    ).toEqual([
      ['account.verify.not-received', 'account.verify', 0, '收不到激活邮件'],
      ['account.verify.link-expired', 'account.verify', 1, '链接已过期'],
    ]);
  });

  it('refuses places that are not in the skeleton and keys that appear twice', () => {
    const bad = (skeleton: unknown, primary: unknown) =>
      expect(() => parseMapSeed(skeleton, [{ key: 'a', primary }])).toThrow(
        HelpdeskError,
      );
    bad(SKELETON_V2, { node: 'deviation', deviation: 'account.verify.gone' });
    bad(SKELETON_V2, { node: 'step', step: 'account.nowhere' });
    bad(SKELETON_V2, { node: 'cell', object: 'plan', attribute: 'price' });
    bad(SKELETON_V2, {
      node: 'deviation',
      step: 'account.nowhere',
      deviation: { key: 'account.nowhere.x', en: 'x', zh: 'x' },
    });
    type DeviationRow = { key: string; en: string; zh: string };
    const firstStepDeviations = (skeleton: typeof SKELETON_V2) =>
      (skeleton.stages[0].steps[0] as { deviations: DeviationRow[] })
        .deviations;
    const twice = structuredClone(SKELETON_V2);
    firstStepDeviations(twice).push({
      key: 'account.verify.not-received',
      en: 'again',
      zh: '又一次',
    });
    bad(twice, { node: 'step', step: 'account.verify' });
    const stepAsDeviation = structuredClone(SKELETON_V2);
    firstStepDeviations(stepAsDeviation).push({
      key: 'purchase.pay',
      en: 'x',
      zh: 'x',
    });
    bad(stepAsDeviation, { node: 'step', step: 'account.verify' });
  });
});

describe('pruneFaqMap', () => {
  const node = (
    id: string,
    key: string,
    kind: FaqMapNode['kind'],
    parentId: string | null = null,
    stageId: string | null = null,
    attribute: FaqMapNode['attribute'] = null,
  ) => ({ id, key, kind, parentId, stageId, attribute }) as FaqMapNode;

  it('deletes nodes the seed does not have or has elsewhere (with their children), leaves first, after taking cards off them', async () => {
    const nodes = [
      node('1', 'account', 'stage'),
      node('2', 'account.verify', 'step', '1'),
      node('3', 'account.verify.no-email', 'deviation', '2'),
      node('4', 'old', 'stage'),
      node('5', 'old.step', 'step', '4'),
      node('6', 'purchase', 'stage'),
      // purchase.pay 在种子里属于 purchase，这里挂错了阶段：要重建
      node('7', 'purchase.pay', 'step', '4'),
      node('8', 'rules.account', 'object', null, '4'),
      node('9', 'rules.account.price', 'cell', '8', null, 'price'),
    ];
    const calls: string[] = [];
    const report = await pruneFaqMap(
      {
        map: {
          nodes: () => Promise.resolve(nodes),
          placements: () =>
            Promise.resolve(
              [
                ['card-a', '3', true],
                ['card-a', '2', false],
                ['card-b', '2', true],
                ['card-c', '9', true],
              ].map(([faqId, nodeId, primary]) => ({
                id: `${faqId}-${nodeId}`,
                faqId: faqId as string,
                nodeId: nodeId as string,
                primary: primary as boolean,
                createdBy: null,
                createdAt: '',
              })),
            ),
          setPlacements: (faqId, wanted) => {
            calls.push(`place ${faqId} ${JSON.stringify(wanted)}`);
            return Promise.resolve({ placements: [], changed: 1 });
          },
          deleteNode: (id) => {
            calls.push(`delete ${id}`);
            return Promise.resolve(null);
          },
        },
      },
      parseMapSeed(SKELETON_V2, []),
      { employeeId: null },
    );
    expect(calls).toEqual([
      'place card-a [{"nodeKey":"account.verify","primary":false}]',
      'place card-c []',
      'delete 3',
      'delete 9',
      'delete 5',
      'delete 7',
      'delete 8',
      'delete 4',
    ]);
    expect(report).toEqual({
      deleted: [
        'account.verify.no-email',
        'rules.account.price',
        'old.step',
        'purchase.pay',
        'rules.account',
        'old',
      ],
      detached: 2,
    });
  });
});
