import { validateFluencyAssessment } from './fluency-assessment';

function base(rubric: 'phase2_pragmatics_6' | 'fluency_pragmatics_9') {
  const count = rubric === 'phase2_pragmatics_6' ? 6 : 9;
  return {
    traceId: 'trace-1',
    judgeId: 'judge-v1',
    rubricVersion: 'rubric-v1',
    understanding: { score: 4, scaleId: 'understanding-0-to-5' },
    pragmatics: {
      rubric,
      dimensions: Array.from({ length: count }, (_, index) => ({
        id: `dimension-${index + 1}`,
        score: 4,
        passed: true,
      })),
    },
    hardFailures: [] as string[],
  };
}

describe('validateFluencyAssessment', () => {
  it('keeps understanding and the six-dimension Phase 2 rubric separate', () => {
    const result = validateFluencyAssessment(base('phase2_pragmatics_6'));
    expect(result).toMatchObject({
      valid: true,
      status: 'scored',
      understanding: { score: 4, scaleId: 'understanding-0-to-5' },
      pragmatics: { rubric: 'phase2_pragmatics_6' },
    });
  });

  it('keeps the nine-dimension Fluency rubric independent', () => {
    const result = validateFluencyAssessment(base('fluency_pragmatics_9'));
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.pragmatics.rubric).toBe('fluency_pragmatics_9');
    expect(result.pragmatics.dimensions).toHaveLength(9);
  });

  it('reports hard failures separately and never converts them to a passing score', () => {
    const result = validateFluencyAssessment({
      ...base('fluency_pragmatics_9'),
      hardFailures: ['TERM_LOSS'],
    });
    expect(result).toMatchObject({
      valid: true,
      status: 'failed',
      hardFailures: ['TERM_LOSS'],
    });
  });

  it('fails closed when trace evidence or rubric dimensions are missing or malformed', () => {
    const valid = base('phase2_pragmatics_6');
    for (const candidate of [
      { ...valid, traceId: '' },
      {
        ...valid,
        pragmatics: {
          ...valid.pragmatics,
          dimensions: valid.pragmatics.dimensions.slice(1),
        },
      },
      {
        ...valid,
        pragmatics: {
          ...valid.pragmatics,
          dimensions: valid.pragmatics.dimensions.map((dimension, index) =>
            index === 5 ? { ...dimension, id: 'dimension-1' } : dimension,
          ),
        },
      },
      { ...valid, understanding: { score: Number.NaN, scaleId: 'scale' } },
      { ...valid, pragmatics: { ...valid.pragmatics, rubric: 'unknown' } },
      { ...valid, extra: 'not in schema' },
    ]) {
      expect(validateFluencyAssessment(candidate)).toEqual({
        valid: false,
        status: 'unscored',
        reason: 'INVALID_ASSESSMENT',
      });
    }
  });
});
