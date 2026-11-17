import { ApplicationAssessmentService } from './application-assessment.service';
import { applicationReference } from './application-reference';
import type {
  KnowledgeClient,
  KnowledgeRelease,
} from '../ks/contract/knowledge-client';
import type { AiConfigService } from './ai-config.service';
import type { ProviderRegistry } from './providers/provider.registry';
import type { RateLimitService } from './rate-limit.service';

const question = 'What is the mixed equilibrium?';
const release: KnowledgeRelease = {
  id: 'live',
  courseId: 'course',
  versionTag: 'v1',
  pages: [
    {
      title: 'Application Q&A',
      contentMd: `**Q1: ${question}**\n\nA1: Original $x=\\frac{2}{3}$.`,
    },
  ],
};
const feedback = {
  schemaVersion: 'application_feedback.v2',
  overallBand: 'developing',
  whatYouDidWell: ['A variable is defined.'],
  areasToImprove: ['Explain the model.'],
  needsReview: false,
  reviewReason: null,
};

function setup(output = JSON.stringify(feedback)) {
  const course = {
    id: 'course',
    externalId: 'modeling-life',
    currentReleaseId: 'live',
    aiTutorOnline: true,
  };
  const knowledge = {
    getCourseByExternalId: jest.fn().mockResolvedValue(course),
    getRelease: jest.fn().mockResolvedValue(release),
  };
  const configs = {
    resolveRuntime: jest.fn().mockResolvedValue({
      provider: 'fixture',
      model: 'fixture',
      apiKey: 'test',
      baseUrl: 'https://provider.example.test',
    }),
  };
  const stream = jest.fn().mockImplementation(async function* () {
    yield await Promise.resolve(output);
  });
  const providers = { get: jest.fn().mockReturnValue({ stream }) };
  const limits = { assertAllowed: jest.fn().mockResolvedValue(undefined) };
  const service = new ApplicationAssessmentService(
    knowledge as unknown as KnowledgeClient,
    configs as unknown as AiConfigService,
    providers as unknown as ProviderRegistry,
    limits as unknown as RateLimitService,
  );
  return { service, knowledge, configs, stream, limits };
}
const input = {
  externalCourseId: 'modeling-life',
  question,
  answer: 'My original answer',
  locale: 'en-GB' as const,
  userId: 'user',
  evaluationId: 'evaluation',
};

describe('application reference selection', () => {
  it('returns original source only for a complete question match', () => {
    expect(applicationReference(release, question)).toEqual({
      status: 'available',
      contentMarkdown: String.raw`Original $x=\frac{2}{3}$.`,
      sourceTitle: 'Application Q&A',
    });
    expect(applicationReference(release, 'Another question?').status).toBe(
      'unavailable',
    );
  });
  it('rejects ambiguous matches and keeps neighbouring answers separate', () => {
    expect(
      applicationReference(
        { ...release, pages: [...release.pages, ...release.pages] },
        question,
      ).status,
    ).toBe('unavailable');
    const page = {
      ...release.pages[0],
      contentMd:
        release.pages[0].contentMd +
        '\n\nQ2: Another question?\nA2: Another answer.',
    };
    expect(
      applicationReference({ ...release, pages: [page] }, question)
        .contentMarkdown,
    ).not.toContain('Another answer');
  });
});
describe('application assessment orchestration', () => {
  it('uses the existing live release, provider and original answer/reference', async () => {
    const { service, configs, limits, stream } = setup();
    const result = await service.evaluate(input);
    expect(configs.resolveRuntime.mock.calls[0]).toEqual([
      'course',
      'live',
      'ASSESSMENT',
    ]);
    expect(limits.assertAllowed.mock.calls[0]).toEqual([
      'course',
      'portal',
      'user',
    ]);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'evaluated',
      yourAnswer: input.answer,
      releaseId: 'live',
      feedback,
      referenceAnswer: { status: 'available' },
    });
  });
  it('returns unavailable reference without inventing one', async () => {
    const { service } = setup();
    expect(
      (await service.evaluate({ ...input, question: 'A different question' }))
        .referenceAnswer.status,
    ).toBe('unavailable');
  });
  it.each([
    'not JSON',
    JSON.stringify({ ...feedback, referenceAnswer: 'invented' }),
    '{"schemaVersion":',
  ])('rejects invalid or truncated model output', async (output) => {
    await expect(setup(output).service.evaluate(input)).rejects.toThrow(
      'APPLICATION_EVALUATION_FAILED',
    );
  });
  it('rejects missing, offline and unpublished courses before a model call', async () => {
    for (const course of [
      null,
      { id: 'course', aiTutorOnline: false },
      { id: 'course', aiTutorOnline: true, currentReleaseId: null },
    ]) {
      const { service, knowledge, stream } = setup();
      knowledge.getCourseByExternalId.mockResolvedValue(course);
      await expect(service.evaluate(input)).rejects.toThrow();
      expect(stream).not.toHaveBeenCalled();
    }
  });
  it('propagates provider failure without returning feedback', async () => {
    const { service, stream } = setup();
    stream.mockImplementation(async function* () {
      yield await Promise.reject(new Error('provider down'));
    });
    await expect(service.evaluate(input)).rejects.toThrow(
      'APPLICATION_EVALUATION_FAILED',
    );
  });
});
