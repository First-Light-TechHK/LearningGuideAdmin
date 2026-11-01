import type { HelpdeskFaq } from '../modules/helpdesk/faqs/faqContracts';
import {
  mapSeedNodes,
  parseMapSeed,
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
