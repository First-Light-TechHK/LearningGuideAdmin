import type { InsightTurn } from '../modules/helpdesk/contracts';
import {
  MINING_LIMITS,
  codeLabel,
  mineable,
  miningTurn,
  phrasingLocale,
  planMining,
  unsolvedReasons,
  type MiningTurn,
} from '../modules/helpdesk/flywheel/flywheelMining';
import { createNgramSimilarity } from '../modules/helpdesk/flywheel/textSimilarity';

/**
 * 缺口挖掘的纯逻辑（v5 Part G3）：选 AI 没解决的轮、按意思分组、并进已有的候选、和已发布的节点去重
 * （加问法 / 新 FAQ / 挂到学员卡住的那个节点下当追问）、挑 5 个脱敏例句、原因构成与草稿来源。
 */
let seq = 0;
function turn(overrides: Partial<InsightTurn> = {}): InsightTurn {
  seq += 1;
  return {
    id: `01a18100-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    createdAt: new Date(Date.UTC(2026, 9, 30, 8, 0, seq)).toISOString(),
    source: 'chat',
    locale: 'zh-CN',
    text: '付款成功了但是课程没有开通',
    sessionId: null,
    turnIndex: 1,
    lastTurn: false,
    sessionEndReason: null,
    kind: 'no_match',
    intent: 'question',
    guard: 'passed',
    via: 'typed',
    faqId: null,
    nodeId: null,
    parentNodeId: null,
    releaseVersion: 3,
    answered: false,
    vote: null,
    rating: null,
    covered: null,
    expanded: null,
    handover: false,
    ticketAfterChat: false,
    ticket: null,
    signals: [],
    ...overrides,
  };
}

const NODE_ACTIVATE = '01a18100-0000-7000-8000-0000000000a1';
const NODE_PAYMENTS = '01a18100-0000-7000-8000-0000000000a2';
const NODE_AVATAR = '01a18100-0000-7000-8000-0000000000a3';
const CANDIDATE = '01a18100-0000-7000-8000-0000000000c1';

const nodes = [
  { nodeId: NODE_AVATAR, text: 'How do I change my profile photo?' },
  { nodeId: NODE_AVATAR, text: '怎么修改头像？' },
  { nodeId: NODE_ACTIVATE, text: 'I paid but my plan is not active' },
  { nodeId: NODE_ACTIVATE, text: '付款后会员没有生效怎么办？' },
  { nodeId: NODE_PAYMENTS, text: '付款有问题？' },
];

describe('which turns the AI did not solve (G3 step 1)', () => {
  it('names every reason: no_match, not_helpful, clarify not covered, handover, ticket after chat, rating <= 2', () => {
    expect(unsolvedReasons(turn())).toEqual(['no_match']);
    expect(
      unsolvedReasons(
        turn({
          kind: 'answer',
          vote: 'not_helpful',
          rating: 2,
          answered: true,
        }),
      ),
    ).toEqual(['not_helpful', 'low_rating']);
    expect(unsolvedReasons(turn({ kind: 'clarify', covered: false }))).toEqual([
      'clarify_not_covered',
    ]);
    expect(unsolvedReasons(turn({ kind: 'clarify', covered: true }))).toEqual(
      [],
    );
    expect(
      unsolvedReasons(turn({ kind: 'answer', handover: true, rating: 3 })),
    ).toEqual(['handover']);
    expect(
      unsolvedReasons(turn({ kind: 'answer', ticketAfterChat: true })),
    ).toEqual(['ticket_after_chat']);
    expect(
      unsolvedReasons(turn({ kind: 'answer', vote: 'helpful', rating: 5 })),
    ).toEqual([]);
  });

  it('mines questions only: no small talk, no handover requests, no greetings or prompt injection, no placeholder-only text', () => {
    expect(mineable(miningTurn(turn()))).toBe(true);
    expect(
      mineable(miningTurn(turn({ kind: 'smalltalk', handover: true }))),
    ).toBe(false);
    expect(
      mineable(miningTurn(turn({ kind: 'handover', handover: true }))),
    ).toBe(false);
    for (const intent of [
      'greeting',
      'farewell',
      'instructions',
      'private_data',
    ])
      expect(mineable(miningTurn(turn({ intent })))).toBe(false);
    expect(mineable(miningTurn(turn({ text: '<phone> <email>' })))).toBe(false);
    expect(mineable(miningTurn(turn({ text: '?' })))).toBe(false);
    expect(
      mineable(miningTurn(turn({ kind: 'answer', vote: 'helpful' }))),
    ).toBe(false);
  });
});

describe('planning a night (G3 steps 2-5)', () => {
  const similarity = createNgramSimilarity();
  const other = [
    '为什么扣了两次钱',
    '证书在哪里下载',
    'how do I join a study group',
    'the video keeps buffering',
  ].map((text) =>
    miningTurn(turn({ text, locale: /[a-z]/.test(text) ? 'en-GB' : 'zh-CN' })),
  );

  it('groups paraphrases, leaves singletons for another night, and keeps 5 distinct scrubbed examples', async () => {
    const paid: MiningTurn[] = [
      '付款成功了但是课程没有开通',
      '已经付款了课程还是没开通',
      '付款成功课程没开通',
      '付款成功课程没开通',
      '我付款成功了，课程没有开通 <phone>',
      '付款成功了课程一直没开通',
      '付款成功但课程没开通怎么回事',
    ].map((text) => miningTurn(turn({ text })));
    const plan = await planMining({
      turns: [...paid, ...other],
      nodes,
      candidates: [],
      similarity,
    });
    expect(plan.create).toHaveLength(1);
    const [group] = plan.create;
    expect(group.members.map((m) => m.id).sort()).toEqual(
      paid.map((m) => m.id).sort(),
    );
    expect(group.examples.length).toBeLessThanOrEqual(
      MINING_LIMITS.examplesMax,
    );
    const texts = group.examples.map((e) => e.text);
    expect(new Set(texts).size).toBe(texts.length);
    // 占位符的例句排在后面
    expect(texts[0]).not.toContain('<');
    expect(plan.singles).toBe(other.length);
    expect(group.sourceMix).toEqual({ no_match: paid.length });
    expect(group.locale).toBe('zh-CN');
  });

  it('suggests adding phrasings to a published node it is close to', async () => {
    const paid = [
      '付款后会员没有生效',
      '付款后会员一直没生效',
      '付了款会员没有生效',
    ].map((text) => miningTurn(turn({ text })));
    const plan = await planMining({
      turns: [...paid, ...other],
      nodes,
      candidates: [],
      similarity,
    });
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0].suggestion).toBe('add_phrasing');
    expect(plan.create[0].relatedNodeId).toBe(NODE_ACTIVATE);
    expect(plan.create[0].relatedScore).toBeGreaterThanOrEqual(
      MINING_LIMITS.nodeThreshold,
    );
  });

  it('suggests updating the node when learners were shown that very card and it still did not help', async () => {
    const shown = [
      '付款后会员没有生效',
      '付款后会员一直没生效',
      '付了款会员没有生效',
    ].map((text) =>
      miningTurn(
        turn({
          text,
          kind: 'answer',
          vote: 'not_helpful',
          nodeId: NODE_ACTIVATE,
        }),
      ),
    );
    const plan = await planMining({
      turns: [...shown, ...other],
      nodes,
      candidates: [],
      similarity,
    });
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0]).toMatchObject({
      suggestion: 'update_faq',
      relatedNodeId: NODE_ACTIVATE,
      shownNodeId: NODE_ACTIVATE,
      sourceMix: { not_helpful: 3 },
    });
  });

  it('suggests a new follow-up under the node where learners got stuck, and records the card they were shown', async () => {
    const stuck = [
      '那要等多久才能开通',
      '要等多久才能开通',
      '开通要等多久',
    ].map((text) =>
      miningTurn(
        turn({
          text,
          kind: 'clarify',
          covered: false,
          nodeId: NODE_ACTIVATE,
          parentNodeId: NODE_ACTIVATE,
        }),
      ),
    );
    const plan = await planMining({
      turns: [...stuck, ...other],
      nodes,
      candidates: [],
      similarity,
    });
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0]).toMatchObject({
      suggestion: 'follow_up',
      parentNodeId: NODE_ACTIVATE,
      shownNodeId: NODE_ACTIVATE,
      sourceMix: { clarify_not_covered: 3 },
    });
  });

  it('a brand-new topic is a new FAQ', async () => {
    const plan = await planMining({
      turns: [
        ...['可以开发票吗', '怎么开发票', '发票在哪里开'].map((text) =>
          miningTurn(turn({ text })),
        ),
        ...other,
      ],
      nodes,
      candidates: [],
      similarity,
    });
    expect(plan.create.map((g) => g.suggestion)).toEqual(['new_faq']);
    expect(plan.create[0].relatedNodeId).toBeNull();
  });

  it('a turn close to an open candidate grows that candidate instead of making a new one', async () => {
    const more = ['课程付款成功了没开通', '付款成功了课程没有开通'].map(
      (text) => miningTurn(turn({ text, kind: 'answer', vote: 'not_helpful' })),
    );
    const plan = await planMining({
      turns: [...more, ...other],
      nodes,
      candidates: [
        {
          id: CANDIDATE,
          examples: ['付款成功了但是课程没有开通', '已经付款了课程还是没开通'],
        },
      ],
      similarity,
    });
    expect(plan.create).toEqual([]);
    expect(plan.grow).toHaveLength(1);
    expect(plan.grow[0].candidateId).toBe(CANDIDATE);
    expect(plan.grow[0].members.map((m) => m.id)).toEqual(
      more.map((m) => m.id),
    );
    expect(plan.grow[0].sourceMix).toEqual({ not_helpful: 2 });
  });

  it('keeps at most 3 human replies from enquiries the agent resolved, as draft sources', async () => {
    const replies = [
      'Hi <name>, I re-synced your payment.',
      'Hi <name>, I re-synced your payment.',
      'Please sign out and in again.',
      'We refreshed your plan.',
      'Done, try now.',
    ];
    const turns = replies.map((agentReply, index) =>
      miningTurn(
        turn({
          text: [
            '付款成功了但是课程没有开通',
            '付款成功课程没开通',
            '付款成功了课程一直没开通',
            '付款成功但课程没开通怎么回事',
            '付款成功了课程没开通',
          ][index],
          ticketAfterChat: true,
          ticket: {
            linked: true,
            status: 'CLOSED',
            closeReason: 'user_confirmed',
            resolvedByAgent: index !== 4,
            agentReplied: true,
            agentReply: index === 4 ? null : agentReply,
          },
        }),
      ),
    );
    const plan = await planMining({ turns, nodes, candidates: [], similarity });
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0].answerSources).toEqual([
      'Hi <name>, I re-synced your payment.',
      'Please sign out and in again.',
      'We refreshed your plan.',
    ]);
    expect(plan.create[0].sourceMix).toMatchObject({
      no_match: 5,
      ticket_after_chat: 5,
    });
  });

  it('is deterministic: the same turns give the same plan', async () => {
    const turns = [
      '可以开发票吗',
      '怎么开发票',
      '发票在哪里开',
      ...other.map((m) => m.text),
    ].map((text) => miningTurn(turn({ text })));
    const a = await planMining({ turns, nodes, candidates: [], similarity });
    const b = await planMining({
      turns: [...turns].reverse(),
      nodes,
      candidates: [],
      similarity,
    });
    expect(b.create.map((g) => g.members.map((m) => m.id).sort())).toEqual(
      a.create.map((g) => g.members.map((m) => m.id).sort()),
    );
  });
});

describe('labels written by code (model off, over budget or refused by the guard)', () => {
  it('uses the most central example as the question and a short topic', () => {
    const label = codeLabel([
      {
        turnId: 'a',
        text: '付款成功了但是课程没有开通，已经等了很久很久很久很久很久很久了',
        locale: 'zh-CN',
        reasons: ['no_match'],
      },
    ]);
    expect(label.question).toBe(
      '付款成功了但是课程没有开通，已经等了很久很久很久很久很久很久了',
    );
    expect([...label.topic].length).toBeLessThanOrEqual(24);
  });

  it('phrasing locale follows the script the learner wrote', () => {
    expect(phrasingLocale('忘記密碼怎麼辦', 'zh-CN')).toBe('zh-TW');
    expect(phrasingLocale('忘记密码怎么办', 'en-GB')).toBe('zh-CN');
    expect(phrasingLocale('forgot password', 'zh-CN')).toBe('en-GB');
  });
});
