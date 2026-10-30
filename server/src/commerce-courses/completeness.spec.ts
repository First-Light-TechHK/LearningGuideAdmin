import { computeCompleteness, type CompletenessInput } from './completeness';

function baseInput(
  overrides: Partial<CompletenessInput> = {},
): CompletenessInput {
  return {
    categoryId: 'cat-1',
    learningMode: 'VIDEO_AND_TEXT',
    learningLanguages: ['en-GB'],
    localizations: [
      {
        language: 'en-GB',
        title: 'Course',
        shortDescription: 'Short',
        overview: 'Overview',
        whatYouLearn: ['a', 'b', 'c', 'd'],
        provides: ['1', '2', '3', '4'],
      },
    ],
    lessons: [
      {
        id: 'lesson-1',
        code: 'L001',
        sortOrder: 1,
        localizations: [
          {
            language: 'en-GB',
            title: 'Lesson 1',
            description: 'Description',
            videoAssetId: 'video-1',
            videoDurationSeconds: 120,
            textHtml: '<h1>H</h1><p>Body</p>',
          },
        ],
        learningPoints: [
          { language: 'en-GB', source: 'VIDEO' },
          { language: 'en-GB', source: 'TEXT' },
        ],
        questions: [{ question: 'Q', referenceAnswer: 'A' }],
        applicationTest: { scenario: 'S', referenceAnswer: 'A', enabled: true },
      },
    ],
    trialEnabled: true,
    trialRows: [
      {
        lessonId: 'lesson-1',
        status: 'READY',
        videoCutoffSeconds: 60,
        textCutoffLearningPointId: 'lp-1',
      },
    ],
    ...overrides,
  };
}

describe('computeCompleteness', () => {
  it('marks all 3 steps complete', () => {
    const result = computeCompleteness(baseInput());
    expect(result.steps.courseInformation.complete).toBe(true);
    expect(result.steps.content.complete).toBe(true);
    expect(result.steps.trial.complete).toBe(true);
    expect(result.completedSteps).toBe(3);
    expect(result.canPublish).toBe(true);
  });

  it('blocks publish when Course Information is incomplete', () => {
    const result = computeCompleteness(
      baseInput({
        localizations: [
          {
            language: 'en-GB',
            title: 'Course',
            shortDescription: '',
            overview: 'Overview',
            whatYouLearn: ['a'],
            provides: ['1'],
          },
        ],
      }),
    );
    expect(result.steps.courseInformation.complete).toBe(false);
    expect(result.canPublish).toBe(false);
    expect(result.publishBlockers.join(' ')).toContain('Course Information');
  });

  it('allows publish with only one completed lesson study', () => {
    const result = computeCompleteness(
      baseInput({
        lessons: [
          baseInput().lessons[0],
          {
            id: 'lesson-2',
            code: 'L002',
            sortOrder: 2,
            localizations: [],
          },
        ],
      }),
    );
    expect(result.canPublish).toBe(true);
    expect(result.steps.content.complete).toBe(false);
  });

  it('requires trial lessons to be consecutive', () => {
    const result = computeCompleteness(
      baseInput({
        lessons: [
          baseInput().lessons[0],
          {
            id: 'lesson-2',
            code: 'L002',
            sortOrder: 2,
            localizations: baseInput().lessons[0].localizations,
            learningPoints: [
              { language: 'en-GB', source: 'VIDEO' },
              { language: 'en-GB', source: 'TEXT' },
            ],
          },
        ],
        trialRows: [
          { lessonId: 'lesson-2', status: 'READY', videoCutoffSeconds: 60 },
        ],
      }),
    );
    expect(result.steps.trial.complete).toBe(false);
  });
});
