import type { HelpdeskFaq } from '../modules/helpdesk/faqs/faqContracts';
import type { FaqMapNode, FaqPlacement } from '../modules/helpdesk/faqs/faqMap';
import type { FaqCandidate } from '../modules/helpdesk/flywheel/candidateRepository';
import {
  REVIEW_LIMITS,
  buildCandidateReview,
  pathOf,
  rationaleOf,
  regionOf,
  textScores,
  type ReviewInput,
} from '../modules/helpdesk/flywheel/candidateReview';
import { createNgramSimilarity } from '../modules/helpdesk/flywheel/textSimilarity';

const id = (n: number) =>
  `01a18100-0000-7000-8000-${String(n).padStart(12, '0')}`;

function node(
  n: number,
  key: string,
  kind: FaqMapNode['kind'],
  parentId: string | null,
): FaqMapNode {
  return {
    id: id(n),
    key,
    kind,
    parentId,
    stageId: null,
    attribute: kind === 'cell' ? 'price' : null,
    position: 0,
    labelEn: `${key} (en)`,
    labelZh: `${key}（中）`,
    version: 1,
    createdBy: null,
    updatedBy: null,
    createdAt: '2026-10-31T00:00:00.000Z',
    updatedAt: '2026-10-31T00:00:00.000Z',
  };
}

// 阶段 purchase → 步骤 activate → 岔子 delayed；对象 rules.plan → 格子 rules.plan.price
const STAGE = node(1, 'purchase', 'stage', null);
const STEP = node(2, 'purchase.activate', 'step', STAGE.id);
const DEV = node(3, 'purchase.activate.delayed', 'deviation', STEP.id);
const OBJECT = node(4, 'rules.plan', 'object', null);
const CELL = node(5, 'rules.plan.price', 'cell', OBJECT.id);
const NODES = [STAGE, STEP, DEV, OBJECT, CELL];

function faq(n: number, fields: Partial<HelpdeskFaq> = {}): HelpdeskFaq {
  return {
    id: id(100 + n),
    key: `card-${n}`,
    type: 'answer',
    entry: true,
    category: 'payments_subscriptions',
    popular: false,
    questionEn: `Question ${n}?`,
    answerEn: `Answer ${n}.`,
    questionZh: `问题${n}？`,
    answerZh: `答案${n}。`,
    keywords: [],
    signals: [],
    status: 'published',
    version: 1,
    createdBy: null,
    updatedBy: null,
    createdAt: '2026-10-31T00:00:00.000Z',
    updatedAt: '2026-10-31T00:00:00.000Z',
    ...fields,
  };
}

const placed = (
  card: HelpdeskFaq,
  at: FaqMapNode,
  primary = true,
): FaqPlacement => ({
  id: `${card.id}-${at.id}`,
  faqId: card.id,
  nodeId: at.id,
  primary,
  createdBy: null,
  createdAt: '2026-10-31T00:00:00.000Z',
});

function candidate(fields: Partial<FaqCandidate> = {}): FaqCandidate {
  return {
    id: id(900),
    status: 'new',
    suggestion: 'new_faq',
    origin: 'mining',
    topic: '付款后课程未开通',
    proposedQuestion: '付款成功了课程为什么还没开通？',
    labelSource: 'code',
    category: 'payments_subscriptions',
    locale: 'zh-CN',
    turnCount: 6,
    examples: [
      {
        turnId: id(800),
        text: '付款后会员没有生效',
        locale: 'zh-CN',
        reasons: ['not_helpful'],
      },
      { turnId: null, text: '付了款还是看不了', locale: 'zh-CN', reasons: [] },
    ],
    sourceMix: { not_helpful: 4, ticket_after_chat: 2 },
    answerSources: [],
    relatedNodeId: null,
    relatedScore: null,
    parentNodeId: null,
    shownNodeId: null,
    ticketId: null,
    firstSeenAt: '2026-10-30T00:00:00.000Z',
    lastSeenAt: '2026-10-31T00:00:00.000Z',
    reason: null,
    reasonNote: null,
    acceptedAs: null,
    acceptedFaqId: null,
    acceptedPlaceId: null,
    mergedInto: null,
    decidedBy: null,
    decidedAt: null,
    actionKey: null,
    version: 2,
    createdBy: null,
    createdAt: '2026-10-31T00:00:00.000Z',
    updatedAt: '2026-10-31T00:00:00.000Z',
    ...fields,
  };
}

const A = faq(1);
const B = faq(2);
const C = faq(3);
const D = faq(4, { type: 'choice' });

function input(fields: Partial<ReviewInput> = {}): ReviewInput {
  return {
    candidate: candidate(),
    working: {
      faqs: [A, B, C, D],
      phrasings: [],
      map: {
        nodes: NODES,
        placements: [
          placed(A, STEP),
          placed(B, DEV),
          placed(C, CELL),
          placed(A, CELL, false),
        ],
      },
    },
    shownByTurn: new Map([[id(800), A.id]]),
    scores: new Map([
      [A.id, 0.93],
      [B.id, 0.9],
      [C.id, 0.5],
      [D.id, 0.99],
    ]),
    source: 'vectors',
    ...fields,
  };
}

describe('candidate review: paths and regions', () => {
  const byId = new Map(NODES.map((n) => [n.id, n]));

  it('walks from the root to the node', () => {
    expect(pathOf(DEV.id, byId).map((p) => p.key)).toEqual([
      'purchase',
      'purchase.activate',
      'purchase.activate.delayed',
    ]);
    expect(pathOf(CELL.id, byId).map((p) => p.key)).toEqual([
      'rules.plan',
      'rules.plan.price',
    ]);
  });

  it('a step or deviation belongs to its stage, a cell to its object', () => {
    expect(regionOf(DEV.id, byId)?.key).toBe('purchase');
    expect(regionOf(CELL.id, byId)?.key).toBe('rules.plan');
  });
});

describe('buildCandidateReview', () => {
  it('lists answer cards only, at most ten, scores rounded', () => {
    const many = Array.from({ length: 14 }, (_, i) => faq(10 + i));
    const review = buildCandidateReview(
      input({
        working: {
          faqs: many,
          phrasings: [],
          map: { nodes: NODES, placements: [] },
        },
        scores: new Map(many.map((f, i) => [f.id, 0.5 + i / 100 + 0.00012])),
      }),
    );
    expect(review.similar).toHaveLength(REVIEW_LIMITS.similarMax);
    expect(review.similar[0].score).toBe(0.63);
    expect(
      buildCandidateReview(input()).similar.map((s) => s.faqId),
    ).not.toContain(D.id);
  });

  it('votes places by the best three cards per node and regions per stage or object', () => {
    const review = buildCandidateReview(input());
    expect(review.places.map((p) => [p.nodeId, p.kind, p.score])).toEqual([
      [STEP.id, 'step', 0.93],
      [DEV.id, 'deviation', 0.9],
      [CELL.id, 'cell', 0.5],
    ]);
    expect(review.places[1].path.map((p) => p.key)).toEqual([
      'purchase',
      'purchase.activate',
      'purchase.activate.delayed',
    ]);
    expect(review.regions.map((r) => [r.key, r.kind, r.score])).toEqual([
      ['purchase', 'stage', 1.83],
      ['rules.plan', 'object', 0.5],
    ]);
  });

  it('puts cards in the same place first and marks a close match only with vectors', () => {
    const update = candidate({
      suggestion: 'update_faq',
      relatedNodeId: B.id,
      relatedScore: 0.9,
    });
    const vectors = buildCandidateReview(input({ candidate: update }));
    expect(
      vectors.similar.map((s) => [s.faqId, s.samePlace, s.closeMatch]),
    ).toEqual([
      [B.id, true, true],
      [A.id, false, false],
      [C.id, false, false],
    ]);
    const text = buildCandidateReview(
      input({ candidate: update, source: 'text' }),
    );
    expect(text.similar.every((s) => !s.closeMatch)).toBe(true);
    // 新卡：参照是建议的第一个位置
    const fresh = buildCandidateReview(input());
    expect(fresh.similar[0]).toMatchObject({
      faqId: A.id,
      samePlace: true,
      closeMatch: true,
    });
  });

  it('shows what each example was shown and why it was unsolved; a ticket example has no turn', () => {
    const review = buildCandidateReview(input());
    expect(review.handling).toEqual([
      {
        exampleIndex: 0,
        shownFaqId: A.id,
        outcome: 'not_helpful',
        reply: null,
      },
      { exampleIndex: 1, shownFaqId: null, outcome: null, reply: null },
    ]);
    const ticket = buildCandidateReview(
      input({ candidate: candidate({ origin: 'ticket' }) }),
    );
    expect(ticket.handling[1].outcome).toBe('ticket');
  });

  it('recommends the mined action with a one-line reason in the candidate language, never a model score', () => {
    const zh = buildCandidateReview(input());
    expect(zh.recommendation).toMatchObject({
      action: 'new_faq',
      faqId: null,
      confidence: null,
    });
    expect(zh.recommendation.rationale).toBe(zh.recommendation.rationaleZh);
    expect(zh.recommendation.rationaleZh).toBe(
      '6 次提问没有合适的卡（说没帮上 4 次、看完开工单 2 次）。最像的已有卡相似度只有 0.93。',
    );
    const en = buildCandidateReview(
      input({
        candidate: candidate({
          locale: 'en-GB',
          suggestion: 'follow_up',
          parentNodeId: A.id,
        }),
      }),
    );
    expect(en.recommendation.faqId).toBe(A.id);
    expect(en.recommendation.rationale).toBe(
      '6 questions were asked while reading "Question 1?", about something it does not cover (marked not helpful 4, opened a ticket afterwards 2).',
    );
    expect(zh.userStates).toBeNull();
    expect(zh.netValue).toBeNull();
  });

  it('has no places or regions when the map is empty', () => {
    const review = buildCandidateReview(
      input({
        working: {
          faqs: [A, B],
          phrasings: [],
          map: { nodes: [], placements: [] },
        },
      }),
    );
    expect(review.places).toEqual([]);
    expect(review.regions).toEqual([]);
    expect(
      review.similar.every((s) => s.placePath.length === 0 && !s.samePlace),
    ).toBe(true);
  });
});

describe('rationaleOf', () => {
  const faqs = new Map([[A.id, A]]);
  it('names the target card for phrasings, updates and retirement', () => {
    expect(
      rationaleOf(
        candidate({
          suggestion: 'add_phrasing',
          relatedNodeId: A.id,
          relatedScore: 0.71,
        }),
        faqs,
        0.71,
      ).zh,
    ).toBe(
      '6 次提问和「问题1？」很像（相似度 0.71），但当时没给用户看这张卡，多半是没被找到（说没帮上 4 次、看完开工单 2 次）。',
    );
    expect(
      rationaleOf(
        candidate({ suggestion: 'retire_faq', relatedNodeId: A.id }),
        faqs,
        null,
      ).en,
    ).toBe(
      'Suggest retiring "Question 1?": a nearly identical card sits in the same place.',
    );
  });
});

describe('textScores', () => {
  it('keeps the best score per card over every query and text', async () => {
    const scores = await textScores(
      ['付款后会员没有生效', ''],
      [
        { nodeId: 'a', text: '付款后会员没有生效怎么办' },
        { nodeId: 'a', text: '完全无关的句子' },
        { nodeId: 'b', text: '怎么修改密码' },
      ],
      createNgramSimilarity(),
    );
    expect(scores.get('a')!).toBeGreaterThan(scores.get('b')!);
    expect(
      await textScores(
        [],
        [{ nodeId: 'a', text: 'x' }],
        createNgramSimilarity(),
      ),
    ).toEqual(new Map());
  });
});
