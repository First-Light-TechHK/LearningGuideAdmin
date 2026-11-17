import {
  APPLICATION_FEEDBACK_VERSION,
  APPLICATION_RESPONSE_BANDS,
  InvalidApplicationFeedbackError,
  parseApplicationFeedback,
  normaliseApplicationResponseBand,
} from './application-assessment';

function feedback() {
  return {
    schemaVersion: APPLICATION_FEEDBACK_VERSION,
    overallBand: 'developing',
    whatYouDidWell: ['You defined the state variable.'],
    areasToImprove: ['Explain the assumptions behind your model.'],
    needsReview: false,
    reviewReason: null,
  };
}

describe('application assessment feedback contract', () => {
  it.each(APPLICATION_RESPONSE_BANDS)('accepts the %s band', (overallBand) => {
    expect(
      parseApplicationFeedback({ ...feedback(), overallBand }).overallBand,
    ).toBe(overallBand);
  });

  it.each([
    ['strong', 'strong'],
    ['mostly_good', 'developing'],
    ['partial', 'developing'],
    ['weak', 'needs_review'],
    ['insufficient_evidence', 'needs_review'],
  ])('maps historical %s to %s for display only', (oldBand, expected) => {
    expect(normaliseApplicationResponseBand(oldBand)).toBe(expected);
    if (oldBand !== 'strong')
      expect(() =>
        parseApplicationFeedback({ ...feedback(), overallBand: oldBand }),
      ).toThrow(InvalidApplicationFeedbackError);
  });

  it('rejects the old protocol and permits learning review without a material issue', () => {
    expect(() =>
      parseApplicationFeedback({
        ...feedback(),
        schemaVersion: 'application_feedback.v1',
      }),
    ).toThrow(InvalidApplicationFeedbackError);
    expect(
      parseApplicationFeedback({ ...feedback(), overallBand: 'needs_review' })
        .needsReview,
    ).toBe(false);
  });

  it('allows empty feedback lists without fabricating praise or criticism', () => {
    expect(
      parseApplicationFeedback({
        ...feedback(),
        whatYouDidWell: [],
        areasToImprove: [],
      }),
    ).toMatchObject({ whatYouDidWell: [], areasToImprove: [] });
  });

  it('preserves LaTeX through JSON and detaches arrays from model data', () => {
    const input = feedback();
    input.whatYouDidWell = [String.raw`You found $x=\frac{2}{3}$.`];
    const output = parseApplicationFeedback(JSON.parse(JSON.stringify(input)));
    expect(output.whatYouDidWell).toEqual(input.whatYouDidWell);
    output.whatYouDidWell.push('Changed');
    expect(input.whatYouDidWell).toHaveLength(1);
  });

  it('requires a reason and an unscored band when material needs review', () => {
    expect(
      parseApplicationFeedback({
        ...feedback(),
        overallBand: 'needs_review',
        needsReview: true,
        reviewReason: 'The available material conflicts with the question.',
      }).needsReview,
    ).toBe(true);
    for (const patch of [
      { needsReview: true },
      { needsReview: true, reviewReason: 'Conflict', overallBand: 'strong' },
      { reviewReason: 'Unexpected reason' },
    ])
      expect(() =>
        parseApplicationFeedback({ ...feedback(), ...patch }),
      ).toThrow(InvalidApplicationFeedbackError);
  });

  it.each([
    null,
    [],
    'invalid',
    {},
    { ...feedback(), overallBand: 'Strong response' },
    { ...feedback(), schemaVersion: 'unsupported' },
    { ...feedback(), yourAnswer: 'Model-rewritten answer' },
    { ...feedback(), referenceAnswer: 'Invented reference' },
    { ...feedback(), whatYouDidWell: [''] },
    { ...feedback(), whatYouDidWell: ['x'.repeat(2001)] },
    { ...feedback(), whatYouDidWell: Array(1) },
    { ...feedback(), whatYouDidWell: ['1', '2', '3', '4'] },
    { ...feedback(), areasToImprove: ['1', '2', '3'] },
    { ...feedback(), needsReview: 'false' },
  ])('rejects malformed model data %#', (input) => {
    expect(() => parseApplicationFeedback(input)).toThrow(
      InvalidApplicationFeedbackError,
    );
  });
});
