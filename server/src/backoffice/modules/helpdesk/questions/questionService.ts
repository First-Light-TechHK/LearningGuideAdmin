import { createHash } from 'node:crypto';

import type { SessionEmployee } from '../../../contracts/employee';
import {
  isHelpdeskCategory,
  isHelpdeskLocale,
  type HelpdeskQuestionStats,
  type HelpdeskSuggestionStats,
} from '../../../../contracts/helpdesk-qa';
import { isUuid, uuidv7 } from '../../../../common/uuidv7';
import { HelpdeskError } from '../portalHelpdeskClient';
import {
  QUESTION_LIMITS,
  QUESTION_STATUSES,
  type HelpdeskQuestion,
  type PublicQuestion,
  type PublishedQuestions,
  type QuestionRevision,
  type QuestionStatus,
  type QuestionView,
} from './questionContracts';
import {
  createPgQuestionRepository,
  type QuestionPatch,
  type QuestionRepository,
  type WriteResult,
} from './questionRepository';

/**
 * Common Questions 业务规则（Figma addendum §A）：
 * - 输入校验与归一化（问题 ≤200、答案 ≤4000 保留换行、关键词 ≤20 个且每个 ≤40、去重小写）；
 * - 状态：draft ⇄ published，draft / published → archived，archived → published（恢复）；
 *   归档后不能再编辑；
 * - 每次修改都带 version：先比版本（409 VERSION_CONFLICT），再看状态（409 INVALID_TRANSITION）；
 * - Portal 只读已发布的，带强 ETag（内容的 SHA-256）。
 */

export type TransitionAction = 'publish' | 'unpublish' | 'archive';

const TRANSITIONS: Record<
  TransitionAction,
  { from: QuestionStatus[]; to: QuestionStatus }
> = {
  publish: { from: ['draft', 'archived'], to: 'published' },
  unpublish: { from: ['published'], to: 'draft' },
  archive: { from: ['draft', 'published'], to: 'archived' },
};

const NO_STATS: HelpdeskQuestionStats = { shown: 0, solved: 0, declined: 0 };

function invalid(message: string): HelpdeskError {
  return new HelpdeskError(400, 'INVALID_INPUT', message);
}

function notFound(): HelpdeskError {
  return new HelpdeskError(404, 'QUESTION_NOT_FOUND', 'Question not found');
}

function conflict(currentVersion?: number): HelpdeskError {
  return new HelpdeskError(
    409,
    'VERSION_CONFLICT',
    currentVersion === undefined
      ? 'This question was changed by someone else. Reload and try again.'
      : `This question was changed by someone else (now version ${currentVersion}). Reload and try again.`,
  );
}

function badTransition(message: string): HelpdeskError {
  return new HelpdeskError(409, 'INVALID_TRANSITION', message);
}

function record(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function questionId(raw: string): string {
  if (!isUuid(raw)) throw invalid('Invalid question id');
  return raw.toLowerCase();
}

function version(body: Record<string, unknown>): number {
  const value = body.version;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    throw invalid('version must be a positive integer');
  return value;
}

function optionalBoolean(
  body: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = body[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw invalid(`${key} must be true or false`);
  return value;
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string') throw invalid(`${name} is required`);
  const normalised = value.replace(/\r\n?/g, '\n').trim();
  if (normalised.length < 1 || normalised.length > max)
    throw invalid(`${name} must be 1-${max} characters`);
  return normalised;
}

function keywords(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid('keywords must be a list');
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw invalid('keywords must be text');
    const keyword = item.trim().replace(/\s+/g, ' ').toLowerCase();
    if (keyword === '') continue;
    if (keyword.length > QUESTION_LIMITS.keywordMax)
      throw invalid(
        `Each keyword must be at most ${QUESTION_LIMITS.keywordMax} characters`,
      );
    if (!out.includes(keyword)) out.push(keyword);
  }
  if (out.length > QUESTION_LIMITS.keywordsMax)
    throw invalid(`At most ${QUESTION_LIMITS.keywordsMax} keywords`);
  return out;
}

type Editable = Required<
  Pick<
    QuestionPatch,
    'locale' | 'category' | 'question' | 'answer' | 'keywords' | 'featured'
  >
>;

function editable(body: Record<string, unknown>): Editable {
  if (!isHelpdeskLocale(body.locale))
    throw invalid('locale must be en-GB or zh-CN');
  if (!isHelpdeskCategory(body.category)) throw invalid('Unknown category');
  return {
    locale: body.locale,
    category: body.category,
    question: text(body.question, 'question', QUESTION_LIMITS.questionMax),
    answer: text(body.answer, 'answer', QUESTION_LIMITS.answerMax),
    keywords: keywords(body.keywords),
    featured: optionalBoolean(body, 'featured', false),
  };
}

function written<T>(result: WriteResult<T>): T {
  if (result.kind === 'not_found') throw notFound();
  if (result.kind === 'conflict') throw conflict(result.currentVersion);
  return result.value;
}

function publicShape(question: HelpdeskQuestion): PublicQuestion {
  return {
    id: question.id,
    category: question.category,
    question: question.question,
    answer: question.answer,
  };
}

/** 强 ETag：已发布内容的 SHA-256（base64url 前 27 位），内容不变即不变。 */
export function publishedEtag(questions: PublicQuestion[]): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(questions))
    .digest('base64url');
  return `"${digest.slice(0, 27)}"`;
}

/** RFC 9110 §13.1.2 If-None-Match：逗号分隔、弱比较、* 命中任意。 */
function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const strip = (tag: string) => tag.trim().replace(/^W\//, '');
  return header
    .split(',')
    .map(strip)
    .some((tag) => tag === '*' || tag === strip(etag));
}

export type QuestionListQuery = {
  locale?: string;
  category?: string;
  status?: string;
  q?: string;
};

export type PublishedQuery = { locale?: string; featured?: string };

export type PublishedResult = {
  etag: string;
  notModified: boolean;
  body: PublishedQuestions;
};

export type QuestionService = ReturnType<typeof createQuestionService>;

export function createQuestionService(
  options: {
    repository?: QuestionRepository;
    stats?: HelpdeskSuggestionStats;
  } = {},
) {
  const repository = options.repository ?? createPgQuestionRepository();
  const stats = options.stats;

  async function withStats(
    questions: HelpdeskQuestion[],
  ): Promise<QuestionView[]> {
    let counts = new Map<string, HelpdeskQuestionStats>();
    if (stats && questions.length > 0) {
      try {
        counts = await stats.statsFor(questions.map((q) => q.id));
      } catch {
        // 计数只是参考：读不到时页面照常显示，计数为 0
      }
    }
    return questions.map((question) => ({
      ...question,
      stats: { ...(counts.get(question.id) ?? NO_STATS) },
    }));
  }

  async function view(question: HelpdeskQuestion): Promise<QuestionView> {
    return (await withStats([question]))[0];
  }

  async function existing(id: string): Promise<HelpdeskQuestion> {
    const found = await repository.get(id);
    if (!found) throw notFound();
    return found;
  }

  return {
    async list(
      input: QuestionListQuery,
    ): Promise<{ questions: QuestionView[] }> {
      if (input.locale && !isHelpdeskLocale(input.locale))
        throw invalid('Unknown locale');
      if (input.category && !isHelpdeskCategory(input.category))
        throw invalid('Unknown category');
      let statuses: QuestionStatus[] = ['draft', 'published'];
      if (input.status === 'all') statuses = [...QUESTION_STATUSES];
      else if (input.status) {
        if (!(QUESTION_STATUSES as readonly string[]).includes(input.status))
          throw invalid('Unknown status');
        statuses = [input.status as QuestionStatus];
      }
      const q = input.q?.trim() ?? '';
      if (q.length > QUESTION_LIMITS.searchMax)
        throw invalid('Search is too long');
      const questions = await repository.list({
        locale: input.locale || undefined,
        category: input.category || undefined,
        statuses,
        q: q === '' ? undefined : q,
      });
      return { questions: await withStats(questions) };
    },

    async get(rawId: string): Promise<QuestionView> {
      return view(await existing(questionId(rawId)));
    },

    async revisions(rawId: string): Promise<{ revisions: QuestionRevision[] }> {
      const id = questionId(rawId);
      await existing(id);
      return { revisions: await repository.revisions(id) };
    },

    async create(
      employee: SessionEmployee,
      rawBody: unknown,
    ): Promise<QuestionView> {
      const body = record(rawBody);
      const fields = editable(body);
      const publish = optionalBoolean(body, 'publish', false);
      const now = new Date().toISOString();
      const created = await repository.insert(
        {
          id: uuidv7(),
          ...fields,
          status: publish ? 'published' : 'draft',
          sortOrder: await repository.nextSortOrder(fields.locale),
          version: 1,
          createdBy: employee.employeeId,
          updatedBy: employee.employeeId,
          createdAt: now,
          updatedAt: now,
        },
        employee.employeeId,
      );
      return view(created);
    },

    async update(
      employee: SessionEmployee,
      rawId: string,
      rawBody: unknown,
    ): Promise<QuestionView> {
      const id = questionId(rawId);
      const body = record(rawBody);
      const expected = version(body);
      const fields = editable(body);
      const current = await existing(id);
      if (current.version !== expected) throw conflict(current.version);
      if (current.status === 'archived')
        throw badTransition('Archived questions cannot be edited');
      return view(
        written(
          await repository.update(
            id,
            expected,
            fields,
            'update',
            employee.employeeId,
          ),
        ),
      );
    },

    async transition(
      employee: SessionEmployee,
      rawId: string,
      action: TransitionAction,
      rawBody: unknown,
    ): Promise<QuestionView> {
      const id = questionId(rawId);
      const expected = version(record(rawBody));
      const rule = TRANSITIONS[action];
      const current = await existing(id);
      if (current.version !== expected) throw conflict(current.version);
      if (!rule.from.includes(current.status))
        throw badTransition(`Cannot ${action} a ${current.status} question`);
      return view(
        written(
          await repository.update(
            id,
            expected,
            { status: rule.to },
            action,
            employee.employeeId,
          ),
        ),
      );
    },

    async reorder(
      employee: SessionEmployee,
      rawBody: unknown,
    ): Promise<{ questions: QuestionView[] }> {
      const items = record(rawBody).items;
      if (
        !Array.isArray(items) ||
        items.length === 0 ||
        items.length > QUESTION_LIMITS.reorderMax
      )
        throw invalid(
          `items must list 1-${QUESTION_LIMITS.reorderMax} questions`,
        );
      const parsed = items.map((raw) => {
        const item = record(raw);
        if (typeof item.id !== 'string') throw invalid('Invalid question id');
        return { id: questionId(item.id), version: version(item) };
      });
      if (new Set(parsed.map((item) => item.id)).size !== parsed.length)
        throw invalid('Each question may appear only once');
      const result = written(
        await repository.reorder(parsed, employee.employeeId),
      );
      return { questions: await withStats(result) };
    },

    async published(
      input: PublishedQuery,
      ifNoneMatch?: string,
    ): Promise<PublishedResult> {
      if (!isHelpdeskLocale(input.locale))
        throw invalid('locale must be en-GB or zh-CN');
      if (
        input.featured !== undefined &&
        input.featured !== 'true' &&
        input.featured !== 'false'
      )
        throw invalid('featured must be true or false');
      const rows = await repository.listPublished(
        input.locale,
        input.featured === 'true',
      );
      const questions = rows.map(publicShape);
      const etag = publishedEtag(questions);
      return {
        etag,
        notModified: ifNoneMatchHits(ifNoneMatch, etag),
        body: { questions, etag },
      };
    },
  };
}
