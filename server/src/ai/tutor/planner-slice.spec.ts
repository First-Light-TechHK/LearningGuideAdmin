import { validatePlannerSlice, type TutorPlannerSlice } from './planner-slice';
import type { ReviewedTeachingPackage } from './reviewed-package-validator';

const teachingPackage: ReviewedTeachingPackage = {
  manifest: {
    courseId: 'course',
    releaseId: 'release',
    snapshotHash: 'a'.repeat(64),
    packageRevision: 1,
    schemaVersion: 'tutor-package-v1',
    buildVersion: 'builder-1',
  },
  sources: [],
  cards: [
    { cardId: 'frame-1', type: 'frame' },
    { cardId: 'misreading-1', type: 'misreading' },
    { cardId: 'lens-1', type: 'lens' },
    { cardId: 'move-1', type: 'teaching_move' },
  ] as ReviewedTeachingPackage['cards'],
  glossary: [
    {
      conceptId: 'concept-1',
      label: { en: 'Agency', zh: '能动性' },
      aliases: { en: ['choice'], zh: ['选择'] },
    },
  ],
};

function slice(overrides: Partial<TutorPlannerSlice> = {}): TutorPlannerSlice {
  return {
    turnCategory: 'concept_framework',
    detectedFrame: 'frame-1',
    likelyIssue: 'misreading-1',
    interpretiveLensId: 'lens-1',
    teachingMove: 'move-1',
    currentTurnContract: {
      speechAct: 'focused_question',
      responseLanguage: 'en-GB',
      requiredTerms: ['Agency', '能动性'],
      closeAfterResponse: false,
    },
    ...overrides,
  };
}

describe('validatePlannerSlice', () => {
  it('接受引用当前包注册卡与词汇的结构化诊断', () => {
    const result = validatePlannerSlice({
      candidate: slice(),
      action: 'study_question',
      teachingPackage,
    });
    expect(result).toEqual({ valid: true, value: slice() });
  });

  it('让 action 决定答案轮分类，拒绝 Planner 的不一致判断', () => {
    expect(
      validatePlannerSlice({
        candidate: slice({ turnCategory: 'submitted_answer' }),
        action: 'study_question',
        teachingPackage,
      }),
    ).toEqual({ valid: false, reason: 'ACTION_CATEGORY_MISMATCH' });
    expect(
      validatePlannerSlice({
        candidate: slice(),
        action: 'submitted_answer',
        teachingPackage,
      }),
    ).toEqual({ valid: false, reason: 'ACTION_CATEGORY_MISMATCH' });
  });

  it('拒绝未注册的 frame、misreading、lens、teaching move 和术语', () => {
    for (const candidate of [
      slice({ detectedFrame: 'invented' }),
      slice({ likelyIssue: 'invented' }),
      slice({ interpretiveLensId: 'invented' }),
      slice({ teachingMove: 'invented' }),
    ])
      expect(
        validatePlannerSlice({
          candidate,
          action: 'study_question',
          teachingPackage,
        }),
      ).toEqual({ valid: false, reason: 'UNREGISTERED_KNOWLEDGE_ID' });

    const unknownTerm = slice();
    unknownTerm.currentTurnContract.requiredTerms = ['invented phrase'];
    expect(
      validatePlannerSlice({
        candidate: unknownTerm,
        action: 'study_question',
        teachingPackage,
      }),
    ).toEqual({ valid: false, reason: 'UNREGISTERED_REQUIRED_TERM' });
  });

  it('严格拒绝模式、状态、展品状态及其他额外输出字段', () => {
    expect(
      validatePlannerSlice({
        candidate: { ...slice(), mode: 'LECTURE' },
        action: 'study_question',
        teachingPackage,
      }),
    ).toEqual({ valid: false, reason: 'INVALID_PLANNER_SLICE' });
    expect(
      validatePlannerSlice({
        candidate: { ...slice(), liveModelState: { value: 99 } },
        action: 'study_question',
        teachingPackage,
      }),
    ).toEqual({ valid: false, reason: 'INVALID_PLANNER_SLICE' });
  });

  it('拒绝无效语用约束、重复术语和畸形对象', () => {
    const duplicateTerms = slice();
    duplicateTerms.currentTurnContract.requiredTerms = ['Agency', 'agency'];
    for (const candidate of [
      {
        ...slice(),
        currentTurnContract: {
          ...slice().currentTurnContract,
          closeAfterResponse: 'no',
        },
      },
      { ...duplicateTerms },
      null,
      new Proxy(slice(), {}),
    ])
      expect(
        validatePlannerSlice({
          candidate,
          action: 'study_question',
          teachingPackage,
        }),
      ).toEqual({ valid: false, reason: 'INVALID_PLANNER_SLICE' });
  });

  it('拒绝 requiredTerms 稀疏数组和运行时非法 action', () => {
    const sparseTerms = slice();
    sparseTerms.currentTurnContract.requiredTerms = Array(1) as string[];
    expect(
      validatePlannerSlice({
        candidate: sparseTerms,
        action: 'study_question',
        teachingPackage,
      }),
    ).toEqual({ valid: false, reason: 'INVALID_PLANNER_SLICE' });

    expect(
      validatePlannerSlice({
        candidate: slice(),
        action: 'unexpected' as never,
        teachingPackage,
      }),
    ).toEqual({ valid: false, reason: 'INVALID_PLANNER_SLICE' });
  });
});
