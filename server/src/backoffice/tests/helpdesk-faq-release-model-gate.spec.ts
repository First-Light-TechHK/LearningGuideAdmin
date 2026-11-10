import {
  emptyAskStats,
  type EvalCacheMode,
} from '../../contracts/helpdesk-eval-cache';
import type {
  ReleaseAnswerer,
  ReleaseEvalAnswer,
} from '../../contracts/helpdesk-release-eval';
import type {
  FaqReleaseSnapshot,
  FaqSnapshotNode,
} from '../modules/helpdesk/faqs/faqRelease';
import type { FaqReleaseEvalProgress } from '../modules/helpdesk/faqs/faqReleaseGate';
import {
  MODEL_GATE,
  createModelReleaseGate,
  loadReleaseEvalItems,
  planQuestions,
  scoreModelAnswer,
  type EvalQuestion,
  type ReleaseEvalItem,
} from '../modules/helpdesk/faqs/faqReleaseModelGate';
import {
  followupParents,
  planFollowups,
  planScreens,
  scoreAsks,
} from '../modules/helpdesk/faqs/release-check/questions';
import { textHash } from '../modules/helpdesk/faqs/faqVectors';
import { wilson } from '../modules/helpdesk/faqs/release-check/stats';

/**
 * 发布前的真流程检查（release check v2，owner 2026-11-06 批准）：问哪些题、怎么判分、什么时候不通过：
 * 全部题、逐题和上线版本比、新出的错复问确认、漂移抽查、Wilson 区间上界、切片、库里没卡别给卡。
 * 2026-11-09（Fable 5.2 评审，owner 批准）：全部题只报不拦、盲测和线上两个方向比、答对率不比线上低、超时上限、
 * 待重标、题集过时上限、检索降级不算数、盲测库外题单列、「旧卡在屏问新问题」。
 * 答题器是假的（真的那个在 src/ai/helpdesk/release-answerer.ts，跑整条线上流程）。
 */
const id = (n: number) =>
  `0192d4f0-0000-7000-8000-${String(n).padStart(12, '0')}`;

function node(n: number, key: string, entry = true): FaqSnapshotNode {
  return {
    id: id(n),
    key,
    type: 'answer',
    entry,
    category: 'other',
    popular: false,
    questionEn: `Q ${key}`,
    answerEn: `A ${key}`,
    questionZh: `问 ${key}`,
    answerZh: `答 ${key}`,
    blocksEn: [],
    blocksZh: [],
    signals: [],
    keywords: [],
    version: 1,
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

// refund（入口）→ refund-late（追问）；password（入口）
const snapshot: FaqReleaseSnapshot = {
  nodes: [
    node(1, 'refund'),
    node(2, 'refund-late', false),
    node(3, 'password'),
  ],
  edges: [
    {
      parentId: id(1),
      childId: id(2),
      kind: 'follow_up',
      position: 0,
      labelEn: null,
      labelZh: null,
    },
  ],
  phrasings: [],
};

const items: ReleaseEvalItem[] = [
  {
    id: 'a1',
    locale: 'zh-CN',
    message: '怎么退款',
    expect: 'answer',
    faq: 'refund',
  },
  {
    id: 'a2',
    locale: 'en-GB',
    message: 'late refund?',
    expect: 'answer',
    faq: 'refund-late',
  },
  {
    id: 'a3',
    locale: 'zh-TW',
    message: '忘記密碼',
    expect: 'answer',
    faq: 'password',
    acceptable: ['refund'],
  },
  {
    id: 'a4',
    locale: 'mixed',
    message: 'gone card',
    expect: 'answer',
    faq: 'not-in-this-library',
  },
  { id: 'n1', locale: 'en-GB', message: 'do my homework', expect: 'no_match' },
  { id: 's1', locale: 'zh-CN', message: '你好', expect: 'smalltalk' },
];

const answer = (
  kind: ReleaseEvalAnswer['kind'],
  nodeId: string | null = null,
  costUsd = 0.0001,
  extra: Partial<ReleaseEvalAnswer> = {},
): ReleaseEvalAnswer => ({
  kind,
  nodeId,
  costUsd,
  unpricedCalls: 0,
  ...extra,
});

type Asked = {
  version: number;
  message: string;
  locale: string;
  cache: EvalCacheMode;
  /** 追问：屏幕上开着的卡（节点 id）。 */
  screen: string | null;
  recentTurns: readonly string[];
};

/** 假答题器：reply 看得到问的是哪一版、缓存怎么用。 */
function fakeAnswerer(
  reply: (message: string, asked: Asked) => ReleaseEvalAnswer,
  available = true,
) {
  const asked: Asked[] = [];
  const answerer: ReleaseAnswerer = {
    available: () => available,
    model: () => 'google/gemma-4-31b-it',
    forRelease: ({ version }) => ({
      ask: ({ message, locale, cache = 'use', screen }) => {
        const one = {
          version,
          message,
          locale,
          cache,
          screen: screen?.nodeId ?? null,
          recentTurns: screen?.recentTurns ?? [],
        };
        asked.push(one);
        return Promise.resolve(reply(message, one));
      },
    }),
  };
  return { answerer, asked };
}

const input = (
  extra: Partial<
    Parameters<ReturnType<typeof createModelReleaseGate>['evaluate']>[0]
  > = {},
) => ({
  version: 2,
  snapshot,
  previous: null,
  ...extra,
});

const live = { version: 1, evalReport: null, snapshot };

/** 这些用例各看一件事：缺省不加「旧卡在屏」的题（它们有自己的一组用例，直接用 createModelReleaseGate）。 */
const gate = (deps: Parameters<typeof createModelReleaseGate>[0]) =>
  createModelReleaseGate({
    ...deps,
    limits: { screenSample: 0, ...deps.limits },
  });

const fixed = () => new Date('2026-11-06T10:00:00.000Z');

/** n 道问退款的题（够多，错卡率的区间上界才可能 ≤ 2%：0 / 190 道的上界约 2%）。 */
const refunds = (
  n: number,
  set: 'blind' | 's650' = 's650',
): ReleaseEvalItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${set}-${String(i).padStart(4, '0')}`,
    set,
    locale: i % 2 === 0 ? 'zh-CN' : 'en-GB',
    message: `refund question ${set} ${i}`,
    expect: 'answer',
    faq: 'refund',
  }));

const right = (message: string) =>
  message === '怎么退款' || message === 'late refund?'
    ? answer('answer', id(1))
    : message === '忘記密碼'
      ? answer('answer', id(3))
      : message === '你好'
        ? answer('smalltalk')
        : message.startsWith('refund question')
          ? answer('answer', id(1))
          : answer('no_match');

describe('the live-pipeline check: which questions', () => {
  it('ships the eval-v6 dev split only (275 blind + 1,409 S650 questions for library v3.5, never the test split)', () => {
    const all = loadReleaseEvalItems();
    expect(all).toHaveLength(1684);
    expect(all.filter((item) => item.set === 'blind')).toHaveLength(275);
    expect(all.filter((item) => item.set === 's650')).toHaveLength(1409);
    expect(new Set(all.map((item) => item.id)).size).toBe(all.length);
    expect(new Set(all.map((item) => item.expect))).toEqual(
      new Set(['answer', 'no_match', 'smalltalk']),
    );
    for (const item of all) {
      expect(
        Object.keys(item).every((k) =>
          [
            'id',
            'set',
            'locale',
            'style',
            'message',
            'expect',
            'faq',
            'acceptable',
            'asks',
          ].includes(k),
        ),
      ).toBe(true);
      if (item.expect === 'answer') expect(typeof item.faq).toBe('string');
    }
    // 一句多问的 118 道题逐件标了卡（AI 标注），按问的顺序；库里没卡的那件 = null
    const multi = all.filter((item) => item.asks);
    expect(multi).toHaveLength(118);
    for (const item of multi) {
      expect([2, 3]).toContain(item.asks?.length);
      for (const ask of item.asks ?? []) {
        expect(
          Object.keys(ask).every((k) => ['faq', 'acceptable'].includes(k)),
        ).toBe(true);
        expect(ask.faq === null || typeof ask.faq === 'string').toBe(true);
      }
    }
  });

  it('asks every question (no sampling): maps keys to this release, keeps the entry card of a follow-up apart, skips cards this release lacks and asks each text once', () => {
    const { questions, skipped } = planQuestions({
      items: [...items, { ...items[0], id: 'dup' }],
      snapshot,
      changed: new Set(['password']),
      regression: [],
    });
    expect(skipped).toBe(1);
    expect(questions.map((q) => q.id)).toEqual(['a1', 'a2', 'a3', 'n1', 's1']);
    const byId = new Map(questions.map((q) => [q.id, q]));
    expect(byId.get('a2')).toMatchObject({
      locale: 'en-GB',
      language: 'en-GB',
      faqId: id(2),
      acceptable: [],
      entryIds: [id(1)],
      changed: false,
    });
    // zh-TW and mixed are asked the way Portal sends them (zh-CN); slices keep the original language
    expect(byId.get('a3')).toMatchObject({
      locale: 'zh-CN',
      language: 'zh-TW',
      faqId: id(3),
      acceptable: [id(1)],
      entryIds: [],
      changed: true,
    });
    expect(byId.get('n1')).toMatchObject({ expect: 'no_match', faqId: null });
    expect(questions.every((q) => q.set === 's650')).toBe(true);
  });

  it('one message, several asks: maps each ask to this release in the order asked; a card this release lacks is no card; one ask is not several', () => {
    const { questions } = planQuestions({
      items: [
        {
          id: 'm1',
          locale: 'zh-CN',
          message: '怎么退款？密码忘了怎么办？还有作业能代写吗',
          expect: 'answer',
          faq: 'refund',
          asks: [
            { faq: 'refund-late', acceptable: ['refund', 'gone'] },
            { faq: 'password' },
            { faq: null },
            { faq: 'not-in-this-library' },
          ],
        },
        {
          ...items[2],
          id: 'm2',
          message: 'one ask',
          asks: [{ faq: 'password' }],
        },
      ],
      snapshot,
      changed: new Set(),
      regression: [{ faqId: id(3), locale: 'zh-CN', text: '登录不上了' }],
    });
    const byId = new Map(questions.map((q) => [q.id, q]));
    expect(byId.get('m1')?.asks).toEqual([
      { faqId: id(2), acceptable: [id(1)], entryIds: [] },
      { faqId: id(3), acceptable: [], entryIds: [] },
      { faqId: null, acceptable: [], entryIds: [] },
      { faqId: null, acceptable: [], entryIds: [] },
    ]);
    expect(byId.get('m2')?.asks).toBeNull();
    expect(questions.find((q) => q.set === 'regression')?.asks).toBeNull();
  });

  it("adds the regression cases for cards in this release, never one that is its own card's question or phrasing (a leak)", () => {
    const withPhrasing: FaqReleaseSnapshot = {
      ...snapshot,
      phrasings: [{ faqId: id(3), locale: 'zh-CN', text: '密码又忘了怎么办' }],
    };
    const { questions, skipped, leaked } = planQuestions({
      items: [],
      snapshot: withPhrasing,
      changed: new Set(),
      regression: [
        // the phrasing itself, in traditional script and without the punctuation
        { faqId: id(3), locale: 'zh-TW', text: '密碼又忘了 怎麼辦？' },
        // the card's own question
        { faqId: id(3), locale: 'en-GB', text: 'q password' },
        // another card's phrasing is a fair question for this card
        { faqId: id(1), locale: 'zh-CN', text: '密码又忘了怎么办' },
        { faqId: id(3), locale: 'zh-CN', text: '登录不上了' },
        { faqId: id(99), locale: 'en-GB', text: 'a card that is gone' },
      ],
    });
    expect(leaked).toBe(2);
    expect(skipped).toBe(1);
    expect(questions.map((q) => [q.set, q.faqId, q.message])).toEqual([
      ['regression', id(1), '密码又忘了怎么办'],
      ['regression', id(3), '登录不上了'],
    ]);
  });
});

describe('the live-pipeline check: a question set that goes stale (2026-11-09)', () => {
  it("does not ask a dev question that is its own card's question or phrasing: adding a missed question as a phrasing must not teach the check", () => {
    const taught: FaqReleaseSnapshot = {
      ...snapshot,
      phrasings: [
        // a1's own words, now a phrasing of its labelled card
        { faqId: id(1), locale: 'zh-CN', text: '怎么退款' },
        // a3 (忘記密碼, labelled password, refund also acceptable): a phrasing of the acceptable card, in simplified script
        { faqId: id(1), locale: 'zh-CN', text: '忘记密码' },
        // a2's words as a phrasing of another card: still a fair question for refund-late
        { faqId: id(3), locale: 'en-GB', text: 'late refund?' },
      ],
    };
    const { questions, leakedDev, leaked } = planQuestions({
      items,
      snapshot: taught,
      changed: new Set(),
      regression: [],
    });
    expect(leakedDev).toBe(2);
    expect(leaked).toBe(0);
    expect(questions.map((q) => q.id)).toEqual(['a2', 'n1', 's1']);
    expect(
      planQuestions({
        items,
        snapshot,
        changed: new Set(),
        regression: [],
      }).leakedDev,
    ).toBe(0);
  });

  it('fails when too many labelled questions can no longer be scored (card gone, own wording, or awaiting a relabel)', async () => {
    const gone: ReleaseEvalItem[] = Array.from({ length: 14 }, (_, i) => ({
      id: `gone-${i}`,
      locale: 'en-GB',
      message: `archived ${i}`,
      expect: 'answer',
      faq: 'archived-card',
    }));
    // 13 of 263 skipped (4.9%): reported, still a pass
    const some = await gate({
      answerer: fakeAnswerer(right).answerer,
      items: () => [...refunds(250), ...gone.slice(0, 13)],
      now: fixed,
    }).evaluate(input());
    expect(some.passed).toBe(true);
    expect(some.metrics).toMatchObject({ skippedCases: 13, devLeaked: 0 });
    // 14 of 264 (5.3%): the check is running on a shrinking set
    const many = await gate({
      answerer: fakeAnswerer(right).answerer,
      items: () => [...refunds(250), ...gone],
      now: fixed,
    }).evaluate(input());
    expect(many.passed).toBe(false);
    expect(many.summary).toContain(
      "14 of 264 labelled questions could not be scored (14 whose card is gone, 0 that are their own card's wording, 0 answered by a card new in this release) > 5.0%: the question set needs relabelling",
    );
  });

  it('a card added in this release that answers a question labelled otherwise is "to relabel", not newly wrong: writing a card for an out-of-library question must not block the release', async () => {
    // the live version has no homework card; this release adds one (and splits "late refund" out of refund)
    const added: FaqReleaseSnapshot = {
      ...snapshot,
      nodes: [...snapshot.nodes, node(4, 'homework'), node(5, 'refund-fee')],
    };
    const more: ReleaseEvalItem[] = [
      {
        id: 'n1',
        locale: 'en-GB',
        message: 'do my homework',
        expect: 'no_match',
      },
      {
        id: 'f1',
        locale: 'en-GB',
        message: 'is there a refund fee',
        expect: 'answer',
        faq: 'refund',
      },
    ];
    const reply = (message: string, a: Asked) =>
      a.version === 2 && message === 'do my homework'
        ? answer('answer', id(4))
        : message === 'is there a refund fee'
          ? answer('answer', a.version === 2 ? id(5) : id(1))
          : right(message);
    const { answerer, asked } = fakeAnswerer(reply);
    const report = await gate({
      answerer,
      items: () => [...refunds(400), ...more],
      now: fixed,
    }).evaluate(input({ snapshot: added, previous: live }));
    expect(report.passed).toBe(true);
    expect(report.metrics).toMatchObject({
      relabel: 2,
      wrongCards: 0,
      newlyWrong: 0,
      cardWhenNone: 0,
      // "is there a refund fee" was right on live and is unlabelled now: not a lost right answer either
      lostRight: 0,
    });
    // nothing to confirm: not asked again
    expect(asked.filter((a) => a.cache === 'bypass')).toEqual([]);
    expect(report.misses).toEqual([
      expect.objectContaining({
        id: 'f1',
        why: 'relabel',
        expected: 'refund',
        got: 'answer:refund-fee',
      }),
      expect.objectContaining({
        id: 'n1',
        why: 'relabel',
        expected: 'no_match',
        got: 'answer:homework',
      }),
    ]);
    // a card the live version already had gets no such pass: that is a new wrong card
    const old = await gate({
      answerer: fakeAnswerer((message, a) =>
        a.version === 2 && message === 'do my homework'
          ? answer('answer', id(3))
          : reply(message, a),
      ).answerer,
      items: () => [...refunds(400), ...more],
      now: fixed,
    }).evaluate(input({ snapshot: added, previous: live }));
    expect(old.passed).toBe(false);
    expect(old.metrics).toMatchObject({ relabel: 1, confirmedWorse: 1 });
    // with no live version every card is "new": the rule does not apply, a wrong card is a wrong card
    const first = await gate({
      answerer: fakeAnswerer((message) =>
        message === 'do my homework' ? answer('answer', id(4)) : right(message),
      ).answerer,
      items: () => [...refunds(400), ...more],
      now: fixed,
    }).evaluate(input({ snapshot: added }));
    expect(first.metrics).toMatchObject({ relabel: 0, cardWhenNone: 1 });
  });
});

describe('the live-pipeline check: a new question with another card on screen (2026-11-09)', () => {
  // refund → refund-late; password; billing; trial
  const wide: FaqReleaseSnapshot = {
    ...snapshot,
    nodes: [...snapshot.nodes, node(4, 'billing'), node(5, 'trial')],
  };
  const singles = () =>
    planQuestions({
      items: [
        ...items,
        {
          id: 'm1',
          locale: 'en-GB',
          message: 'refund and password',
          expect: 'answer',
          faq: 'refund',
          asks: [{ faq: 'refund' }, { faq: 'password' }],
        },
      ],
      snapshot: wide,
      changed: new Set(),
      regression: [{ faqId: id(3), locale: 'zh-CN', text: '登录不上了' }],
    }).questions;

  it('asks a sample of the dev questions again with an unrelated card on screen, the expected answer unchanged', () => {
    const screens = planScreens({
      questions: singles(),
      snapshot: wide,
      sample: 10,
    });
    // small talk, several asks in one message and regression cases are not sampled
    expect(screens.map((q) => q.id).sort()).toEqual([
      'screen:a1',
      'screen:a2',
      'screen:a3',
      'screen:n1',
    ]);
    const byId = new Map(screens.map((q) => [q.id, q]));
    const bare = new Map(singles().map((q) => [q.id, q]));
    for (const q of screens) {
      const from = bare.get(q.id.replace('screen:', ''));
      expect(q).toMatchObject({
        set: 'screen',
        message: from?.message,
        expect: from?.expect,
        faqId: from?.faqId,
        acceptable: from?.acceptable,
        entryIds: from?.entryIds,
      });
      // never the labelled card, an acceptable one, its entry card, or their parent / child
      const own = [q.faqId, ...q.acceptable, ...q.entryIds];
      expect(own).not.toContain(q.screen?.nodeId);
    }
    // a2 is labelled refund-late (child of refund): neither of them goes on screen
    expect(['password', 'billing', 'trial']).toContain(
      byId.get('screen:a2')?.screen?.key,
    );
    // a1 is labelled refund: its child refund-late does not go on screen either
    expect(byId.get('screen:a1')?.screen?.key).not.toBe('refund-late');
    // the earlier turn is the question of the card on screen, in the learner's language
    const a2 = byId.get('screen:a2');
    expect(a2?.screen?.recentTurns).toEqual([`Q ${a2?.screen?.key}`]);
    const n1 = byId.get('screen:n1');
    expect(wide.nodes.map((n) => n.key)).toContain(n1?.screen?.key);
  });

  it('picks the same questions and the same card every time, and a new card moves only the questions it wins', () => {
    const many = planQuestions({
      items: refunds(60),
      snapshot: wide,
      changed: new Set(),
      regression: [],
    }).questions;
    const first = planScreens({ questions: many, snapshot: wide, sample: 20 });
    expect(first).toHaveLength(20);
    expect(
      planScreens({ questions: many, snapshot: wide, sample: 20 }),
    ).toEqual(first);
    expect(planScreens({ questions: many, snapshot: wide, sample: 0 })).toEqual(
      [],
    );
    const grown: FaqReleaseSnapshot = {
      ...wide,
      nodes: [...wide.nodes, node(6, 'certificate')],
    };
    const second = planScreens({
      questions: many,
      snapshot: grown,
      sample: 20,
    });
    expect(second.map((q) => q.id)).toEqual(first.map((q) => q.id));
    const moved = second.filter(
      (q, i) => q.screen?.key !== first[i].screen?.key,
    );
    // every question that changed its card changed to the new one; the rest keep theirs (and their cache)
    expect(moved.every((q) => q.screen?.key === 'certificate')).toBe(true);
    expect(moved.length).toBeLessThan(second.length);
  });

  it('tracks them as their own suite against the same questions with no card on screen, out of the single-question numbers', async () => {
    const { answerer, asked } = fakeAnswerer((message, a) =>
      // with an old card on screen the model treats 3 new questions as follow-ups of it (on both versions)
      a.screen !== null && /^refund question s650 [0-2]$/.test(message)
        ? answer('answer', a.screen)
        : right(message),
    );
    const report = await createModelReleaseGate({
      answerer,
      items: () => refunds(250),
      now: fixed,
      limits: { screenSample: 250 },
    }).evaluate(
      input({ snapshot: wide, previous: { ...live, snapshot: wide } }),
    );
    const onScreen = asked.filter((a) => a.screen !== null && a.version === 2);
    expect(onScreen).toHaveLength(250);
    expect(onScreen.every((a) => a.recentTurns.length === 1)).toBe(true);
    expect(report.metrics).toMatchObject({
      cases: 250,
      screenCases: 250,
      wrongCards: 0,
    });
    const suites = new Map(report.suites?.map((s) => [s.id, s]));
    expect(suites.get('screen')).toMatchObject({
      status: 'track',
      rule: 'paired',
      n: 250,
      passed: true,
      metrics: {
        wrongCards: 3,
        rightRate: 0.988,
        screenPairs: 250,
        screenChanged: 3,
        screenLost: 3,
        bareRight: 250,
      },
    });
    expect(suites.get('combined')?.n).toBe(250);
    expect(suites.get('s650')?.n).toBe(250);
    // the same on both versions: tracked, not a fail
    expect(report.passed).toBe(true);
    expect(report.misses[0]).toMatchObject({
      set: 'screen',
      why: 'wrong_card',
      onScreen: expect.any(String) as unknown,
    });
  });

  it('a question with a card on screen that is newly wrong against the live version fails the check', async () => {
    const { answerer } = fakeAnswerer((message, a) =>
      a.screen !== null && a.version === 2 && message.endsWith(' 0')
        ? answer('answer', a.screen)
        : right(message),
    );
    const report = await createModelReleaseGate({
      answerer,
      items: () => refunds(250),
      now: fixed,
      limits: { screenSample: 250 },
    }).evaluate(
      input({ snapshot: wide, previous: { ...live, snapshot: wide } }),
    );
    expect(report.passed).toBe(false);
    expect(report.summary).toContain('newly wrong against the live version');
    expect(report.misses[0]).toMatchObject({
      set: 'screen',
      why: 'newly_wrong',
    });
  });

  it('samples 200 by default, and the estimate counts them with the questions that have a card on screen', async () => {
    expect(MODEL_GATE.screenSample).toBe(200);
    const check = createModelReleaseGate({
      answerer: fakeAnswerer(right).answerer,
      items: () => refunds(250),
      now: fixed,
    });
    const estimate = await check.estimate?.({
      snapshot: wide,
      previous: {
        version: 1,
        evalReport: {
          kind: 'model',
          metrics: { paidQuestionUsd: 0.0005 },
          candidatePool: { [id(3)]: 25 },
        },
        snapshot: {
          ...wide,
          nodes: wide.nodes.map((n) =>
            n.id === id(3) ? { ...n, answerZh: '旧的答案' } : n,
          ),
        },
      },
    });
    // 25 of 250 single questions had password among their candidates: a tenth of the 200 on-screen ones too
    expect(estimate).toMatchObject({
      questions: 450,
      single: 250,
      followups: 200,
      paid: 25 + 20 + MODEL_GATE.driftSample,
    });
  });
});

describe('the live-pipeline check: scoring', () => {
  const byId = new Map(
    planQuestions({
      items,
      snapshot,
      changed: new Set(),
      regression: [],
    }).questions.map((q) => [q.id, q]),
  );
  const q = (key: string) => byId.get(key) as EvalQuestion;

  it('counts another card as a wrong card and no card as not answered; a timeout is a miss, any other failure is a broken check', () => {
    expect(scoreModelAnswer(q('a1'), answer('answer', id(1)))).toMatchObject({
      right: true,
      wrongCard: false,
    });
    expect(scoreModelAnswer(q('a1'), answer('answer', id(3)))).toMatchObject({
      right: false,
      wrongCard: true,
      cardWhenNone: false,
    });
    expect(scoreModelAnswer(q('a1'), answer('no_match'))).toMatchObject({
      right: false,
      wrongCard: false,
    });
    expect(
      scoreModelAnswer(
        q('a1'),
        answer('error', null, 0, { failure: 'timeout' }),
      ),
    ).toMatchObject({ timeout: true, error: false, wrongCard: false });
    expect(
      scoreModelAnswer(
        q('a1'),
        answer('error', null, 0, { failure: 'no_key' }),
      ),
    ).toMatchObject({ timeout: false, error: true });
  });

  it('the entry card that leads to the labelled follow-up is right, counted on its own', () => {
    expect(scoreModelAnswer(q('a2'), answer('answer', id(1)))).toMatchObject({
      right: true,
      viaEntry: true,
    });
  });

  it('a card on a no-match question is a wrong card of its own kind; a card on small talk is only an extra card (R3)', () => {
    expect(scoreModelAnswer(q('n1'), answer('answer', id(1)))).toMatchObject({
      wrongCard: true,
      cardWhenNone: true,
    });
    expect(
      scoreModelAnswer(q('n1'), {
        ...answer('clarify', id(1)),
        covered: false,
      }),
    ).toMatchObject({ right: true, wrongCard: false });
    expect(
      scoreModelAnswer(q('n1'), { ...answer('clarify', id(1)), covered: true }),
    ).toMatchObject({ right: false, wrongCard: false });
    expect(scoreModelAnswer(q('s1'), answer('answer', id(1)))).toMatchObject({
      wrongCard: false,
      extraCard: true,
    });
  });

  it('one message, several asks: right when any card of the reply is the labelled one, wrong when none is', () => {
    expect(
      scoreModelAnswer(q('a1'), { ...answer('answer', id(3)), more: [id(1)] }),
    ).toMatchObject({ right: true, wrongCard: false, viaEntry: false });
    expect(
      scoreModelAnswer(q('a1'), { ...answer('answer', id(3)), more: [id(4)] }),
    ).toMatchObject({ right: false, wrongCard: true });
    expect(
      scoreModelAnswer(q('n1'), { ...answer('answer', id(3)), more: [id(1)] }),
    ).toMatchObject({ wrongCard: true, cardWhenNone: true });
  });

  it('several asks: counts per ask which got its card, cards that answer no ask, the order, and asks said to have no answer', () => {
    const [m] = planQuestions({
      items: [
        {
          id: 'm1',
          locale: 'en-GB',
          message: 'refund? password? homework?',
          expect: 'answer',
          faq: 'refund',
          asks: [{ faq: 'refund' }, { faq: 'password' }, { faq: null }],
        },
      ],
      snapshot,
      changed: new Set(),
      regression: [],
    }).questions;
    // both cards, in the order asked, and the third ask said to have no answer
    expect(
      scoreAsks(m, { ...answer('answer', id(1)), more: [id(3)], missed: 1 }),
    ).toEqual({
      asks: 2,
      covered: 2,
      noCard: 1,
      missedSaid: 1,
      stray: 0,
      inOrder: true,
    });
    // the order turned round, and a card no ask was about
    expect(
      scoreAsks(m, { ...answer('answer', id(3)), more: [id(2), id(1)] }),
    ).toMatchObject({ covered: 2, stray: 1, inOrder: false, missedSaid: 0 });
    // a follow-up card under the asked card is not that card; no card at all covers nothing
    expect(scoreAsks(m, answer('answer', id(2)))).toMatchObject({
      covered: 0,
      stray: 1,
      inOrder: null,
    });
    expect(scoreAsks(m, answer('no_match'))).toMatchObject({
      covered: 0,
      stray: 0,
    });
    expect(scoreAsks(q('a1'), answer('answer', id(1)))).toBeNull();
  });

  it('judges a rate on its 95% Wilson upper bound', () => {
    expect(wilson(0, 1684).high).toBeCloseTo(0.00228, 5);
    expect(wilson(1, 400).high).toBeCloseTo(0.01402, 5);
    // five questions cannot show 2%: nothing wrong still has an upper bound of 43%
    expect(wilson(0, 5).high).toBeCloseTo(0.43448, 5);
  });
});

describe('the live-pipeline check: pass or fail', () => {
  it('passes with every question right on both versions, reporting progress, suites, spend and the receipt', async () => {
    const { answerer, asked } = fakeAnswerer((message) => right(message));
    const progress: FaqReleaseEvalProgress[] = [];
    const prepared: number[] = [];
    const report = await gate({
      answerer,
      items: () => [...items, ...refunds(250)],
      prepare: (version) => Promise.resolve(prepared.push(version)),
      now: fixed,
      limits: { progressEvery: 50 },
    }).evaluate(
      input({
        previous: live,
        progress: (p) => Promise.resolve(Boolean(progress.push(p))),
      }),
    );
    expect(report).toMatchObject({ kind: 'model', passed: true });
    expect(report.summary).toContain('google/gemma-4-31b-it');
    expect(report.summary).toContain('95% upper');
    expect(report.metrics).toMatchObject({
      cases: 255,
      wrongCards: 0,
      wrongRate: 0,
      errors: 0,
      skippedCases: 1,
      rightRate: 1,
      viaEntry: 1,
      newlyWrong: 0,
      liveWrongRate: 0,
    });
    // both versions are asked every question, with the cache
    expect(asked.filter((a) => a.version === 2)).toHaveLength(255);
    expect(asked.filter((a) => a.version === 1)).toHaveLength(255);
    expect(new Set(asked.map((a) => a.cache))).toEqual(new Set(['use']));
    expect(report.metrics.costUsd).toBeCloseTo(0.051, 6);
    expect(report.metrics.costLiveUsd).toBeCloseTo(0.0255, 6);
    expect(prepared).toEqual([2, 1]);
    expect(progress[0]).toEqual({ stage: 'vectors', done: 0, total: 1 });
    expect(progress.at(-1)).toEqual({ stage: 'model', done: 255, total: 255 });
    const suites = new Map(report.suites?.map((s) => [s.id, s]));
    // "all questions" is the headline number, never a gate of its own (2026-11-09); S650 is the absolute gate
    expect(suites.get('combined')).toMatchObject({
      status: 'track',
      passed: true,
    });
    expect(suites.get('s650')).toMatchObject({ status: 'gate', n: 255 });
    // a language slice below 200 questions is only tracked
    expect(suites.get('language:zh-TW')).toMatchObject({
      status: 'track',
      rule: 'point',
      n: 1,
    });
    expect(suites.get('s650')?.rule).toBe('interval');
    expect(report.receipt).toMatchObject({
      model: 'google/gemma-4-31b-it',
      questions: 255,
      liveVersion: 1,
      devSet: 'eval-v6-dev',
      wrongRateMax: 0.02,
      sliceMin: 200,
      rightDropMax: 0.01,
    });
  });

  it('fails when the 95% upper bound of wrong cards is above 2%, and lists the misses with keys', async () => {
    const { answerer } = fakeAnswerer((message, asked) =>
      message === 'refund question s650 0' && asked.version === 2
        ? answer('answer', id(3))
        : right(message),
    );
    // 1 wrong of 250: 0.4%, upper bound 2.2%
    const report = await gate({
      answerer,
      items: () => refunds(250),
      now: fixed,
    }).evaluate(input());
    expect(report.passed).toBe(false);
    expect(report.summary).toContain('wrong card 0.4% (95% upper 2.2%) > 2.0%');
    expect(report.misses).toEqual([
      {
        id: 's650-0000',
        set: 's650',
        locale: 'zh-CN',
        text: 'refund question s650 0',
        expected: 'refund',
        got: 'answer:password',
        why: 'wrong_card',
      },
    ]);
  });

  it('a question newly wrong against the live version fails only when asking again without the cache still gets it wrong', async () => {
    const wrongOnce = (stays: boolean) =>
      fakeAnswerer((message, asked) =>
        message === 'refund question s650 7' &&
        asked.version === 2 &&
        (asked.cache === 'use' || stays)
          ? answer('answer', id(3))
          : right(message),
      );
    const real = wrongOnce(true);
    // 1 wrong of 400 is within 2% (upper 1.4%), but it is new: the card change broke it
    const failed = await gate({
      answerer: real.answerer,
      items: () => refunds(400),
      now: fixed,
    }).evaluate(input({ previous: live }));
    expect(failed.passed).toBe(false);
    expect(failed.metrics).toMatchObject({
      wrongCards: 1,
      newlyWrong: 1,
      confirmedWorse: 1,
    });
    expect(failed.summary).toContain('newly wrong against the live version');
    expect(failed.misses[0]).toMatchObject({
      id: 's650-0007',
      why: 'newly_wrong',
      live: 'answer:refund',
    });
    expect(real.asked.filter((a) => a.cache === 'bypass')).toHaveLength(
      MODEL_GATE.reaskTimes,
    );
    // the same question right on both re-asks: the model wobbled once, the cards are fine
    const noise = await gate({
      answerer: wrongOnce(false).answerer,
      items: () => refunds(400),
      now: fixed,
    }).evaluate(input({ previous: live }));
    expect(noise.passed).toBe(true);
    expect(noise.metrics).toMatchObject({ newlyWrong: 1, confirmedWorse: 0 });
  });

  it('the blind set is compared with the live version: its own rate never fails it, a newly wrong blind question does', async () => {
    const blindWrong = (alsoLive: boolean) =>
      fakeAnswerer((message, asked) =>
        message === 'refund question blind 0' &&
        (asked.version === 2 || alsoLive)
          ? answer('answer', id(3))
          : right(message),
      ).answerer;
    const all = () => [...refunds(400), ...refunds(10, 'blind')];
    // 1 of 10 blind wrong (10%) on both versions: not a fail, though the suite is a gate (paired with live)
    const same = await gate({
      answerer: blindWrong(true),
      items: all,
      now: fixed,
    }).evaluate(input({ previous: live }));
    expect(same.passed).toBe(true);
    expect(same.suites?.find((s) => s.id === 'blind')).toMatchObject({
      status: 'gate',
      rule: 'paired',
      passed: true,
      metrics: { wrongRate: 0.1 },
    });
    const worse = await gate({
      answerer: blindWrong(false),
      items: all,
      now: fixed,
    }).evaluate(input({ previous: live }));
    expect(worse.passed).toBe(false);
  });

  it('"all questions" is reported, not a gate: blind labels are too noisy for a 2% line, S650 keeps the absolute one', async () => {
    // 5 of 30 blind wrong on both versions: all questions 5/430 = 1.2%, upper 2.7% > 2%; S650 0/400
    const { answerer } = fakeAnswerer((message) =>
      /^refund question blind [0-4]$/.test(message)
        ? answer('answer', id(3))
        : right(message),
    );
    const report = await gate({
      answerer,
      items: () => [...refunds(400), ...refunds(30, 'blind')],
      now: fixed,
    }).evaluate(input({ previous: live }));
    expect(report.passed).toBe(true);
    const suites = new Map(report.suites?.map((s) => [s.id, s]));
    expect(suites.get('combined')).toMatchObject({
      status: 'track',
      passed: false,
      metrics: { wrongCards: 5, wrongRateHigh: 0.0269 },
    });
    expect(suites.get('s650')).toMatchObject({ status: 'gate', passed: true });
    // the headline numbers are still the ones over all questions
    expect(report.metrics).toMatchObject({ cases: 430, wrongCards: 5 });
  });

  it('right answers must not fall against the live version: a card that stops being shown fails even with no wrong card (re-asked first)', async () => {
    // live answers everything; the candidate says "no card" for 5 of 400 (1.25 points down)
    const quiet = (stays: boolean, gained = 0) =>
      fakeAnswerer((message, asked) => {
        const n = Number(message.split(' ').at(-1));
        if (asked.version === 2 && n < 5 && (asked.cache === 'use' || stays))
          return answer('no_match');
        // questions the live version missed and the candidate now answers
        if (asked.version === 1 && n >= 400 - gained) return answer('no_match');
        return right(message);
      });
    const lost = quiet(true);
    const failed = await gate({
      answerer: lost.answerer,
      items: () => refunds(400),
      now: fixed,
    }).evaluate(input({ previous: live }));
    expect(failed.passed).toBe(false);
    expect(failed.metrics).toMatchObject({
      wrongCards: 0,
      newlyWrong: 0,
      lostRight: 5,
      liveRightRate: 1,
      pairedRightRate: 0.9875,
      rightDrop: 0.0125,
    });
    expect(failed.summary).toContain(
      'right answers fell from 100.0% to 98.8% against the live version (5 lost, 0 gained) > 1.0%',
    );
    expect(
      failed.suites?.find((s) => s.id === 's650')?.metrics.rightDropped,
    ).toBe(1);
    expect(failed.misses.slice(0, 5)).toEqual(
      Array.from(
        { length: 5 },
        () => expect.objectContaining({ why: 'lost_right' }) as unknown,
      ),
    );
    // each lost answer was asked again without the cache before it counted
    expect(lost.asked.filter((a) => a.cache === 'bypass')).toHaveLength(
      5 * MODEL_GATE.reaskTimes,
    );
    // right again when asked again: the model wobbled, nothing was lost
    const noise = await gate({
      answerer: quiet(false).answerer,
      items: () => refunds(400),
      now: fixed,
    }).evaluate(input({ previous: live }));
    expect(noise.passed).toBe(true);
    expect(noise.metrics).toMatchObject({ lostRight: 0, rightDrop: 0 });
    // 5 lost, 2 the live version missed now answered: 0.75 points net, within 1 point
    const net = await gate({
      answerer: quiet(true, 2).answerer,
      items: () => refunds(400),
      now: fixed,
    }).evaluate(input({ previous: live }));
    expect(net.passed).toBe(true);
    expect(net.metrics).toMatchObject({ lostRight: 5, gainedRight: 2 });
  });

  it('tracks one message with several asks as its own suite with the per-ask numbers, and never fails on them alone', async () => {
    const several: ReleaseEvalItem[] = Array.from({ length: 4 }, (_, i) => ({
      id: `multi-${i}`,
      locale: 'en-GB',
      message: `refund and password ${i}`,
      expect: 'answer',
      faq: 'refund',
      asks: [{ faq: 'refund' }, { faq: 'password' }],
    }));
    const { answerer } = fakeAnswerer((message) =>
      message === 'refund and password 0'
        ? answer('answer', id(1), 0.0001, { more: [id(3)] })
        : message.startsWith('refund and password')
          ? answer('answer', id(1), 0.0001, { missed: 1 })
          : right(message),
    );
    const report = await gate({
      answerer,
      items: () => [...refunds(400), ...several],
      now: fixed,
    }).evaluate(input({ previous: live }));
    expect(report.passed).toBe(true);
    expect(report.suites?.find((s) => s.id === 'multi')).toMatchObject({
      status: 'track',
      rule: 'paired',
      n: 4,
      passed: true,
      metrics: {
        wrongCards: 0,
        rightRate: 1,
        asks: 8,
        asksCovered: 5,
        askCoverage: 0.625,
        allCovered: 1,
        strayCards: 0,
        ordered: 1,
        inOrder: 1,
        noCardAsks: 0,
        missedSaid: 3,
      },
    });
    // the per-ask numbers are only on this suite
    expect(
      report.suites?.find((s) => s.id === 'combined')?.metrics,
    ).not.toHaveProperty('askCoverage');
  });

  it('fails when cards are shown for more than 3% of the questions the library has no card for', async () => {
    const none: ReleaseEvalItem[] = Array.from({ length: 30 }, (_, i) => ({
      id: `none-${i}`,
      locale: 'en-GB',
      message: `homework ${i}`,
      expect: 'no_match',
    }));
    const { answerer } = fakeAnswerer((message) =>
      message === 'homework 0' ? answer('answer', id(1)) : right(message),
    );
    const report = await gate({
      answerer,
      items: () => [...refunds(400), ...none],
      now: fixed,
    }).evaluate(input());
    expect(report.metrics).toMatchObject({
      cardWhenNone: 1,
      cardWhenNoneRate: 0.0333,
    });
    expect(report.passed).toBe(false);
    expect(report.summary).toContain(
      'S650 (written per card): a card was shown for 3.3% of questions the library has no card for > 3.0%',
    );
    expect(
      report.suites?.find((s) => s.id === 's650')?.metrics.cardWhenNoneOver,
    ).toBe(1);
  });

  it('draws the absolute lines on S650 only: its slices and its out-of-library questions; blind questions are in none of them', async () => {
    // 3% of 250 blind en-GB questions wrong on both versions, S650 clean
    const { answerer } = fakeAnswerer((message) =>
      /^refund question blind [0-9]$/.test(message)
        ? answer('answer', id(3))
        : right(message),
    );
    const report = await gate({
      answerer,
      items: () => [
        ...refunds(500),
        ...refunds(250, 'blind').map((item) => ({ ...item, locale: 'en-GB' })),
      ],
      now: fixed,
    }).evaluate(input({ previous: live }));
    const suites = new Map(report.suites?.map((s) => [s.id, s]));
    // the en-GB slice is the 250 S650 questions, not 500 with the blind ones (which would be 2% wrong)
    expect(suites.get('language:en-GB')).toMatchObject({
      status: 'gate',
      n: 250,
      passed: true,
      metrics: { wrongCards: 0 },
    });
    expect(suites.get('blind')?.metrics.wrongRate).toBe(0.04);
    expect(report.passed).toBe(true);
  });

  it('lists the blind questions the library has no card for as their own suite, apart from the easy S650 ones', async () => {
    const none = (set: 'blind' | 's650', n: number): ReleaseEvalItem[] =>
      Array.from({ length: n }, (_, i) => ({
        id: `none-${set}-${i}`,
        set,
        locale: 'en-GB',
        message: `homework ${set} ${i}`,
        expect: 'no_match',
      }));
    // 2 of 5 blind out-of-library questions get the nearest card; none of the 75 S650 ones: 2.5% together
    const { answerer } = fakeAnswerer((message) =>
      message === 'homework blind 0' || message === 'homework blind 1'
        ? answer('answer', id(1))
        : right(message),
    );
    const report = await gate({
      answerer,
      items: () => [...refunds(400), ...none('s650', 75), ...none('blind', 5)],
      now: fixed,
    }).evaluate(input());
    expect(report.metrics).toMatchObject({
      cardWhenNone: 2,
      cardWhenNoneRate: 0.025,
    });
    expect(report.suites?.find((s) => s.id === 'blindNone')).toMatchObject({
      status: 'track',
      n: 5,
      metrics: { cardWhenNone: 2, cardWhenNoneRate: 0.4 },
    });
    // the 3% line is on the S650 ones (0 of 75 here)
    expect(report.suites?.find((s) => s.id === 's650')).toMatchObject({
      passed: true,
      metrics: { noneExpected: 75, cardWhenNone: 0 },
    });
    expect(report.passed).toBe(true);
    expect(report.receipt).toMatchObject({ cardWhenNoneMax: 0.03 });
  });

  it('counts a timeout as a miss, caps how many may time out, and does not count a run where many questions got no answer at all', async () => {
    const timeouts = await gate({
      answerer: fakeAnswerer((message) =>
        message === 'refund question s650 1'
          ? answer('error', null, 0, { failure: 'timeout' })
          : right(message),
      ).answerer,
      items: () => refunds(250),
      now: fixed,
    }).evaluate(input());
    expect(timeouts.metrics).toMatchObject({ timeouts: 1, errors: 0 });
    expect(timeouts.metrics.rightRate).toBeCloseTo(249 / 250, 4);
    expect(timeouts.passed).toBe(true);
    // 6 of 250 (2.4%) timed out: those learners got nothing, and a wrong answer that times out
    // must not slip out of the wrong-card rate unnoticed
    const slow = await gate({
      answerer: fakeAnswerer((message) =>
        /^refund question s650 [0-5]$/.test(message)
          ? answer('error', null, 0, { failure: 'timeout' })
          : right(message),
      ).answerer,
      items: () => refunds(250),
      now: fixed,
    }).evaluate(input());
    expect(slow.passed).toBe(false);
    expect(slow.summary).toContain(
      '6 of 250 questions timed out (2.4% > 2.0%)',
    );
    const broken = await gate({
      answerer: fakeAnswerer(() =>
        answer('error', null, 0, { failure: 'rate_limited' }),
      ).answerer,
      items: () => items,
      now: fixed,
    }).evaluate(input());
    expect(broken.passed).toBe(false);
    // 5 single questions + the follow-up on refund-late (no live version: every parent is asked)
    expect(broken.metrics.errors).toBe(6);
    expect(broken.summary).toContain('got no answer');
  });

  it('a timeout on a question the live version answered is a lost right answer: asked again, then counted', async () => {
    const { answerer, asked } = fakeAnswerer((message, a) =>
      a.version === 2 && /^refund question s650 [0-2]$/.test(message)
        ? answer('error', null, 0, { failure: 'timeout' })
        : right(message),
    );
    // 3 of 250 time out on the candidate only: under the 2% cap, but 1.2 points of right answers gone
    const report = await gate({
      answerer,
      items: () => refunds(250),
      now: fixed,
    }).evaluate(input({ previous: live }));
    expect(asked.filter((a) => a.cache === 'bypass')).toHaveLength(
      3 * MODEL_GATE.reaskTimes,
    );
    expect(report.metrics).toMatchObject({ timeouts: 3, lostRight: 3 });
    expect(report.passed).toBe(false);
    expect(report.summary).toContain('right answers fell');
    expect(report.misses[0]).toMatchObject({
      why: 'lost_right',
      got: 'error:timeout',
      live: 'answer:refund',
    });
  });

  it('does not count a check whose questions were answered without the vector search or the reranker', async () => {
    // the release vectors were never built (indexing failed quietly): every ask falls back to word search
    const { answerer } = fakeAnswerer((message) => ({
      ...right(message),
      degraded: ['vector'],
    }));
    const report = await gate({
      answerer,
      items: () => refunds(250),
      now: fixed,
    }).evaluate(input());
    expect(report.passed).toBe(false);
    expect(report.metrics.degraded).toBe(250);
    expect(report.summary).toContain(
      '250 of 250 questions were answered without the vector search or the reranker (it failed), so the check does not count',
    );
    // a reranker hiccup on a few questions is not the whole check
    const few = await gate({
      answerer: fakeAnswerer((message) =>
        message.endsWith(' 7')
          ? { ...right(message), degraded: ['rerank'] }
          : right(message),
      ).answerer,
      items: () => refunds(250),
      now: fixed,
    }).evaluate(input());
    expect(few.passed).toBe(true);
    expect(few.metrics.degraded).toBe(1);
  });

  it('asks some cached answers again without the cache, and does not count the check when more than 2 changed', async () => {
    const hit = {
      ...emptyAskStats(),
      step: { hits: 1, misses: 0, savedUsd: 0.0001 },
    };
    const { answerer, asked } = fakeAnswerer((message, a) =>
      a.cache === 'refresh' && message.endsWith('1')
        ? answer('no_match')
        : { ...right(message), cache: hit },
    );
    const report = await gate({
      answerer,
      items: () => refunds(250),
      now: fixed,
    }).evaluate(input());
    expect(asked.filter((a) => a.cache === 'refresh')).toHaveLength(
      MODEL_GATE.driftSample,
    );
    expect(report.metrics.driftChecked).toBe(MODEL_GATE.driftSample);
    expect(report.metrics.driftChanged).toBeGreaterThan(MODEL_GATE.driftMax);
    expect(report.metrics.savedUsd).toBeGreaterThan(0);
    expect(report.passed).toBe(false);
    expect(report.summary).toContain('the cache may be stale');
  });

  it('says plainly that it could not run without an API key, and asks nothing', async () => {
    const { answerer, asked } = fakeAnswerer(right, false);
    const report = await gate({
      answerer,
      items: () => items,
      now: fixed,
    }).evaluate(input());
    expect(report).toMatchObject({ passed: false });
    expect(report.summary).toContain('no model API key');
    expect(asked).toEqual([]);
  });

  it('stops at the budget, and stops when a newer check replaced this one', async () => {
    const { answerer, asked } = fakeAnswerer(() => answer('answer', id(1), 2));
    const budget = await gate({
      answerer,
      items: () => items,
      now: fixed,
      limits: { concurrency: 1 },
    }).evaluate(input());
    expect(budget.passed).toBe(false);
    expect(budget.summary).toContain(`budget ($${MODEL_GATE.budgetUsd})`);
    expect(asked).toHaveLength(2);
    const replaced = await gate({
      answerer: fakeAnswerer(right).answerer,
      items: () => items,
      now: fixed,
      limits: { progressEvery: 1, concurrency: 1 },
    }).evaluate(input({ progress: (p) => Promise.resolve(p.done < 2) }));
    expect(replaced.passed).toBe(false);
    expect(replaced.summary).toBe('The check was replaced by a newer one');
    expect(replaced.metrics.cases).toBe(2);
  });
});

describe('the live-pipeline check: follow-ups (B5, parent card on screen)', () => {
  // refund → refund-late; password → refund-late as well (two parents); password → reset (one parent)
  const two: FaqReleaseSnapshot = {
    nodes: [
      node(1, 'refund'),
      node(2, 'refund-late', false),
      node(3, 'password'),
      node(4, 'reset', false),
    ],
    edges: [
      ...snapshot.edges,
      {
        parentId: id(3),
        childId: id(2),
        kind: 'follow_up',
        position: 1,
        labelEn: null,
        labelZh: null,
      },
      {
        parentId: id(3),
        childId: id(4),
        kind: 'follow_up',
        position: 0,
        labelEn: null,
        labelZh: null,
      },
    ],
    phrasings: [],
  };
  const lateItems: ReleaseEvalItem[] = [
    {
      id: 'l1',
      locale: 'en-GB',
      message: 'late one',
      expect: 'answer',
      faq: 'refund-late',
    },
    {
      id: 'l2',
      locale: 'zh-TW',
      message: '晚了',
      expect: 'answer',
      faq: 'refund-late',
    },
    {
      id: 'r1',
      locale: 'zh-CN',
      message: '重设',
      expect: 'answer',
      faq: 'reset',
    },
    {
      id: 'e1',
      locale: 'zh-CN',
      message: '退款',
      expect: 'answer',
      faq: 'refund',
    },
    { id: 'n1', locale: 'en-GB', message: 'homework', expect: 'no_match' },
  ];

  it('asks the dev questions of a child card with its parent on screen, the parent question as the earlier turn, and gives each edge its turn', () => {
    const followups = planFollowups({
      items: lateItems,
      snapshot: two,
      parents: null,
      changed: new Set(),
    });
    expect(followups.map((q) => [q.id, q.faqId, q.screen?.key])).toEqual([
      ['followup:l1', id(2), 'refund'],
      ['followup:l2', id(2), 'password'],
      ['followup:r1', id(4), 'password'],
    ]);
    expect(followups[0]).toMatchObject({
      set: 'followup',
      locale: 'en-GB',
      entryIds: [],
      screen: { nodeId: id(1), recentTurns: ['Q refund'] },
    });
    // zh-TW is sent as zh-CN, and the earlier turn is the parent's Chinese question
    expect(followups[1]).toMatchObject({
      locale: 'zh-CN',
      language: 'zh-TW',
      screen: { recentTurns: ['问 password'] },
    });
    // only the parents this release touched
    expect(
      planFollowups({
        items: lateItems,
        snapshot: two,
        parents: new Set([id(3)]),
        changed: new Set(),
      }).map((q) => q.id),
    ).toEqual(['followup:l2', 'followup:r1']);
  });

  it('a parent is asked again when it, a child, a child phrasing or one of its edges changed; nothing changed = nothing asked; no live version = all', () => {
    expect(followupParents(null, two)).toBeNull();
    expect(followupParents(two, two)).toEqual(new Set());
    const childEdited: FaqReleaseSnapshot = {
      ...two,
      nodes: two.nodes.map((n) =>
        n.id === id(4) ? { ...n, answerEn: 'new words' } : n,
      ),
    };
    expect(followupParents(two, childEdited)).toEqual(new Set([id(3)]));
    // refund-late has two parents: both see the change
    const phrasing: FaqReleaseSnapshot = {
      ...two,
      phrasings: [{ faqId: id(2), locale: 'en-GB', text: 'is it too late' }],
    };
    expect(followupParents(two, phrasing)).toEqual(new Set([id(1), id(3)]));
    const edgeMoved: FaqReleaseSnapshot = {
      ...two,
      edges: two.edges.map((e) =>
        e.childId === id(4) ? { ...e, position: 5 } : e,
      ),
    };
    expect(followupParents(two, edgeMoved)).toEqual(new Set([id(3)]));
    const edgeRemoved: FaqReleaseSnapshot = {
      ...two,
      edges: two.edges.filter((e) => e.childId !== id(4)),
    };
    expect(followupParents(two, edgeRemoved)).toEqual(new Set([id(3)]));
  });

  it('asks follow-ups with the card on screen, keeps them out of the single-question gate and slices, and tracks their rate', async () => {
    const singles = refunds(250);
    const { answerer, asked } = fakeAnswerer((message, a) =>
      a.screen !== null
        ? // the same answers on both versions: two of three follow-ups get a wrong card, tracked, not a fail
          answer('answer', message === 'late one' ? id(3) : id(4))
        : right(message),
    );
    const edited: FaqReleaseSnapshot = {
      ...two,
      nodes: two.nodes.map((n) =>
        n.id === id(2) ? { ...n, answerEn: 'new words' } : n,
      ),
    };
    const report = await gate({
      answerer,
      items: () => [...singles, ...lateItems],
      now: fixed,
    }).evaluate(
      input({
        snapshot: edited,
        previous: { version: 1, evalReport: null, snapshot: two },
      }),
    );
    // refund-late changed: both of its parents are asked again, with every child question under them
    //（a sibling changes the candidates the model picks from）
    const onScreen = asked.filter((a) => a.screen !== null);
    expect(
      onScreen
        .filter((a) => a.version === 2)
        .map((a) => [a.message, a.screen])
        .sort(),
    ).toEqual([
      ['late one', id(1)],
      ['晚了', id(3)],
      ['重设', id(3)],
    ]);
    expect(onScreen.filter((a) => a.version === 1)).toHaveLength(3);
    expect(report.metrics).toMatchObject({
      followupCases: 3,
      followupWrong: 2,
      followupWrongRate: 0.6667,
      // the single-question numbers do not include follow-ups
      cases: 255,
      wrongCards: 0,
      confirmedWorse: 0,
    });
    const suites = new Map(report.suites?.map((s) => [s.id, s]));
    expect(suites.get('followup')).toMatchObject({
      status: 'track',
      n: 3,
      passed: true,
    });
    expect(suites.get('combined')?.n).toBe(255);
    expect(suites.get('language:en-GB')?.n).toBe(
      singles.filter((i) => i.locale === 'en-GB').length + 2,
    );
    expect(report.passed).toBe(true);
  });

  it('a follow-up newly wrong against the live version fails the check, and the miss names the card on screen', async () => {
    const { answerer } = fakeAnswerer((message, a) =>
      a.screen !== null && a.version === 2
        ? answer('answer', id(3))
        : a.screen !== null
          ? answer('answer', id(2))
          : right(message),
    );
    const edited: FaqReleaseSnapshot = {
      ...two,
      nodes: two.nodes.map((n) =>
        n.id === id(4) ? { ...n, answerEn: 'new words' } : n,
      ),
    };
    const report = await gate({
      answerer,
      // l1 is asked under refund (not touched); l2 and r1 under password, whose child reset changed
      items: () => [...refunds(250), ...lateItems],
      now: fixed,
    }).evaluate(
      input({
        snapshot: edited,
        previous: { version: 1, evalReport: null, snapshot: two },
      }),
    );
    expect(report.passed).toBe(false);
    expect(report.summary).toContain('newly wrong against the live version');
    expect(report.misses[0]).toMatchObject({
      set: 'followup',
      why: 'newly_wrong',
      onScreen: 'password',
      live: 'answer:refund-late',
    });
  });
});

describe('the live-pipeline check: duplicate texts (a note, never a fail)', () => {
  it('notes a text this release added to one card that another card already has, and still passes', async () => {
    const withDup: FaqReleaseSnapshot = {
      ...snapshot,
      phrasings: [{ faqId: id(3), locale: 'zh-CN', text: '问 refund' }],
    };
    const same = Float32Array.from([1, 0]);
    const report = await gate({
      answerer: fakeAnswerer(right).answerer,
      items: () => refunds(250),
      now: fixed,
      vectors: (version) =>
        Promise.resolve(
          version === 2
            ? [
                { nodeId: id(1), hash: textHash('问 refund'), vector: same },
                { nodeId: id(3), hash: textHash('问 refund'), vector: same },
                {
                  nodeId: id(3),
                  hash: textHash('Q password'),
                  vector: Float32Array.from([0, 1]),
                },
              ]
            : null,
        ),
    }).evaluate(input({ snapshot: withDup, previous: live }));
    expect(report.passed).toBe(true);
    expect(report.metrics).toMatchObject({
      collisionsNew: 1,
      collisionCardPairs: 1,
      collisionTextsChecked: 1,
    });
    expect(report.collisions).toEqual([
      {
        similarity: 1,
        added: { key: 'password', text: '问 refund', source: 'phrasing' },
        other: { key: 'refund', text: '问 refund', source: 'question_zh' },
        byState: false,
      },
    ]);
    expect(report.summary).toContain('1 new near-duplicate text(s)');
  });
});

describe('the live-pipeline check: the estimate before it starts', () => {
  it('keeps for each card how many questions had it among the candidates, and what a paid question cost', async () => {
    const { answerer } = fakeAnswerer((message) => ({
      ...right(message),
      candidates: [id(1), id(3)],
      costUsd: 0.0004,
    }));
    const report = await gate({
      answerer,
      items: () => refunds(250),
      now: fixed,
    }).evaluate(input());
    expect(report.candidatePool).toEqual({ [id(1)]: 250, [id(3)]: 250 });
    expect(report.metrics).toMatchObject({
      paidQuestions: 250,
      paidQuestionUsd: 0.0004,
    });
  });

  it('estimates the questions whose candidates had a touched card, plus follow-ups and the drift re-asks, from the live check', async () => {
    const check = gate({
      answerer: fakeAnswerer(right).answerer,
      items: () => [...refunds(250), ...items],
      now: fixed,
    });
    const liveReport = {
      kind: 'combined',
      parts: [
        { kind: 'retrieval', metrics: {} },
        {
          kind: 'model',
          metrics: { paidQuestionUsd: 0.0005 },
          candidatePool: { [id(3)]: 37, [id(1)]: 255 },
        },
      ],
    };
    const edited: FaqReleaseSnapshot = {
      ...snapshot,
      nodes: snapshot.nodes.map((n) =>
        n.id === id(3) ? { ...n, answerZh: '新的答案' } : n,
      ),
    };
    const estimate = await check.estimate?.({
      snapshot: edited,
      previous: { version: 1, evalReport: liveReport, snapshot },
    });
    // 37 in the pool of password + 1 question labelled password (a3) + 40 drift re-asks; no follow-up parent touched
    expect(estimate).toEqual({
      questions: 255,
      single: 255,
      followups: 0,
      touchedCards: 1,
      paid: 78,
      usd: 0.039,
      budgetUsd: MODEL_GATE.budgetUsd,
      basis: 'last_check',
    });
    // nothing changed: only the drift re-asks are paid
    expect(
      (
        await check.estimate?.({
          snapshot,
          previous: { version: 1, evalReport: liveReport, snapshot },
        })
      )?.paid,
    ).toBe(MODEL_GATE.driftSample);
    // no check of v2 on the live version: only the count and the cap
    expect(
      await check.estimate?.({
        snapshot: edited,
        previous: { version: 1, evalReport: null, snapshot },
      }),
    ).toMatchObject({ paid: 255, usd: null, basis: 'no_history' });
  });

  it('gives no estimate without an API key (the check would not run)', async () => {
    const check = gate({
      answerer: fakeAnswerer(right, false).answerer,
      items: () => items,
    });
    expect(await check.estimate?.(input())).toBeNull();
  });
});
