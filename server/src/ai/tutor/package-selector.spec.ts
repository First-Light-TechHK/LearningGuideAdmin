import { buildAnchoredChunks } from './anchored-chunks';
import { selectPackageContext } from './package-selector';
import type { TutorPlannerSlice } from './planner-slice';
import type {
  ReviewedTeachingCard,
  ReviewedTeachingPackage,
} from './reviewed-package-validator';

const source = buildAnchoredChunks({
  courseId: 'course',
  releaseId: 'release',
  snapshot: {
    pages: [{ id: 'page', title: 'Page', contentMd: '# Topic\nEvidence.' }],
  },
})[0];

function card(input: {
  cardId: string;
  type: string;
  priority?: number;
  links?: string[];
  payload?: unknown;
}): ReviewedTeachingCard {
  return {
    cardId: input.cardId,
    conceptId: 'concept-1',
    type: input.type,
    topic: 'topic-1',
    canonicalPoint: 'Approved canonical point.',
    approvedPayload: input.payload ?? { explanation: 'Approved content.' },
    bilingual: {
      conceptLabel: { en: 'Concept', zh: '概念' },
      summary: { en: 'Summary', zh: '摘要' },
      triggers: { en: [], zh: [] },
    },
    useWhen: ['relevant question'],
    doNotUseWhen: ['unrelated question'],
    sourceSupport: [source.anchor.id],
    links: input.links ?? [],
    priority: input.priority ?? 1,
    reviewerId: 'reviewer',
    reviewStatus: 'approved',
    cardHash: 'b'.repeat(64),
  };
}

function packageWith(cards: ReviewedTeachingCard[]): ReviewedTeachingPackage {
  return {
    manifest: {
      courseId: 'course',
      releaseId: 'release',
      snapshotHash: source.snapshotHash,
      packageRevision: 1,
      schemaVersion: 'tutor-package-v1',
      buildVersion: 'builder-1',
    },
    sources: [source],
    cards,
    glossary: [
      {
        conceptId: 'concept-1',
        label: { en: 'Concept', zh: '概念' },
        aliases: { en: ['idea'], zh: ['观念'] },
      },
    ],
  };
}

function planner(
  overrides: Partial<TutorPlannerSlice> = {},
): TutorPlannerSlice {
  return {
    turnCategory: 'concept_framework',
    detectedFrame: 'frame-1',
    likelyIssue: 'misreading-1',
    interpretiveLensId: 'lens-1',
    teachingMove: 'move-1',
    currentTurnContract: {
      speechAct: 'explain',
      responseLanguage: 'en-GB',
      requiredTerms: ['Concept'],
      closeAfterResponse: false,
    },
    ...overrides,
  };
}

describe('selectPackageContext', () => {
  it('纳入 Planner 必需卡及链接、来源闭包，并生成不含内部 ID 的证据文本', () => {
    const teachingPackage = packageWith([
      card({ cardId: 'frame-1', type: 'frame', links: ['source-card'] }),
      card({ cardId: 'misreading-1', type: 'misreading' }),
      card({ cardId: 'lens-1', type: 'lens' }),
      card({ cardId: 'move-1', type: 'teaching_move' }),
      card({ cardId: 'source-card', type: 'source' }),
      card({ cardId: 'optional', type: 'concept' }),
    ]);
    const result = selectPackageContext({
      teachingPackage,
      planner: planner(),
      candidateScores: [{ cardId: 'optional', score: 0.9 }],
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.selectedCardIds).toEqual([
        'lens-1',
        'frame-1',
        'misreading-1',
        'source-card',
        'move-1',
      ]);
      expect(result.excluded).toContainEqual({
        cardId: 'optional',
        reason: 'CARD_LIMIT',
      });
      expect(result.selectedSources).toEqual([source]);
      expect(result.citationAllowlist).toEqual([
        { reference: 'S1', title: 'Page — Topic' },
      ]);
      expect(result.knowledgeText).toContain('S1');
      expect(result.knowledgeText).not.toContain('frame-1');
      expect(result.requiredReferencesSatisfied).toBe(true);
      expect(result.tokenEstimateMethod).toBe('utf8-bytes-divided-by-4');
    }
  });

  it('对候选按优先级、相关分数及 ID 稳定排序', () => {
    const teachingPackage = packageWith([
      card({ cardId: 'move-1', type: 'teaching_move' }),
      card({ cardId: 'a', type: 'concept', priority: 2 }),
      card({ cardId: 'b', type: 'concept', priority: 1 }),
      card({ cardId: 'c', type: 'concept', priority: 1 }),
    ]);
    const input = {
      teachingPackage,
      planner: planner({
        detectedFrame: null,
        likelyIssue: null,
        interpretiveLensId: null,
      }),
      candidateScores: [
        { cardId: 'a', score: 0.99 },
        { cardId: 'c', score: 0.2 },
        { cardId: 'b', score: 0.8 },
      ],
      minCards: 2,
      maxCards: 3,
      maxTokens: 2000,
    };
    const first = selectPackageContext(input);
    const second = selectPackageContext({
      ...input,
      candidateScores: [...input.candidateScores].reverse(),
    });
    expect(first).toEqual(second);
    if (first.valid)
      expect(first.selectedCardIds).toEqual(['b', 'c', 'move-1']);
  });

  it('缺 Planner 引用卡或必需闭包超预算时 fail-closed', () => {
    const teachingPackage = packageWith([
      card({ cardId: 'move-1', type: 'teaching_move' }),
    ]);
    expect(
      selectPackageContext({
        teachingPackage,
        planner: planner(),
        candidateScores: [],
      }),
    ).toEqual({ valid: false, reason: 'REQUIRED_CARD_MISSING' });
    expect(
      selectPackageContext({
        teachingPackage,
        planner: planner({
          detectedFrame: null,
          likelyIssue: null,
          interpretiveLensId: null,
        }),
        candidateScores: [],
        maxTokens: 1,
      }),
    ).toEqual({ valid: false, reason: 'REQUIRED_CLOSURE_EXCEEDS_BUDGET' });
  });

  it('排除超过预算的可选卡，并拒绝未知或无效召回结果', () => {
    const teachingPackage = packageWith([
      card({ cardId: 'move-1', type: 'teaching_move' }),
      card({ cardId: 'small', type: 'concept' }),
      card({
        cardId: 'large',
        type: 'concept',
        payload: { explanation: 'x'.repeat(4000) },
      }),
    ]);
    const result = selectPackageContext({
      teachingPackage,
      planner: planner({
        detectedFrame: null,
        likelyIssue: null,
        interpretiveLensId: null,
      }),
      candidateScores: [
        { cardId: 'small', score: 0.8 },
        { cardId: 'large', score: 0.9 },
      ],
      maxTokens: 200,
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.selectedCardIds).toContain('small');
      expect(result.selectedCardIds).not.toContain('large');
      expect(result.excluded).toContainEqual({
        cardId: 'large',
        reason: 'TOKEN_BUDGET',
      });
    }
    const sparseCandidates: Array<{ cardId: string; score: number }> = [];
    sparseCandidates.length = 1;
    expect(
      selectPackageContext({
        teachingPackage,
        planner: planner({
          detectedFrame: null,
          likelyIssue: null,
          interpretiveLensId: null,
        }),
        candidateScores: [{ cardId: 'missing', score: 0.5 }],
      }),
    ).toEqual({ valid: false, reason: 'UNKNOWN_CANDIDATE' });
    expect(
      selectPackageContext({
        teachingPackage,
        planner: planner({
          detectedFrame: null,
          likelyIssue: null,
          interpretiveLensId: null,
        }),
        candidateScores: sparseCandidates,
      }),
    ).toEqual({ valid: false, reason: 'INVALID_CANDIDATES' });
  });
});
