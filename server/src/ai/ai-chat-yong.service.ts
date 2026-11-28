import type { EvaluationExecution } from './evaluation-execution';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  KNOWLEDGE_CLIENT,
  type KnowledgeClient,
} from '../ks/contract/knowledge-client';
import {
  AiChatLogger,
  type AiChatLogEntry,
  type AiChatStatus,
} from './ai-chat-logger';
import { AiConfigService } from './ai-config.service';
import { ChatHistoryItemDto, ChatStreamDto } from './dto/chat-stream.dto';
import { DialogueTestStreamDto } from './dto/dialogue-test-stream.dto';
import { LearnerChatStreamDto } from './dto/learner-chat-stream.dto';
import { OpenRouterHttpError } from './providers/openrouter.provider';
import { ProviderRegistry } from './providers/provider.registry';
import { compileMotherbaseDialogue } from './tutor/motherbase-dialogue';
import { prepareReviewedLecture } from './tutor/lecture-teaching';
import {
  asksForCourseScript,
  asksForDefinition,
  definitionFollowUp,
} from './tutor/definition-request';
import { lectureQuestionLookup } from './tutor/lecture-question-reference';
import {
  lectureLanguage,
  translateLectureText,
} from './tutor/lecture-language';
import {
  assessProfessorAnswer,
  qaRollout,
  type ProfessorAnswer,
} from './tutor/professor-qa-coverage';
import {
  exhibitEvidence,
  exhibitDisplay,
  hasExplicitFormula,
  exhibitsForAnswer,
  linkedExhibitPassage,
  previousExhibitIds,
} from './tutor/lecture-exhibits';
import {
  type LectureReference,
  createLectureReferenceStream,
  lectureReferenceMarkdown,
} from './tutor/lecture-references';
import { validateTutorTurn } from './tutor/validator';
import { classifyLectureTopic } from './tutor/lecture-topic-classifier';
import {
  buildTutorContext,
  loadTutorRelease,
  passageSource,
  publishedQuestionContext,
  comparisonSubjects,
} from './tutor/course-context';
import {
  RateLimitService,
  type AiRateLimitChannel,
} from './rate-limit.service';

/** 学员端语言指令（已删除，2026-10-29）：
 * - main.md 第 5 节 LANGUAGE 已正式覆盖（含 language switch 不放松 1-4 节约束）
 * - LOCALE_INSTRUCTION 硬编码冗余，不再追加
 */

const MAX_CONTEXT_MESSAGES = 20;

/**
 * AI 对话编排（§4.4.2）：限流 → 加载配置 → 聚合知识库上下文 →
 * 组装 Prompt → Provider 流式调用。
 * 对话不落库（§4.3.2 拍板）；每次对话结束后由 AiChatLogger 旁路写运行日志
 * （§4.4.2 第 7 步，2026-10-22 拍板）。
 */
@Injectable()
export class AiChatYongService {
  constructor(
    // 课程与 Release 快照归 KS 所有，只经契约读取（docs/Engine_Split_Implementation.md）
    @Inject(KNOWLEDGE_CLIENT) private readonly knowledge: KnowledgeClient,
    private readonly configs: AiConfigService,
    private readonly registry: ProviderRegistry,
    private readonly rateLimit: RateLimitService,
    private readonly chatLogger: AiChatLogger,
  ) {}

  /** 后台测试对话：读「测试所选 Release」（aiTestReleaseId ?? currentReleaseId） */
  async *streamChat(
    dto: ChatStreamDto,
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    yield* this.run({
      courseIdHint: dto.courseId,
      message: dto.message,
      mode: dto.mode,
      history: dto.history,
      locale: null,
      channel: 'admin',
      quota: 'admin-test',
      signal,
      resolve: async () => {
        const course = await this.knowledge.getCourse(dto.courseId);
        if (!course) throw new NotFoundException('课程不存在');
        const releaseId = course.aiTestReleaseId ?? course.currentReleaseId;
        if (dto.expectedReleaseId && dto.expectedReleaseId !== releaseId) {
          throw new ConflictException('测试版本已变化，请刷新后重试');
        }
        return {
          courseId: course.id,
          courseTitle: course.title,
          // §4.3.1/§5.2（2026-10-20）：后台测试对话读「测试所选 Release」
          releaseId,
        };
      },
    });
  }

  /** 路线参数只作用于本次后台试跑，不写回课程配置或发布指针。 */
  async *streamDialogueTest(
    dto: DialogueTestStreamDto,
    signal?: AbortSignal,
    evaluation?: EvaluationExecution,
  ): AsyncGenerator<string> {
    if (!this.configs.availableModels().includes(dto.model)) {
      throw new BadRequestException('模型不在可用列表中');
    }
    yield* this.run({
      courseIdHint: dto.courseId,
      message: dto.message,
      mode: dto.mode,
      history: dto.history,
      locale: evaluation?.locale ?? dto.locale ?? null,
      channel: 'admin',
      quota: evaluation?.batch ? 'batch-test' : 'admin-test',
      signal,
      evaluation,
      testRoute: { model: dto.model, useKnowledge: dto.useKnowledge },
      resolve: async () => {
        const course = await this.knowledge.getCourse(dto.courseId);
        if (!course) throw new NotFoundException('课程不存在');
        return {
          courseId: course.id,
          courseTitle: course.title,
          releaseId: dto.releaseId,
        };
      },
    });
  }

  /**
   * 学员端对话（2026-10-22）：按 Portal course.slug 匹配 Course.externalId，
   * 强制 aiTutorOnline，且只读 currentReleaseId（绝不读 aiTestReleaseId）。
   */
  async *streamLearnerChat(
    dto: LearnerChatStreamDto,
    signal?: AbortSignal,
    onComplete?: (runtime: {
      requestId: string;
      releaseId: string | null;
      model: string;
      promptHash?: string;
    }) => void,
  ): AsyncGenerator<string> {
    yield* this.run({
      courseIdHint: dto.externalCourseId,
      message: dto.message,
      mode: dto.channel === 'study-group' ? 'LECTURE' : dto.mode,
      history: dto.history,
      locale: dto.locale,
      channel: 'learner',
      quota: dto.channel ?? 'portal',
      userId: dto.userId,
      signal,
      onComplete,
      resolve: async () => {
        const course = await this.knowledge.getCourseByExternalId(
          dto.externalCourseId,
        );
        if (!course) throw new NotFoundException('课程不存在');
        if (!course.aiTutorOnline) {
          throw new ForbiddenException('该课程 AI 导师未开放');
        }
        if (!course.currentReleaseId) {
          throw new ConflictException('该课程尚未发布可用版本');
        }
        if (
          dto.expectedReleaseId &&
          dto.expectedReleaseId !== course.currentReleaseId
        ) {
          throw new ConflictException('上线版本已变化，请刷新后重试');
        }
        return {
          courseId: course.id,
          courseTitle: course.title,
          releaseId: course.currentReleaseId,
        };
      },
    });
  }

  /** 产出文本增量流；失败由控制器转 SSE 错误帧。 */
  private async *run(input: {
    /** 课程解析失败时用于日志的兜底 id（后台为 UUID，学员为 externalId） */
    courseIdHint: string;
    message: string;
    mode: 'LECTURE' | 'SOCRATIC';
    history?: ChatHistoryItemDto[];
    locale: 'en-GB' | 'zh-CN' | null;
    channel: 'admin' | 'learner';
    /** 限流分桶（2026-10-23）：直播间与后台测试各自单独配额，默认按学员个人对话计 */
    quota?: AiRateLimitChannel;
    /** Portal 学员 userId（2026-10-28）：用于日志审计和用户级限流分桶；后台测试/直播间不传 */
    userId?: string;
    signal?: AbortSignal;
    evaluation?: EvaluationExecution;
    onComplete?: (runtime: {
      requestId: string;
      releaseId: string | null;
      model: string;
      promptHash?: string;
    }) => void;
    testRoute?: { model: string; useKnowledge: boolean };
    resolve: () => Promise<{
      courseId: string;
      courseTitle: string;
      releaseId: string | null;
    }>;
  }): AsyncGenerator<string> {
    const startedAt = Date.now();
    const requestId = randomUUID();
    const history = (input.history ?? [])
      .filter(
        (item) =>
          (item.role === 'user' || item.role === 'assistant') &&
          item.content?.trim(),
      )
      .slice(-MAX_CONTEXT_MESSAGES);
    let courseId = input.courseIdHint;
    let releaseId: string | null = null;
    let providerName = 'unknown';
    let model = 'unknown';
    let answer = '';
    let promptHash: string | undefined;
    let teaching: AiChatLogEntry['teaching'];
    let evidenceLog: AiChatLogEntry['evidence'];
    let finished = false;
    let status: AiChatStatus = 'ok';
    let errorText: string | undefined;
    let finishReason: string | null | undefined;
    let usage:
      | {
          inputTokens?: number;
          outputTokens?: number;
          reasoningTokens?: number;
        }
      | undefined;
    const attempts: NonNullable<AiChatLogEntry['attempts']> = [];
    const progress = (stage: string, attempt?: number) => {
      void this.chatLogger
        .writeProgress({
          requestId,
          stage,
          elapsedMs: Date.now() - startedAt,
          courseId,
          releaseId,
          mode: input.mode,
          channel: input.quota ?? 'portal',
          ...(attempt === undefined ? {} : { attempt }),
        })
        .catch(() => undefined);
    };

    try {
      progress('started');
      const resolved = await input.resolve();
      courseId = resolved.courseId;
      releaseId = resolved.releaseId;
      // 2026-10-29：没有可用版本（aiTestReleaseId 和 currentReleaseId 都 null）时直接拒绝，
      // 避免用空知识上下文回答（QA：新建课程未发布版本也能打开对话）
      if (!releaseId) {
        throw new BadRequestException('该课程没有可用的测试或上线版本');
      }
      await this.rateLimit.assertAllowed(
        courseId,
        input.quota ?? 'portal',
        input.userId,
      );
      progress('release_resolved');
      const release = await loadTutorRelease(
        this.knowledge,
        courseId,
        releaseId,
      );
      const question = input.message.trim();
      const comparison =
        input.mode === 'LECTURE' ? comparisonSubjects(question) : [];
      const conceptFollowUp =
        input.mode === 'LECTURE' && definitionFollowUp(question);
      const previousQuestion = history.findLast(
        (item) =>
          item.role === 'user' &&
          (!conceptFollowUp || !definitionFollowUp(item.content)),
      )?.content;
      const lastTurn = history.at(-1);
      const reference =
        input.mode === 'LECTURE' && input.testRoute?.useKnowledge !== false
          ? lectureQuestionLookup(
              question,
              release.pages,
              lectureLanguage(question, previousQuestion, input.locale),
              lastTurn?.role === 'assistant' ? lastTurn.content : undefined,
            )
          : undefined;
      const resolvedQuestion =
        reference && reference.kind !== 'clarify' ? reference : undefined;
      let passages: string[] = [];
      const sources: ReturnType<typeof passageSource>[] = [];
      let contextStrategy: NonNullable<AiChatLogEntry['evidence']>['context'] =
        input.testRoute?.useKnowledge === false ? 'disabled' : 'not_requested';
      const buildContext = async (
        query: string,
        topics: string[] = [],
        referenceOffset = 0,
      ) => {
        if (input.testRoute?.useKnowledge === false) return '';
        if (resolvedQuestion) {
          const context = await publishedQuestionContext(
            this.knowledge,
            release,
            resolvedQuestion.source,
            query,
            sources,
          );
          passages = context.passages;
          contextStrategy = 'published_question';
          progress('context_published_question');
          return context.text;
        }
        const context = await buildTutorContext(
          this.knowledge,
          release,
          query,
          topics,
          'wiki',
          sources,
          input.mode === 'LECTURE'
            ? [...topicsToCheck, ...comparison]
            : undefined,
          referenceOffset,
        );
        contextStrategy =
          context.text === null ? 'retrieval_empty' : context.strategy;
        progress(`context_${context.strategy}`);
        passages = context.passages ?? [];
        return context.text;
      };

      const display =
        input.mode === 'LECTURE' ? exhibitDisplay(question) : 'auto';
      const suppressImages = display === 'words' || display === 'no-image';
      const canDisplay = (ref: LectureReference) =>
        display !== 'words' &&
        !(suppressImages && ref.kind === 'image') &&
        !(display === 'image' && ref.kind !== 'image');
      const priorObjects = previousExhibitIds(history, release.id);
      const rollout = qaRollout(courseId, input.channel === 'admin');
      let eligible: ProfessorAnswer[] = [];
      let eligibleTeaching: string[] = [];
      let rankedCards: string[] = [];
      let rankedParts = new Map<string, number>();
      let topicsToCheck: string[] = [];
      let qaLanguage = '';
      let qaSearch: NonNullable<AiChatLogEntry['teaching']>['qaSearch'];
      let reviewed: ReturnType<typeof prepareReviewedLecture> | undefined =
        input.mode === 'LECTURE' &&
        input.testRoute?.useKnowledge !== false &&
        release.teachingPackage !== undefined
          ? prepareReviewedLecture(
              release,
              question,
              previousQuestion,
              undefined,
              priorObjects,
              input.locale,
              rollout === 'off'
                ? undefined
                : {
                    collect: (cards, language, teachingIds) => {
                      eligible = cards;
                      qaLanguage = language;
                      eligibleTeaching = teachingIds;
                    },
                  },
            )
          : undefined;
      if (reference?.kind === 'clarify') {
        input.signal?.throwIfAborted();
        providerName = 'local';
        model = 'question-reference';
        answer = reference.answer;
        evidenceLog = {
          route: 'direct_clarification',
          context: 'not_requested',
          sources: [],
        };
        promptHash = createHash('sha256')
          .update(JSON.stringify([release.id, question, answer]))
          .digest('hex');
        progress('question_reference_clarification');
        yield answer;
        input.signal?.throwIfAborted();
        finished = true;
        return;
      }
      if (resolvedQuestion) reviewed = undefined;
      const directCandidate =
        reviewed?.kind === 'wiki' ? reviewed.directCandidate : undefined;
      const reviewDefinition = () => {
        if (
          reviewed?.kind === 'reviewed' &&
          'definition' in reviewed &&
          reviewed.definition
        )
          return reviewed;
        if (!directCandidate) return undefined;
        const result = prepareReviewedLecture(
          release,
          question,
          previousQuestion,
          undefined,
          priorObjects,
          input.locale,
          { rankedCards, rankedParts, ignoreProfessorQa: true },
        );
        if (
          result.kind === 'reviewed' &&
          'definition' in result &&
          result.definition
        )
          return result;
      };
      const preferredDefinition = reviewDefinition();
      const definitionRequest = preferredDefinition?.definition;
      const definitionParts = definitionRequest?.requests;
      const courseScriptOnly =
        !!definitionParts?.remaining.length &&
        definitionParts.remaining.every(asksForCourseScript);
      const definitionFirst = !!(
        definitionRequest?.uniqueDefinition ||
        definitionRequest?.inherited ||
        courseScriptOnly
      );
      if (definitionFirst) reviewed = preferredDefinition;
      const scopedQa =
        definitionParts?.covered.length && !definitionFirst
          ? definitionParts.remaining
          : undefined;
      const scriptRequests =
        scopedQa?.filter(
          (part) =>
            asksForCourseScript(part) && definitionRequest?.gaps.includes(part),
        ) ?? [];
      const qaQuestion = scopedQa
        ? scopedQa.filter((part) => !asksForCourseScript(part)).join('\n')
        : question;
      let definitionFilledQaGap = false;
      if (
        !resolvedQuestion &&
        !definitionFirst &&
        qaQuestion.length > 0 &&
        qaQuestion.length <= 8000 &&
        (directCandidate ||
          (rollout !== 'off' &&
            (eligible.length || eligibleTeaching.length) &&
            this.knowledge.retrieveProfessorQa))
      ) {
        const started = Date.now();
        let candidates = directCandidate ? [directCandidate] : [];
        qaSearch = {
          rollout,
          source: directCandidate ? 'exact' : 'retrieval',
          status: directCandidate ? 'direct_match' : 'unavailable',
          candidates: candidates.map((c) => c.cardId),
        };
        try {
          const followUp =
            /^(那它|那么它|这个呢|它为什么|(?:请)?(?:给我|引用|展示)(?:教授的?|老师的?)?(?:原文|原话)|what about it\b|why is that\b|(?:please )?quote (?:the |that |your )?(?:professor|original)\b)/iu.test(
              question,
            );
          if (!directCandidate && this.knowledge.retrieveProfessorQa) {
            const query =
              followUp && previousQuestion && question.length <= 7300
                ? 'Previous: ' +
                  previousQuestion.slice(-600) +
                  '\nCurrent: ' +
                  qaQuestion
                : qaQuestion;
            const result = await this.knowledge.retrieveProfessorQa(
              courseId,
              release.id,
              query,
              eligible.map((c) => c.cardId),
              eligibleTeaching,
            );
            input.signal?.throwIfAborted();
            if (rollout === 'on') {
              rankedCards = (result.teachingCardIds ?? [])
                .filter((id) => eligibleTeaching.includes(id))
                .slice(0, 5);
              rankedParts = new Map(
                (result.teachingParts ?? [])
                  .filter(
                    ({ cardId, part }) =>
                      rankedCards.includes(cardId) &&
                      Number.isSafeInteger(part) &&
                      part > 0,
                  )
                  .map(({ cardId, part }) => [cardId, part]),
              );
              if (rankedCards.length)
                reviewed = prepareReviewedLecture(
                  release,
                  question,
                  previousQuestion,
                  undefined,
                  priorObjects,
                  input.locale,
                  { rankedCards, rankedParts },
                );
            }
            candidates = [...new Set(result.cardIds)]
              .slice(0, 5)
              .flatMap((id) => eligible.filter((c) => c.cardId === id));
            qaSearch = {
              rollout,
              source: 'retrieval',
              status: result.status,
              candidates: candidates.map((c) => c.cardId),
              generation: result.generation,
              retrievalMs: Date.now() - started,
            };
            qaSearch.teachingCandidates = (result.teachingCardIds ?? []).filter(
              (id) => eligibleTeaching.includes(id),
            );
          }
          if (candidates.length) {
            const decisionStart = Date.now();
            const runtime = await this.configs.resolveRuntime(
              courseId,
              release.id,
              input.mode,
            );
            const evidence = runtime.apiKey
              ? await assessProfessorAnswer(
                  this.registry.get(runtime.provider),
                  {
                    apiKey: runtime.apiKey,
                    baseUrl: runtime.baseUrl,
                    model: input.testRoute?.model ?? runtime.model,
                  },
                  qaQuestion,
                  candidates,
                  qaLanguage ||
                    lectureLanguage(question, previousQuestion, input.locale),
                  input.signal,
                  followUp ? previousQuestion?.slice(-600) : undefined,
                  (reason, missing) => {
                    if (qaSearch) qaSearch.reason = reason;
                    if (missing && (directCandidate || rollout === 'on'))
                      topicsToCheck = missing;
                  },
                )
              : undefined;
            qaSearch.decisionMs = Date.now() - decisionStart;
            if (!runtime.apiKey)
              qaSearch.reason = 'decision_runtime_unavailable';
            if (evidence && (directCandidate || rollout === 'on')) {
              const selected = prepareReviewedLecture(
                release,
                question,
                previousQuestion,
                undefined,
                priorObjects,
                input.locale,
                { professorEvidence: evidence },
              );
              if (
                selected.kind === 'reviewed' &&
                selected.trace.selectedCardIds.includes(evidence.cardId)
              ) {
                topicsToCheck = [
                  ...scriptRequests,
                  ...evidence.missingRequirements,
                ];
                const definitionReview = scopedQa
                  ? preferredDefinition
                  : evidence.coverage === 'partial'
                    ? reviewDefinition()
                    : undefined;
                const notes = definitionReview?.definition;
                if (definitionReview && notes) {
                  const remaining = topicsToCheck.filter(
                    (part) =>
                      !notes.names.some((name) =>
                        asksForDefinition(part, name),
                      ),
                  );
                  if (scopedQa || remaining.length < topicsToCheck.length) {
                    definitionFilledQaGap = true;
                    topicsToCheck = remaining;
                    reviewed = {
                      ...selected,
                      definition: { ...notes, gaps: remaining },
                      knowledge: [
                        definitionReview.knowledge,
                        selected.knowledge,
                      ].join('\n\n'),
                      outputContract:
                        'Use the approved professor answer for its covered question and the definition for the corresponding definition request. Search evidence supplied in this context may support remaining requests. Report unsupported parts. Attribute lecture quotations only to supplied lecture passages.',
                      references: [
                        ...new Map(
                          [
                            ...selected.references,
                            ...definitionReview.references,
                          ].map((ref) => [ref.id, ref]),
                        ).values(),
                      ],
                      trace: {
                        ...selected.trace,
                        selectedCardIds: [
                          ...new Set([
                            ...selected.trace.selectedCardIds,
                            ...definitionReview.trace.selectedCardIds,
                          ]),
                        ],
                        sourceIds: [
                          ...new Set([
                            ...selected.trace.sourceIds,
                            ...definitionReview.trace.sourceIds,
                          ]),
                        ],
                      },
                    };
                  }
                }
                if (!definitionFilledQaGap) reviewed = selected;
                qaSearch.accepted = evidence.cardId;
              } else qaSearch.reason = 'selection_unavailable';
            }
          }
        } catch {
          input.signal?.throwIfAborted();
          qaSearch.status = 'unavailable';
          qaSearch.reason ??= candidates.length
            ? 'decision_unavailable'
            : 'retrieval_unavailable';
        }
        if (
          candidates.length &&
          !qaSearch.accepted &&
          (directCandidate || rollout === 'on')
        ) {
          const definitionReview = reviewDefinition();
          if (definitionReview) reviewed = definitionReview;
        }
        if (
          candidates.length &&
          !qaSearch.accepted &&
          (directCandidate || rollout === 'on') &&
          reviewed &&
          reviewed.kind !== 'wiki' &&
          !('definition' in reviewed && reviewed.definition) &&
          !(
            reviewed.kind === 'clarify' &&
            reviewed.trace.outcome === 'no_applicable_evidence' &&
            comparison.length > 1
          )
        ) {
          teaching = {
            ...reviewed.trace,
            selectedCardIds: [],
            sourceIds: [],
            outcome: 'qa_course_fallback',
          };
          reviewed = undefined;
        }
      }
      const wiki = reviewed?.kind === 'wiki' ? reviewed : undefined;
      const wikiReferences = wiki?.wikiReferences;
      if (reviewed?.kind === 'wiki') reviewed = undefined;
      if (
        reviewed &&
        'topicHints' in reviewed &&
        reviewed.topicHints.length &&
        question.length >= 12 &&
        ['ambiguous_match', 'no_applicable_evidence'].includes(
          reviewed.trace.outcome,
        )
      ) {
        const fallback = await this.configs
          .resolveRuntime(courseId, releaseId, input.mode)
          .catch(() => undefined);
        if (fallback?.apiKey) {
          progress('lecture_classification_start');
          const topic = await classifyLectureTopic(
            this.registry.get(fallback.provider),
            {
              apiKey: fallback.apiKey,
              baseUrl: fallback.baseUrl,
              model: input.testRoute?.model ?? fallback.model,
            },
            question,
            reviewed.topicHints,
            input.signal,
          );
          if (topic)
            reviewed = prepareReviewedLecture(
              release,
              question,
              previousQuestion,
              topic,
              priorObjects,
              input.locale,
              { rankedCards, rankedParts },
            );
        }
      }
      teaching = reviewed?.trace ?? wiki?.trace ?? teaching;
      let fallbackContext: string | undefined;
      // 已知问题对象可以继续查正文，教学卡缺失本身不需要学生补充信息。
      if (
        reviewed?.kind === 'clarify' &&
        reviewed.trace.outcome === 'no_applicable_evidence' &&
        comparison.length > 1
      ) {
        const context = await buildContext(
          [...topicsToCheck, question].join(' '),
        ).catch(() => null);
        input.signal?.throwIfAborted();
        if (context?.trim()) {
          fallbackContext = context;
          reviewed = undefined;
          if (teaching) teaching.outcome = 'course_comparison_fallback';
        }
      } else if (
        reviewed?.kind === 'clarify' &&
        reviewed.trace.outcome === 'no_applicable_evidence' &&
        !reviewed.trace.exhibitCandidateIds.length &&
        hasExplicitFormula(question)
      ) {
        reviewed = undefined;
      } else if (
        reviewed?.kind === 'clarify' &&
        reviewed.searchCourse &&
        reviewed.trace.outcome === 'no_applicable_evidence' &&
        !reviewed.trace.exhibitCandidateIds.length
      ) {
        const context = await buildContext(question).catch(() => null);
        input.signal?.throwIfAborted();
        if (context?.trim()) {
          fallbackContext = context;
          reviewed = undefined;
          if (teaching) teaching.outcome = 'definition_course_fallback';
        }
      }
      if (teaching && qaSearch) teaching.qaSearch = qaSearch;
      if (
        teaching?.outcome === 'ambiguous_definition_follow_up' ||
        teaching?.outcome === 'ambiguous_definition_request'
      ) {
        teaching.definitionRouting = {
          intent: 'clarify',
          conceptOrigin:
            teaching.outcome === 'ambiguous_definition_request'
              ? 'current_question'
              : 'previous_question',
          mainCardIds: [],
          courseLookup: 'not_needed',
        };
      }
      if (wiki?.focus && teaching) {
        teaching.selectedCardIds.push(wiki.focus.cardId);
        teaching.outcome = wiki.followUp
          ? 'exhibit_follow_up'
          : 'exhibit_selected';
      }
      if (reviewed) {
        const accepted =
          reviewed.kind !== 'clarify' && reviewed.kind !== 'wiki';
        const validity = await validateTutorTurn({
          text: question,
          rules: [
            {
              reasonCode: 'REVIEWED_LECTURE_SCOPE',
              evaluate: () => ({
                action: accepted ? 'ACCEPT' : 'CLARIFY',
                confidence: 1,
              }),
            },
          ],
          ruleVersion: 'reviewed-lecture-v1',
          classifierVersion: 'rules-only',
          minimumConfidence: 1,
          classify: () => Promise.resolve(null),
        });
        progress(`validator_${validity.action.toLowerCase()}`);
      }
      const externalCourseId =
        input.channel === 'learner' ? input.courseIdHint : undefined;
      if (reviewed?.directAnswer) {
        evidenceLog = {
          route:
            reviewed.kind === 'clarify'
              ? 'direct_clarification'
              : 'direct_answer',
          context: contextStrategy,
          sources: [],
        };
        input.signal?.throwIfAborted();
        providerName = 'local';
        model = 'approved-content';
        const allowed = new Map(
          ('references' in reviewed ? (reviewed.references ?? []) : [])
            .filter(canDisplay)
            .map((ref) => [ref.id, ref]),
        );
        let directText = reviewed.directAnswer;
        const answerLanguage = lectureLanguage(
          question,
          previousQuestion,
          input.locale,
        );
        const sourceLanguage = /\p{Script=Han}/u.test(directText)
          ? 'zh-CN'
          : 'en-GB';
        if (answerLanguage !== sourceLanguage) {
          const runtime = await this.configs
            .resolveRuntime(courseId, release.id, input.mode)
            .catch(() => undefined);
          if (runtime?.apiKey) {
            const translation = await translateLectureText(
              this.registry.get(runtime.provider),
              {
                apiKey: runtime.apiKey,
                baseUrl: runtime.baseUrl,
                model: input.testRoute?.model ?? runtime.model,
              },
              directText,
              question,
              answerLanguage,
              input.signal,
            );
            if (translation) {
              directText = translation;
            }
          }
        }
        input.signal?.throwIfAborted();
        answer = directText.replace(
          /!?\[[^\]\r\n]*\]\(refobj:([a-z0-9-]+)\)/g,
          (_link, id: string) => {
            const reference = allowed.get(id);
            if (!reference) return '';
            if (!teaching?.objectIds.includes(id)) teaching?.objectIds.push(id);
            return lectureReferenceMarkdown(
              reference,
              courseId,
              externalCourseId,
              release.id,
            );
          },
        );
        if (externalCourseId)
          answer = answer.replaceAll(
            `/api/files/images/${courseId}/`,
            `/api/user/courses/${encodeURIComponent(externalCourseId)}/images/`,
          );
        if (!answer.trim())
          throw new ConflictException('LECTURE_APPROVED_ANSWER_EMPTY');
        progress('reviewed_direct_answer');
        promptHash = createHash('sha256')
          .update(JSON.stringify([teaching?.packageHash, question, answer]))
          .digest('hex');
        yield answer;
        input.signal?.throwIfAborted();
        finished = true;
        return;
      }
      const definition =
        reviewed && 'definition' in reviewed ? reviewed.definition : undefined;
      const onlyDefinition = definition?.uniqueDefinition;
      const courseGaps = definition
        ? [
            ...new Set([
              ...definition.gaps,
              ...topicsToCheck.filter(
                (part) =>
                  !onlyDefinition &&
                  !definition.names.some((name) =>
                    asksForDefinition(part, name),
                  ),
              ),
            ]),
          ]
        : topicsToCheck;
      const needsCourseContext =
        !reviewed ||
        (teaching?.qaCoverage === 'partial' &&
          (!definitionFilledQaGap || courseGaps.length > 0)) ||
        !!(definition && courseGaps.length);
      if (
        teaching &&
        definition &&
        (definition.requests.covered.length ||
          definition.inherited ||
          courseScriptOnly)
      ) {
        teaching.definitionRouting = {
          intent:
            definition.inherited ??
            (onlyDefinition
              ? 'definition'
              : definition.requests.covered.length
                ? 'mixed'
                : 'quotation'),
          conceptOrigin: definition.inherited
            ? 'previous_question'
            : 'current_question',
          mainCardIds: definition.cardIds,
          courseLookup: !needsCourseContext
            ? 'not_needed'
            : courseGaps.some(asksForCourseScript)
              ? 'course_script'
              : definition.inherited
                ? 'follow_up'
                : 'uncovered_request',
        };
      }
      const [runConfig, context] = await Promise.all([
        this.configs
          .resolveTutorRun(courseId, releaseId, input.mode)
          .then((current) =>
            input.evaluation
              ? {
                  ...input.evaluation.snapshot,
                  runtime: {
                    ...input.evaluation.snapshot.runtime,
                    apiKey: current.runtime.apiKey,
                  },
                }
              : current,
          ),
        !needsCourseContext
          ? ''
          : (fallbackContext ??
            buildContext(
              (definition
                ? [...courseGaps, ...definition.names]
                : [...courseGaps, question, ...(wiki?.focus?.names ?? [])]
              )
                .filter(Boolean)
                .join(' '),
              [],
              reviewed?.trace.sourceIds.length,
            ).catch((error: unknown) => {
              input.signal?.throwIfAborted();
              if (!definition && !definitionFilledQaGap) throw error;
              contextStrategy = 'retrieval_empty';
              return null;
            })),
      ]);
      const { runtime, dialoguePrompts } = runConfig;
      if (context === null) progress('retrieval_context_empty');
      providerName = runtime.provider;
      model = input.testRoute?.model ?? runtime.model;
      progress('context_ready');
      const allowedWikiRefs = new Map(
        (wikiReferences ?? []).map((ref) => [ref.id, ref]),
      );
      const wikiRefsInText = new Map<string, LectureReference>();
      const wikiText = wikiReferences
        ? (context ?? '').replace(
            /!?\[[^\]\r\n]*\]\(refobj:([a-z0-9-]+)\)/g,
            (_match, id: string) => {
              const ref = allowedWikiRefs.get(id);
              if (
                !ref ||
                (wiki?.focus && (wiki.followUp || wiki.focus.ref.id !== id))
              )
                return '';
              wikiRefsInText.set(id, ref);
              return canDisplay(ref)
                ? ref.label + ' [[ref:' + id + ']]'
                : ref.label;
            },
          )
        : (context ?? '');
      const evidence = wiki
        ? exhibitEvidence(
            wiki.focus
              ? [wiki.focus]
              : wiki.exhibits
                  .filter(
                    (item) =>
                      wiki.mentionedFormulas.includes(item) ||
                      wikiRefsInText.has(item.ref.id),
                  )
                  .slice(0, 4),
          )
        : '';
      let linkedSource =
        reviewed && 'linkedSource' in reviewed
          ? reviewed.linkedSource
          : undefined;
      const linkedPassage =
        wiki?.focus && !context?.includes(`(refobj:${wiki.focus.ref.id})`)
          ? linkedExhibitPassage(
              release.pages,
              wiki.focus.ref.id,
              (title, body) => {
                linkedSource = passageSource(title, null, body);
              },
            )
          : '';
      const knowledgeText = [wikiText, evidence, linkedPassage]
        .filter(Boolean)
        .join('\n\n');
      const exhibitTurn =
        wiki ?? (reviewed?.kind === 'reviewed' ? reviewed : undefined);
      const refsForAnswer = (
        reviewed && 'references' in reviewed
          ? (reviewed.references ?? [])
          : [...wikiRefsInText.values()]
      ).filter(
        (ref) =>
          canDisplay(ref) &&
          (!exhibitTurn?.focus || ref.id === exhibitTurn.focus.ref.id),
      );
      if (
        wiki?.focus &&
        !wiki.followUp &&
        !refsForAnswer.some((ref) => ref.id === wiki.focus?.ref.id)
      )
        refsForAnswer.push(wiki.focus.ref);
      const compiled = compileMotherbaseDialogue({
        model,
        basePrompt: dialoguePrompts.basePrompt,
        modePrompt: [
          dialoguePrompts.modePrompt,
          fallbackContext && comparison.length > 1
            ? 'Use evidence for each side of the comparison. Distinguish mathematical definitions from interpretations in a particular model. Do not infer a physical interpretation beyond what the course material supports. If evidence for one side is missing, say which side and what is missing.'
            : '',
          display === 'words'
            ? 'Use words only. Explain directly in prose without illustrations, equations or exhibit choices. Describe quantities in ordinary words. Omit coordinate tuples, variable symbols and math delimiters. Keep numbered source citations.'
            : display === 'no-image'
              ? 'Answer without images or image choices. Use equations if requested.'
              : display === 'image'
                ? 'Use only the selected exhibit and its supplied evidence. If unavailable say you could not locate it for this answer.'
                : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        knowledgeMarkdown:
          input.channel === 'learner'
            ? knowledgeText.replaceAll(
                `/api/files/images/${courseId}/`,
                `/api/user/courses/${encodeURIComponent(input.courseIdHint)}/images/`,
              )
            : knowledgeText,
        mode: input.mode,
        exhibits: exhibitTurn
          ? {
              allowedIds: refsForAnswer.map((ref) => ref.id),
              followUp: exhibitTurn.followUp,
            }
          : undefined,
        locale: input.locale,
        message: input.message,
        history,
        ...(reviewed?.kind === 'reviewed'
          ? {
              reviewedLecture: {
                planner: JSON.stringify(reviewed.planner),
                course: JSON.stringify({
                  courseId,
                  releaseId,
                  topic: reviewed.trace.topic,
                }),
                knowledge: [
                  reviewed.knowledge,
                  needsCourseContext ? knowledgeText : '',
                ]
                  .filter(Boolean)
                  .join('\n\n'),
                outputContract: reviewed.outputContract,
              },
            }
          : {}),
      });
      const messages = compiled.messages;
      evidenceLog = {
        route: reviewed?.kind === 'reviewed' ? 'reviewed' : 'course_context',
        context: contextStrategy,
        sources,
        ...(resolvedQuestion ? { questionMatch: resolvedQuestion.kind } : {}),
        linkedSource,
      };
      if (teaching && compiled.field4Hash)
        teaching.field4Hash = compiled.field4Hash;
      promptHash = createHash('sha256')
        .update(JSON.stringify(messages))
        .digest('hex');
      const provider = this.registry.get(runtime.provider);
      const maxOutputTokens = compiled.maxOutputTokens;
      const attemptStartedAt = Date.now();
      const renderer =
        suppressImages ||
        (reviewed && 'references' in reviewed) ||
        refsForAnswer.length ||
        wiki?.exhibits.length
          ? createLectureReferenceStream(
              refsForAnswer,
              courseId,
              externalCourseId,
              !wiki && !teaching?.qaId,
              releaseId,
            )
          : undefined;
      const preserveWikiImages =
        display === 'auto' &&
        wiki &&
        !wiki.focus &&
        !refsForAnswer.length &&
        /!\[[^\]\n]*\]\(\/api\//.test(wikiText);
      progress('provider_start', 1);
      try {
        const gen = provider.stream({
          model,
          messages,
          apiKey: runtime.apiKey,
          baseUrl: runtime.baseUrl,
          temperature: compiled.temperature,
          maxOutputTokens,
          reasoningEffort: compiled.reasoningEffort,
          reasoningEnabled: compiled.reasoningEnabled,
          signal: input.signal,
          connectionTimeoutMs: 30_000,
          firstTokenTimeoutMs: 20_000,
          idleTimeoutMs: 15_000,
          onEvent: (event) => {
            if (event.type === 'finish') finishReason = event.reason;
            else usage = event.usage;
          },
        });
        let pendingImage = '';
        const renderDelta = (chunk: string, final = false) => {
          if (suppressImages) {
            const data = pendingImage + chunk;
            const end = data.lastIndexOf('\n') + 1;
            const image = data.indexOf('!', end);
            const split = !final && image >= 0 ? image : data.length;
            pendingImage = data.slice(split);
            chunk = data
              .slice(0, split)
              .replace(/!\[[^\]\n]*\](?:\([^)\n]*\)|\[[^\]\n]*\])?/g, '');
          }
          return renderer ? renderer.write(chunk, !!preserveWikiImages) : chunk;
        };
        for await (const chunk of gen) {
          input.signal?.throwIfAborted();
          const delta = renderDelta(chunk);
          if (!delta) continue;
          if (!answer) progress('first_delta', 1);
          answer += delta;
          yield delta;
        }
        if (finishReason === 'length') {
          throw new ConflictException('AI 回答达到输出上限，内容未完成');
        }
        if (pendingImage) {
          const delta = renderDelta('', true);
          answer += delta;
          if (delta) yield delta;
        }
        if (
          !answer.trim() &&
          !renderer?.requestedObjects.size &&
          !renderer?.objectIds.size
        ) {
          throw new ConflictException(
            'AI 服务返回空回答，请重试或检查模型配置',
          );
        }
        const matched =
          exhibitTurn && !exhibitTurn.followUp
            ? exhibitTurn.focus
              ? [exhibitTurn.focus]
              : display === 'image'
                ? exhibitsForAnswer(
                    exhibitTurn.exhibits.filter((item) =>
                      refsForAnswer.some((ref) => ref.id === item.ref.id),
                    ),
                    answer,
                    passages,
                  )
                : []
            : [];
        let tail =
          renderer?.finish(
            matched.length === 1 ? [matched[0].ref] : [],
            answer,
          ) ?? '';
        if (exhibitTurn?.followUp && exhibitTurn.focus)
          tail += `\n\n[exhibit:${release.id}:${exhibitTurn.focus.ref.id}]: #focus`;
        if (tail) {
          answer += tail;
          yield tail;
          input.signal?.throwIfAborted();
        }
        if (renderer) teaching?.objectIds.push(...renderer.objectIds);
        finished = true;
      } finally {
        attempts.push({
          attempt: 1,
          finishReason,
          usage,
          answerChars: answer.length,
          latencyMs: Date.now() - attemptStartedAt,
          maxOutputTokens,
        });
      }
    } catch (err) {
      if (input.signal?.aborted) {
        status = 'aborted';
      } else {
        status = 'error';
        errorText =
          err instanceof OpenRouterHttpError && err.diagnostic
            ? `${err.message} (${err.diagnostic})`
            : err instanceof Error
              ? err.message
              : String(err);
      }
      throw err;
    } finally {
      // 未正常结束且未报错 → 客户端断开（生成器被提前 return）
      if (!finished && status === 'ok') status = 'aborted';
      if (finished && status === 'ok')
        input.onComplete?.({ requestId, releaseId, model, promptHash });
      progress(status);
      // 旁路写日志（§4.4.2 第 7 步）：不 await，不影响对话主流程
      void this.chatLogger
        .write({
          requestId,
          courseId,
          releaseId,
          mode: input.mode,
          channel: input.channel,
          ...(input.userId ? { userId: input.userId } : {}),
          provider: providerName,
          model,
          historyCount: history.length,
          latencyMs: Date.now() - startedAt,
          status,
          promptHash,
          teaching,
          evidence: evidenceLog,
          error: errorText,
          finishReason,
          usage,
          attempts,
          question: input.message,
          answer,
        })
        .catch(() => {
          /* AiChatLogger 内部已兜底；此处防未来替换实现后 unhandled rejection */
        });
    }
  }
}
