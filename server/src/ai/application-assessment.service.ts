import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KNOWLEDGE_CLIENT,
  type KnowledgeClient,
} from '../ks/contract/knowledge-client';
import {
  parseApplicationFeedback,
  type ApplicationAssessmentRequest,
  type ApplicationAssessmentResult,
} from '../contracts/application-assessment';
import { AiConfigService } from './ai-config.service';
import { ProviderRegistry } from './providers/provider.registry';
import { RateLimitService } from './rate-limit.service';
import { buildTutorContext, loadTutorRelease } from './tutor/course-context';
import { applicationReference } from './application-reference';

const prompt = readFileSync(
  join(__dirname, 'prompts/application-assessment.md'),
  'utf8',
);

@Injectable()
export class ApplicationAssessmentService {
  private readonly logger = new Logger(ApplicationAssessmentService.name);
  constructor(
    @Inject(KNOWLEDGE_CLIENT) private readonly knowledge: KnowledgeClient,
    private readonly configs: AiConfigService,
    private readonly providers: ProviderRegistry,
    private readonly limits: RateLimitService,
  ) {}

  async evaluate(
    input: ApplicationAssessmentRequest,
  ): Promise<ApplicationAssessmentResult> {
    const course = await this.knowledge.getCourseByExternalId(
      input.externalCourseId,
    );
    if (!course) throw new NotFoundException('COURSE_NOT_FOUND');
    if (!course.aiTutorOnline) throw new ForbiddenException('AI_TUTOR_OFFLINE');
    if (!course.currentReleaseId)
      throw new ConflictException('NO_LIVE_RELEASE');
    await this.limits.assertAllowed(course.id, 'portal', input.userId);
    const release = await loadTutorRelease(
      this.knowledge,
      course.id,
      course.currentReleaseId,
    );
    const referenceAnswer = applicationReference(release, input.question);
    const [runtime, context] = await Promise.all([
      this.configs.resolveRuntime(course.id, release.id, 'ASSESSMENT'),
      buildTutorContext(this.knowledge, release, input.question),
    ]);
    let output = '';
    try {
      for await (const delta of this.providers.get(runtime.provider).stream({
        ...runtime,
        messages: [
          { role: 'system', content: prompt },
          {
            role: 'user',
            content: JSON.stringify({
              locale: input.locale,
              question: input.question,
              studentAnswer: input.answer,
              courseKnowledge: context.text || '',
              referenceAnswer: referenceAnswer.contentMarkdown,
            }),
          },
        ],
        maxOutputTokens: 3000,
        timeoutMs: 60000,
        signal: AbortSignal.timeout(60000),
      })) {
        output += delta;
        if (output.length > 24000) throw new Error('OUTPUT_TOO_LONG');
      }
      const feedback = parseApplicationFeedback(JSON.parse(output));
      this.logger.log(
        JSON.stringify({
          evaluationId: input.evaluationId,
          releaseId: release.id,
          event: 'evaluated',
        }),
      );
      return {
        evaluationId: input.evaluationId,
        status: feedback.needsReview ? 'needs_review' : 'evaluated',
        feedback,
        yourAnswer: input.answer,
        referenceAnswer,
        releaseId: release.id,
      };
    } catch {
      this.logger.warn(
        JSON.stringify({ evaluationId: input.evaluationId, event: 'failed' }),
      );
      throw new BadGatewayException('APPLICATION_EVALUATION_FAILED');
    }
  }
}
