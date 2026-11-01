import type { LearnerState } from '../../contracts/helpdesk-qa';
import type { HelpdeskFaq } from '../modules/helpdesk/faqs/faqContracts';
import { checkFaqGraph } from '../modules/helpdesk/faqs/faqGraphChecks';
import {
  freezeMap,
  locatorHead,
  locatorIndex,
  mapProblems,
  type FaqMapNode,
  type FaqSnapshotMap,
} from '../modules/helpdesk/faqs/faqMap';
import {
  diffSnapshots,
  freezeSnapshot,
  snapshotHash,
} from '../modules/helpdesk/faqs/faqRelease';
import {
  attributeHints,
  questionType,
} from '../modules/helpdesk/faqs/locator/questionType';
import { stagePrior } from '../modules/helpdesk/faqs/locator/stagePrior';
import {
  rankStructured,
  type Placement,
  type ScoredCard,
} from '../modules/helpdesk/faqs/locator/structuredRank';

/**
 * 定位方式 B 与结合方案（设计文档「Helpdesk 定位方式对比」第三到五节）：问题类型、学员状态先验、
 * 结构排序（B1 / B2 / B3 / B3-hard、回退）、快照里的流程树与对象表（冻结、指纹不变、检查、差异）、
 * 运行时索引与「前 3 张」。
 */

const ID = (n: number) =>
  `0192aaaa-0000-7000-8000-${String(n).padStart(12, '0')}`;

function state(patch: Partial<LearnerState> = {}): LearnerState {
  return {
    accountAgeDays: 60,
    emailVerified: true,
    plans: [],
    courses: [],
    notStartedWithAccess: 0,
    studyGroups: {
      groups: 0,
      hosting: 0,
      upcomingSessions: 0,
      nextSessionInHours: null,
    },
    latestOrder: null,
    tickets: { open: 0, waitingOnUser: 0 },
    ...patch,
  };
}

describe('questionType', () => {
  it('reads process wording and process cards as process', () => {
    expect(questionType('怎么重设密码', ['how_to', 'troubleshoot'])).toBe(
      'process',
    );
    expect(questionType('How do I reset my password?', ['how_to'])).toBe(
      'process',
    );
  });

  it('reads content wording and rule cards as content', () => {
    expect(questionType('试用多久', ['rule', 'rule', 'how_to'])).toBe(
      'content',
    );
    expect(questionType('How much is the yearly plan?', ['rule'])).toBe(
      'content',
    );
  });

  it('says both when the wording and the cards disagree or say nothing', () => {
    // 句式偏流程，检索全是规则卡：1 + (-1) = 0
    expect(questionType('怎么收费', ['rule', 'rule'])).toBe('both');
    expect(questionType('你好', [])).toBe('both');
  });

  it('needs a larger signal with a larger margin', () => {
    // 句式 1 + 检索 2 × (2/3 − 0.5) ≈ 1.33：门槛 0.5 定边，门槛 1.5 不定
    const types = ['how_to', 'how_to', 'rule'] as const;
    expect(questionType('怎么取消', types, 0.5)).toBe('process');
    expect(questionType('怎么取消', types, 1.5)).toBe('both');
  });
});

describe('attributeHints', () => {
  it('finds the attributes the message asks about', () => {
    expect([...attributeHints('试用多久，结束会扣费吗')].sort()).toEqual([
      'price',
      'timing',
    ]);
    expect([...attributeHints('Who can see my notes?')]).toEqual([
      'eligibility',
      'visibility',
    ]);
    expect(attributeHints('hello').size).toBe(0);
  });
});

describe('stagePrior', () => {
  it('gives no prior without a state (signed out and no state look the same)', () => {
    expect(stagePrior(null).size).toBe(0);
    expect(stagePrior(undefined).size).toBe(0);
    expect(stagePrior(state()).size).toBe(0);
  });

  it('maps each state signal to its stage', () => {
    const prior = stagePrior(
      state({
        emailVerified: false,
        plans: [
          {
            source: 'trial',
            state: 'active',
            scope: 'everything',
            device: null,
            endsInDays: 3,
          },
        ],
        courses: [
          {
            courseId: 'C-1',
            title: 'T',
            status: 'in_progress',
            progress: 40,
            minutes: 100,
            lastStudiedDaysAgo: 1,
            hasAccess: true,
          },
        ],
        studyGroups: {
          groups: 0,
          hosting: 0,
          upcomingSessions: 1,
          nextSessionInHours: 12,
        },
        latestOrder: { status: 'failed', daysAgo: 2 },
        tickets: { open: 0, waitingOnUser: 1 },
      }),
    );
    expect([...prior].sort()).toEqual([
      'account',
      'group',
      'help',
      'learn',
      'manage',
      'purchase',
    ]);
  });

  it('ignores signals outside their windows', () => {
    const prior = stagePrior(
      state({
        plans: [
          {
            source: 'purchase',
            state: 'expired',
            scope: 'everything',
            device: null,
            endsInDays: -60,
          },
          {
            source: 'purchase',
            state: 'active',
            scope: 'course',
            device: null,
            endsInDays: 2,
          },
        ],
        latestOrder: { status: 'failed', daysAgo: 30 },
        studyGroups: {
          groups: 0,
          hosting: 0,
          upcomingSessions: 1,
          nextSessionInHours: 72,
        },
      }),
    );
    expect(prior.size).toBe(0);
  });
});

const step = (
  stage: Placement['stage'],
  key: string,
  primary = true,
): Placement => ({
  node: 'step',
  stage,
  step: key,
  primary,
});
const cell = (
  stage: Placement['stage'],
  object: string,
  attribute: Placement['attribute'],
  primary = true,
): Placement => ({ node: 'cell', stage, object, attribute, primary });

describe('rankStructured', () => {
  // 「怎么取消」：管理订阅里的取消步骤是对的；付款阶段的一张卡字词分最高
  const scored: ScoredCard[] = [
    {
      id: 'pay',
      score: 0.9,
      cardType: 'how_to',
      placements: [step('purchase', 'purchase.pay')],
    },
    {
      id: 'cancel',
      score: 0.8,
      cardType: 'how_to',
      placements: [step('manage', 'manage.cancel')],
    },
    {
      id: 'cancel-trial',
      score: 0.7,
      cardType: 'how_to',
      placements: [step('manage', 'manage.cancel')],
    },
    {
      id: 'refund',
      score: 0.6,
      cardType: 'how_to',
      placements: [step('manage', 'manage.refund')],
    },
    {
      id: 'trial-price',
      score: 0.85,
      cardType: 'rule',
      placements: [cell('purchase', 'trial', 'price')],
    },
  ];
  const flatTop = ['pay', 'trial-price', 'cancel', 'cancel-trial', 'refund'];

  it('B1 keeps only the cards of the question type, by score', () => {
    const r = rankStructured({
      scored,
      flatTop,
      type: 'process',
      prior: new Set(),
      attributes: new Set(),
      variant: 'B1',
      params: { fallback: 0, limit: 10 },
    });
    // 规则卡只在最后从全库候选补位
    expect(r.ids).toEqual([
      'pay',
      'cancel',
      'cancel-trial',
      'refund',
      'trial-price',
    ]);
  });

  it('B2 ranks the strongest region first, then by score inside the top steps', () => {
    const r = rankStructured({
      scored,
      flatTop,
      type: 'process',
      prior: new Set(),
      attributes: new Set(),
      variant: 'B2',
      params: { regions: 1, structured: 3, fallback: 0, limit: 3 },
    });
    // 管理订阅三张卡之和 > 付款阶段一张
    expect(r.regions).toEqual(['stage:manage']);
    expect(r.ids).toEqual(['cancel', 'cancel-trial', 'refund']);
    expect(r.fellBack).toBe(false);
  });

  it('B3 weights regions in the state prior softly; B3-hard keeps only them', () => {
    const lone: ScoredCard[] = [
      {
        id: 'a',
        score: 1,
        cardType: 'how_to',
        placements: [step('learn', 'learn.play')],
      },
      {
        id: 'b',
        score: 0.7,
        cardType: 'how_to',
        placements: [step('group', 'group.join')],
      },
    ];
    const run = (variant: 'B2' | 'B3' | 'B3-hard') =>
      rankStructured({
        scored: lone,
        flatTop: ['a', 'b'],
        type: 'process',
        prior: new Set(['group']),
        attributes: new Set(),
        variant,
        params: { regions: 1, structured: 1, fallback: 0, limit: 1, w: 0.5 },
      }).ids;
    expect(run('B2')).toEqual(['a']);
    // 0.7 × 1.5 = 1.05 > 1
    expect(run('B3')).toEqual(['b']);
    expect(run('B3-hard')).toEqual(['b']);
  });

  it('boosts rule cells whose attribute the message asks about', () => {
    const cells: ScoredCard[] = [
      {
        id: 'def',
        score: 1,
        cardType: 'rule',
        placements: [cell('purchase', 'trial', 'definition')],
      },
      {
        id: 'price',
        score: 0.9,
        cardType: 'rule',
        placements: [cell('purchase', 'trial', 'price')],
      },
    ];
    const r = rankStructured({
      scored: cells,
      flatTop: ['def', 'price'],
      type: 'content',
      prior: new Set(),
      attributes: new Set(['price']),
      variant: 'B2',
      params: { fallback: 0, limit: 2 },
    });
    expect(r.ids).toEqual(['price', 'def']);
  });

  it('falls back to the flat list when nothing scores or the structure is far off', () => {
    const none = rankStructured({
      scored: [],
      flatTop: ['x', 'y'],
      type: 'both',
      prior: new Set(),
      attributes: new Set(),
      variant: 'B2',
    });
    expect(none).toEqual({ ids: ['x', 'y'], regions: [], fellBack: true });
    // 内容题，只有流程卡命中 → 没有区域 → 回退
    const wrongType = rankStructured({
      scored,
      flatTop,
      type: 'content',
      prior: new Set(),
      attributes: new Set(),
      variant: 'B2',
      params: { theta: 2 },
    });
    expect(wrongType.fellBack).toBe(true);
  });

  it('adds the flat fallback after the structured cards, without duplicates', () => {
    const r = rankStructured({
      scored,
      flatTop: ['x', 'cancel', 'y'],
      type: 'process',
      prior: new Set(),
      attributes: new Set(),
      variant: 'B2',
      params: { regions: 1, structured: 2, fallback: 2, limit: 5 },
    });
    expect(r.ids).toEqual(['cancel', 'cancel-trial', 'x', 'y', 'refund']);
  });
});

/* ------------------------------------------------- 快照里的流程树与对象表 */

function mapNode(
  n: number,
  key: string,
  kind: FaqMapNode['kind'],
  parent: number | null,
  extra: Partial<FaqMapNode> = {},
): FaqMapNode {
  return {
    id: ID(n),
    key,
    kind,
    parentId: parent === null ? null : ID(parent),
    stageId: null,
    attribute: null,
    position: 0,
    labelEn: key,
    labelZh: key,
    version: 1,
    createdBy: null,
    updatedBy: null,
    createdAt: '2026-10-31T00:00:00.000Z',
    updatedAt: '2026-10-31T00:00:00.000Z',
    ...extra,
  };
}

const MAP_NODES: FaqMapNode[] = [
  mapNode(1, 'manage', 'stage', null),
  mapNode(2, 'manage.cancel', 'step', 1),
  mapNode(3, 'manage.cancel.button-missing', 'deviation', 2),
  mapNode(4, 'purchase', 'stage', null),
  mapNode(5, 'rules.trial', 'object', null, { stageId: ID(4) }),
  mapNode(6, 'rules.trial.price', 'cell', 5, { attribute: 'price' }),
];

function faq(n: number, question: string): HelpdeskFaq {
  return {
    id: ID(100 + n),
    key: `faq-${n}`,
    type: 'answer',
    entry: true,
    category: 'payments_subscriptions',
    popular: false,
    questionEn: question,
    answerEn: 'Answer.',
    questionZh: '问题',
    answerZh: '答案。',
    keywords: [],
    signals: [],
    status: 'published',
    version: 1,
    createdBy: null,
    updatedBy: null,
    createdAt: '2026-10-31T00:00:00.000Z',
    updatedAt: '2026-10-31T00:00:00.000Z',
  };
}

const FAQS = [
  faq(1, 'How do I cancel?'),
  faq(2, 'The cancel button is missing'),
  faq(3, 'Is the trial free?'),
  { ...faq(4, 'Old card'), status: 'archived' } as HelpdeskFaq,
];

const PLACEMENTS = [
  { faqId: ID(101), nodeId: ID(2), primary: true },
  { faqId: ID(102), nodeId: ID(3), primary: true },
  { faqId: ID(102), nodeId: ID(2), primary: false },
  { faqId: ID(103), nodeId: ID(6), primary: true },
  // 归档的卡：不进快照
  { faqId: ID(104), nodeId: ID(2), primary: true },
];

describe('freezeMap and the release snapshot', () => {
  it('freezes nodes by key and only placements of published cards', () => {
    const map = freezeMap(
      [...MAP_NODES].reverse(),
      PLACEMENTS,
      new Set([ID(101), ID(102), ID(103)]),
    )!;
    expect(map.nodes.map((n) => n.key)).toEqual([
      'manage',
      'manage.cancel',
      'manage.cancel.button-missing',
      'purchase',
      'rules.trial',
      'rules.trial.price',
    ]);
    expect(map.placements.map((p) => p.faqId)).toEqual([
      ID(101),
      ID(102),
      ID(102),
      ID(103),
    ]);
    expect(Object.keys(map.nodes[0]).sort()).toEqual(
      [
        'attribute',
        'id',
        'key',
        'kind',
        'labelEn',
        'labelZh',
        'parentId',
        'position',
        'stageId',
      ].sort(),
    );
  });

  it('leaves the snapshot and its hash exactly as before when there is no map', () => {
    const before = freezeSnapshot(FAQS, [], []);
    const withEmpty = freezeSnapshot(FAQS, [], [], {
      nodes: [],
      placements: PLACEMENTS,
    });
    expect('map' in before).toBe(false);
    expect(snapshotHash(withEmpty)).toBe(snapshotHash(before));
  });

  it('changes the hash and the diff when only the map changes', () => {
    const plain = freezeSnapshot(FAQS, [], []);
    const mapped = freezeSnapshot(FAQS, [], [], {
      nodes: MAP_NODES,
      placements: PLACEMENTS,
    });
    expect(snapshotHash(mapped)).not.toBe(snapshotHash(plain));
    const diff = diffSnapshots(plain, mapped);
    expect(diff.same).toBe(false);
    expect(diff.map).toEqual({ added: 6 + 4, removed: 0 });
    expect(diffSnapshots(mapped, mapped).same).toBe(true);
  });

  it('passes the graph checks with a well-formed map', () => {
    const snapshot = freezeSnapshot(FAQS, [], [], {
      nodes: MAP_NODES,
      placements: PLACEMENTS,
    });
    expect(checkFaqGraph(snapshot).problems).toEqual([]);
  });
});

describe('mapProblems', () => {
  const frozen = (
    nodes: FaqMapNode[],
    placements: { faqId: string; nodeId: string; primary: boolean }[],
  ): FaqSnapshotMap =>
    freezeMap(nodes, placements, new Set(placements.map((p) => p.faqId)))!;

  it('finds nodes at the wrong level', () => {
    const map = frozen(
      [
        ...MAP_NODES,
        mapNode(7, 'manage.bad', 'deviation', 1),
        mapNode(8, 'rules.bad-object', 'object', null),
        mapNode(9, 'rules.trial.bad', 'cell', 5),
        // 对象表的节点不在 rules. 下
        mapNode(10, 'device', 'object', null, { stageId: ID(4) }),
      ],
      [],
    );
    expect(mapProblems(map, () => null).map((p) => [p.rule, p.key])).toEqual([
      ['map_shape', 'device'],
      ['map_shape', 'manage.bad'],
      ['map_shape', 'rules.bad-object'],
      ['map_shape', 'rules.trial.bad'],
    ]);
  });

  it('finds cards on a stage or object, and cards without exactly one primary place', () => {
    const map = frozen(MAP_NODES, [
      { faqId: ID(101), nodeId: ID(1), primary: true },
      { faqId: ID(102), nodeId: ID(2), primary: false },
      { faqId: ID(103), nodeId: ID(6), primary: true },
    ]);
    const problems = mapProblems(map, (id) =>
      id === ID(102) ? 'faq-2' : null,
    );
    expect(problems.map((p) => p.rule)).toEqual([
      'map_placement',
      'map_primary',
    ]);
    expect(problems[1].detail).toContain('faq-2 has 0 primary places');
  });

  it('is reported by checkFaqGraph so the release cannot be published', () => {
    const snapshot = freezeSnapshot(FAQS, [], [], {
      nodes: MAP_NODES,
      placements: [{ faqId: ID(101), nodeId: ID(5), primary: true }],
    });
    const checks = checkFaqGraph(snapshot);
    expect(checks.passed).toBe(false);
    expect(checks.problems.map((p) => [p.rule, p.key])).toEqual([
      ['map_placement', 'faq-1'],
    ]);
  });
});

describe('locatorIndex and locatorHead', () => {
  const map = freezeMap(
    MAP_NODES,
    PLACEMENTS,
    new Set([ID(101), ID(102), ID(103)]),
  )!;

  it('resolves every placement to its stage, step or object, with the primary first', () => {
    const index = locatorIndex(map);
    expect(index.get(ID(101))).toEqual({
      cardType: 'how_to',
      placements: [
        { node: 'step', stage: 'manage', step: 'manage.cancel', primary: true },
      ],
    });
    expect(index.get(ID(102))).toEqual({
      cardType: 'troubleshoot',
      placements: [
        {
          node: 'deviation',
          stage: 'manage',
          step: 'manage.cancel',
          primary: true,
        },
        {
          node: 'step',
          stage: 'manage',
          step: 'manage.cancel',
          primary: false,
        },
      ],
    });
    expect(index.get(ID(103))).toEqual({
      cardType: 'rule',
      placements: [
        {
          node: 'cell',
          stage: 'purchase',
          object: 'rules.trial',
          attribute: 'price',
          primary: true,
        },
      ],
    });
    // 同一个快照对象只建一次
    expect(locatorIndex(map)).toBe(index);
  });

  it('puts the cards of the best region of the question type first, at most head of them', () => {
    const scored = [
      { id: ID(103), score: 0.9 },
      { id: ID(101), score: 0.5 },
      { id: ID(102), score: 0.4 },
      { id: ID(999), score: 1 },
    ];
    // 流程句式 + A 的前几张都是流程卡 → 只看流程树：规则卡分再高也不进
    expect(
      locatorHead({
        index: locatorIndex(map),
        text: 'How do I cancel my plan?',
        scored,
        flatTop: [ID(101), ID(102), ID(999)],
        head: 2,
      }),
    ).toEqual([ID(101), ID(102)]);
    // 分不出类型 → 两种结构都看：对象表那格（0.9）和管理订阅（0.5 + 0.4）一样强
    expect(
      locatorHead({
        index: locatorIndex(map),
        text: 'cancel',
        scored,
        flatTop: [ID(103), ID(101)],
        head: 2,
      }),
    ).toEqual([ID(103), ID(101)]);
  });

  it('returns nothing when no placed card matched (the flat list stays as it is)', () => {
    expect(
      locatorHead({
        index: locatorIndex(map),
        text: 'hello',
        scored: [{ id: ID(999), score: 1 }],
        flatTop: [ID(999)],
      }),
    ).toEqual([]);
    expect(
      locatorHead({
        index: new Map(),
        text: 'How do I cancel?',
        scored: [{ id: ID(101), score: 1 }],
        flatTop: [],
      }),
    ).toEqual([]);
  });
});
