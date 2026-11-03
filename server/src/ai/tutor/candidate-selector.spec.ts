import {
  selectTutorCandidates,
  type TutorCandidate,
} from './candidate-selector';

const card = (
  id: string,
  extra: Partial<TutorCandidate> = {},
): TutorCandidate => ({
  id,
  courseId: 'c',
  releaseId: 'r',
  status: 'approved',
  priority: 1,
  score: 1,
  tokenCount: 100,
  requiredIds: [],
  ...extra,
});

describe('selectTutorCandidates', () => {
  it('选择必需依赖并稳定排序，排除跨版本与未审核卡', () => {
    const candidates = [
      card('b', { requiredIds: ['a'] }),
      card('a'),
      card('z', { releaseId: 'other' }),
      card('q', { status: 'candidate' }),
    ];
    const select = (list: TutorCandidate[]) =>
      selectTutorCandidates({
        courseId: 'c',
        releaseId: 'r',
        candidates: list,
        requiredIds: ['b'],
      });
    expect(select(candidates).coverageVerified).toBe(false);
    expect(select(candidates).selected.map((item) => item.id)).toEqual([
      'a',
      'b',
    ]);
    expect(select([...candidates].reverse())).toEqual(select(candidates));
    expect(select(candidates).excluded).toEqual([
      { id: 'q', reason: 'not_eligible' },
      { id: 'z', reason: 'not_eligible' },
    ]);
  });
  it('必需依赖缺失或超预算时拒绝', () => {
    expect(() =>
      selectTutorCandidates({
        courseId: 'c',
        releaseId: 'r',
        candidates: [card('a', { requiredIds: ['missing'] })],
        requiredIds: ['a'],
      }),
    ).toThrow('required card unavailable');
    expect(() =>
      selectTutorCandidates({
        courseId: 'c',
        releaseId: 'r',
        candidates: [card('a'), card('b')],
        requiredIds: ['a', 'b'],
        maxTokens: 199,
      }),
    ).toThrow('budget');
  });
  it('拒绝重复 ID、非法预算以及不足两张', () => {
    expect(() =>
      selectTutorCandidates({
        courseId: 'c',
        releaseId: 'r',
        candidates: [card('a'), card('a')],
        requiredIds: [],
      }),
    ).toThrow();
    expect(() =>
      selectTutorCandidates({
        courseId: 'c',
        releaseId: 'r',
        candidates: [card('a')],
        requiredIds: [],
        maxTokens: NaN,
      }),
    ).toThrow();
    expect(() =>
      selectTutorCandidates({
        courseId: 'c',
        releaseId: 'r',
        candidates: [card('a')],
        requiredIds: [],
      }),
    ).toThrow('insufficient');
  });
});
