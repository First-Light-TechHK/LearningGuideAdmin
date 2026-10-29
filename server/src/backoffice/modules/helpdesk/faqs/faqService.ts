import { createHash } from 'node:crypto';

import {
  FAQ_NODE_TYPES,
  FAQ_SIGNALS,
  isFaqCategory,
  isFaqSignal,
  isHelpdeskLocale,
  type FaqCategory,
  type FaqNodeType,
  type FaqSignal,
  type HelpdeskLocale,
} from '../../../../contracts/helpdesk-qa';
import { isUuid, uuidv7 } from '../../../../common/uuidv7';
import { HelpdeskError } from '../portalHelpdeskClient';
import {
  FAQ_KEY_PATTERN,
  FAQ_LIMITS,
  localised,
  type FaqActor,
  type FaqPage,
  type FaqRevision,
  type HelpdeskFaq,
  type PublicFaq,
  type PublishedFaqs,
} from './faqContracts';
import {
  createPgFaqRepository,
  type FaqPatch,
  type FaqRepository,
  type WriteResult,
} from './faqRepository';
import { unsafeLinks } from './faqMarkdown';
import { ifNoneMatchHits } from './faqRelease';
import { choicePromptProblem } from './faqGraphChecks';

/**
 * Helpdesk FAQ 业务规则（Tickets v2 §1 / §2 / §3）：
 * - 输入校验与归一化：中英问题 ≤200、答案 ≤4000（保留换行，Markdown 子集，链接只许 http(s) / mailto）、
 *   关键词 ≤20 个且每个 ≤40（去重、小写）、分类四选一；
 * - 保存即发布（Figma 没有草稿）；删除 = 归档（幂等）；归档后对员工与 Portal 都不可见；
 * - 每次修改都带 version，不一致 409 VERSION_CONFLICT；新建可带 Idempotency-Key；
 * - Portal 只读已发布的：按语言挑字段，带强 ETag（内容的 SHA-256）。
 */

function invalid(message: string): HelpdeskError {
  return new HelpdeskError(400, 'INVALID_INPUT', message);
}

function notFound(): HelpdeskError {
  return new HelpdeskError(404, 'FAQ_NOT_FOUND', 'FAQ not found');
}

function conflict(currentVersion?: number): HelpdeskError {
  return new HelpdeskError(
    409,
    'VERSION_CONFLICT',
    currentVersion === undefined
      ? 'This FAQ was changed by someone else. Reload and try again.'
      : `This FAQ was changed by someone else (now version ${currentVersion}). Reload and try again.`,
  );
}

function record(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function faqId(raw: string): string {
  if (!isUuid(raw)) throw invalid('Invalid FAQ id');
  return raw.toLowerCase();
}

function version(body: Record<string, unknown>): number {
  const value = body.version;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    throw invalid('version must be a positive integer');
  return value;
}

/**
 * 控制字符（保留 \t \n \r）：PostgreSQL TEXT 不收 U+0000（SQLSTATE 22021），
 * 不先拦住就是 500；其它不可见控制字符也没有正当用途。
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string') throw invalid(`${name} is required`);
  if (CONTROL.test(value)) throw invalid(`${name} has invalid characters`);
  const normalised = value.replace(/\r\n?/g, '\n').trim();
  if (normalised.length < 1 || normalised.length > max)
    throw invalid(`${name} must be 1-${max} characters`);
  return normalised;
}

/**
 * Markdown 链接 [文字](地址)：Portal 渲染器会丢掉的地址（非 http(s) / mailto、无主机、含空白或 " ' < > ` \\）
 * 一律拒绝保存；规则与解析就是 faqMarkdown.ts（与 Portal 同一份语料锁定）。
 */
function answer(value: unknown, name: string): string {
  const normalised = text(value, name, FAQ_LIMITS.answerMax);
  const [unsafe] = unsafeLinks(normalised);
  if (unsafe !== undefined)
    throw invalid(
      `${name}: links must be full https://, http:// or mailto: addresses without spaces, quotes, < > \` or \\ (${unsafe.slice(0, 80)})`,
    );
  return normalised;
}

function keywords(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid('keywords must be a list');
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw invalid('keywords must be text');
    if (CONTROL.test(item)) throw invalid('keywords have invalid characters');
    const keyword = item.trim().replace(/\s+/g, ' ').toLowerCase();
    if (keyword === '') continue;
    if (keyword.length > FAQ_LIMITS.keywordMax)
      throw invalid(
        `Each keyword must be at most ${FAQ_LIMITS.keywordMax} characters`,
      );
    if (!out.includes(keyword)) out.push(keyword);
  }
  if (out.length > FAQ_LIMITS.keywordsMax)
    throw invalid(`At most ${FAQ_LIMITS.keywordsMax} keywords`);
  return out;
}

/**
 * v5 Part A：FAQ 的信号标签。没给（旧的 BackOffice）→ undefined：新建按 []，编辑保留原值；
 * 给了就只收 FAQ_SIGNALS 里的（open_ticket_waiting 不是 FAQ），去重并按 chip 优先级排好。
 */
function signals(value: unknown): FaqSignal[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalid('signals must be a list');
  for (const item of value)
    if (!isFaqSignal(item))
      throw invalid(`Unknown signal: ${String(item).slice(0, 40)}`);
  return FAQ_SIGNALS.filter((signal) => value.includes(signal));
}

/** v5 问题树的 key：不给 → undefined（新建按英文问题取 slug，编辑保留原值）；给了就小写、校验格式。 */
function key(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid('key must be text');
  const normalised = value.trim().toLowerCase();
  if (!FAQ_KEY_PATTERN.test(normalised))
    throw invalid(
      `key must be 1-${FAQ_LIMITS.keyMax} lowercase letters, digits, ".", "_" or "-", starting with a letter or digit`,
    );
  return normalised;
}

function nodeType(value: unknown): FaqNodeType | undefined {
  if (value === undefined) return undefined;
  if (!(FAQ_NODE_TYPES as readonly unknown[]).includes(value))
    throw invalid('type must be answer or choice');
  return value as FaqNodeType;
}

function entry(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw invalid('entry must be true or false');
  return value;
}

type Editable = Required<
  Pick<
    FaqPatch,
    | 'category'
    | 'popular'
    | 'questionEn'
    | 'answerEn'
    | 'questionZh'
    | 'answerZh'
    | 'keywords'
  >
> & {
  signals: FaqSignal[] | undefined;
  /** v5 问题树的节点字段：没给（旧的 BackOffice）→ undefined，新建用缺省、编辑保留原值。 */
  key: string | undefined;
  type: FaqNodeType | undefined;
  entry: boolean | undefined;
};

function editable(body: Record<string, unknown>): Editable {
  if (!isFaqCategory(body.category)) throw invalid('Unknown category');
  const popular = body.popular ?? false;
  if (typeof popular !== 'boolean')
    throw invalid('popular must be true or false');
  return {
    key: key(body.key),
    type: nodeType(body.type),
    entry: entry(body.entry),
    category: body.category,
    popular,
    questionEn: text(body.questionEn, 'questionEn', FAQ_LIMITS.questionMax),
    answerEn: answer(body.answerEn, 'answerEn'),
    questionZh: text(body.questionZh, 'questionZh', FAQ_LIMITS.questionMax),
    answerZh: answer(body.answerZh, 'answerZh'),
    keywords: keywords(body.keywords),
    signals: signals(body.signals),
  };
}

/** 没给 signals 的编辑与原值比较时按原值算（只改文字的旧 BackOffice 不会清掉标签）。 */
function sameFields(a: Editable, b: HelpdeskFaq): boolean {
  return (
    (a.signals ?? b.signals).join('\n') === b.signals.join('\n') &&
    (a.key ?? b.key) === b.key &&
    (a.type ?? b.type) === b.type &&
    (a.entry ?? b.entry) === b.entry &&
    a.category === b.category &&
    a.popular === b.popular &&
    a.questionEn === b.questionEn &&
    a.answerEn === b.answerEn &&
    a.questionZh === b.questionZh &&
    a.answerZh === b.answerZh &&
    a.keywords.join('\n') === b.keywords.join('\n')
  );
}

/** choice 节点的「答案」是那句提问：不陈述事实，不许数字、链接、邮箱（graph design §1 / §2.3）。 */
function checkChoicePrompt(type: FaqNodeType, fields: Editable): void {
  if (type !== 'choice') return;
  for (const [name, prompt] of [
    ['answerEn', fields.answerEn],
    ['answerZh', fields.answerZh],
  ] as const)
    if (choicePromptProblem(prompt))
      throw invalid(
        `${name}: the prompt of a choice question must not contain digits, links or emails`,
      );
}

/** key 唯一（helpdesk_faqs_key_key）：撞了 → 409，不是 500。 */
async function keyTaken<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const pg = error as { code?: unknown; constraint?: unknown };
    if (pg?.code === '23505' && pg.constraint === 'helpdesk_faqs_key_key')
      throw new HelpdeskError(
        409,
        'FAQ_KEY_TAKEN',
        'Another question already uses this key',
      );
    throw error;
  }
}

function written<T>(result: WriteResult<T>): T {
  if (result.kind === 'not_found') throw notFound();
  if (result.kind === 'conflict') throw conflict(result.currentVersion);
  return result.value;
}

function publicShape(faq: HelpdeskFaq, locale: HelpdeskLocale): PublicFaq {
  return {
    id: faq.id,
    category: faq.category,
    popular: faq.popular,
    ...localised(faq, locale),
    signals: faq.signals,
    updatedAt: faq.updatedAt,
  };
}

/** 强 ETag：已发布内容的 SHA-256（base64url 前 27 位），内容不变即不变。 */
export function publishedEtag(faqs: PublicFaq[]): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(faqs))
    .digest('base64url');
  return `"${digest.slice(0, 27)}"`;
}

/** 查询参数只收一个字符串，其它（?q=a&q=b 的数组、对象、数字）一律 400，不是 500。 */
function queryText<K extends string>(
  input: Partial<Record<K, unknown>>,
  keys: readonly K[],
): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== 'string')
      throw invalid(`${key} must be a single text value`);
    out[key] = value;
  }
  return out;
}

function optionalCategory(raw: string | undefined): FaqCategory | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!isFaqCategory(raw)) throw invalid('Unknown category');
  return raw;
}

function optionalPopular(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (raw !== 'true' && raw !== 'false')
    throw invalid('popular must be true or false');
  return raw === 'true';
}

function positiveInt(
  raw: string | undefined,
  name: string,
  fallback: number,
  max: number,
): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > max
  )
    throw invalid(`${name} must be 1-${max}`);
  return value;
}

function search(raw: string | undefined): string | undefined {
  const q = raw?.trim() ?? '';
  if (q.length > FAQ_LIMITS.searchMax) throw invalid('Search is too long');
  return q === '' ? undefined : q;
}

/** 控制器原样转来的查询参数（类型未知，见 queryText）。 */
export type FaqListQuery = Partial<
  Record<'category' | 'popular' | 'q' | 'page' | 'pageSize', unknown>
>;

export type PublishedQuery = Partial<
  Record<'locale' | 'popular' | 'category' | 'q' | 'limit', unknown>
>;

export type PublishedResult = {
  etag: string;
  notModified: boolean;
  body: PublishedFaqs;
};

export type FaqService = ReturnType<typeof createFaqService>;

/** 归档前检查用：还在用这个节点的已发布父节点（v5 问题树；实现是 faqGraphRepository.liveParents）。 */
export type FaqParentsLookup = (
  id: string,
) => Promise<Pick<HelpdeskFaq, 'id' | 'key' | 'questionEn' | 'questionZh'>[]>;

export type FaqServiceOptions = {
  repository?: FaqRepository;
  /** 当前发布的版本号（没有 → null）：有了以后 Portal 读的 FAQ 列表 / 单条只来自那一版快照。 */
  releaseVersion?: () => Promise<number | null>;
  /** 还在用某节点的父节点；不给 = 没有边（单测）。 */
  liveParents?: FaqParentsLookup;
};

export function createFaqService(options: FaqServiceOptions = {}) {
  const repository = options.repository ?? createPgFaqRepository();
  const releaseVersion =
    options.releaseVersion ?? (() => Promise.resolve(null));
  const liveParents: FaqParentsLookup =
    options.liveParents ?? (() => Promise.resolve([]));

  /** 员工看得到的 FAQ：已归档（删除）的等同不存在。 */
  async function live(id: string): Promise<HelpdeskFaq> {
    const found = await repository.get(id);
    if (!found || found.status !== 'published') throw notFound();
    return found;
  }

  function locale(raw: unknown): HelpdeskLocale {
    if (!isHelpdeskLocale(raw)) throw invalid('locale must be en-GB or zh-CN');
    return raw;
  }

  return {
    async list(raw: FaqListQuery): Promise<FaqPage> {
      const input = queryText(raw, [
        'category',
        'popular',
        'q',
        'page',
        'pageSize',
      ]);
      const page = positiveInt(input.page, 'page', 1, 100_000);
      const pageSize = positiveInt(
        input.pageSize,
        'pageSize',
        FAQ_LIMITS.pageSize,
        FAQ_LIMITS.pageSizeMax,
      );
      const { faqs, total } = await repository.list({
        category: optionalCategory(input.category),
        popular: optionalPopular(input.popular),
        q: search(input.q),
        offset: (page - 1) * pageSize,
        limit: pageSize,
      });
      return { faqs, total, page, pageSize };
    },

    async get(rawId: string): Promise<HelpdeskFaq> {
      return live(faqId(rawId));
    },

    async revisions(rawId: string): Promise<{ revisions: FaqRevision[] }> {
      const id = faqId(rawId);
      await live(id);
      return { revisions: await repository.revisions(id) };
    },

    async create(
      employee: FaqActor,
      rawBody: unknown,
      rawKey?: string,
    ): Promise<HelpdeskFaq> {
      const fields = editable(record(rawBody));
      checkChoicePrompt(fields.type ?? 'answer', fields);
      let key: string | null = null;
      if (rawKey !== undefined && rawKey !== '') {
        if (!isUuid(rawKey)) throw invalid('Idempotency-Key must be a UUID');
        key = rawKey.toLowerCase();
      }
      const now = new Date().toISOString();
      const { faq, created } = await keyTaken(() =>
        repository.insert(
          {
            id: uuidv7(),
            ...fields,
            signals: fields.signals ?? [],
            // 空 key：仓库 / 数据库按英文问题取第一个空闲的 slug
            key: fields.key ?? '',
            type: fields.type ?? 'answer',
            entry: fields.entry ?? true,
            status: 'published',
            version: 1,
            createdBy: employee.employeeId,
            updatedBy: employee.employeeId,
            createdAt: now,
            updatedAt: now,
          },
          employee.employeeId,
          key,
        ),
      );
      // 同一个 key 换了内容（draft-ietf-httpapi-idempotency-key-header：422）
      if (!created && faq.version === 1 && !sameFields(fields, faq))
        throw new HelpdeskError(
          422,
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used for a different FAQ',
        );
      return faq;
    },

    async update(
      employee: FaqActor,
      rawId: string,
      rawBody: unknown,
    ): Promise<HelpdeskFaq> {
      const id = faqId(rawId);
      const body = record(rawBody);
      const expected = version(body);
      const fields = editable(body);
      const current = await live(id);
      checkChoicePrompt(fields.type ?? current.type, fields);
      // PUT 是幂等的（RFC 9110 §9.2.2）：内容已经是这样（丢了响应后的重试、什么都没改的保存）
      // 就原样返回，不升版本、不写修订；内容不同而 version 过期才是冲突
      if (sameFields(fields, current)) return current;
      if (current.version !== expected) throw conflict(current.version);
      const patch: FaqPatch = {
        category: fields.category,
        popular: fields.popular,
        questionEn: fields.questionEn,
        answerEn: fields.answerEn,
        questionZh: fields.questionZh,
        answerZh: fields.answerZh,
        keywords: fields.keywords,
      };
      // 没给的（旧的 BackOffice）保留原值
      if (fields.signals !== undefined) patch.signals = fields.signals;
      if (fields.key !== undefined) patch.key = fields.key;
      if (fields.type !== undefined) patch.type = fields.type;
      if (fields.entry !== undefined) patch.entry = fields.entry;
      return written(
        await keyTaken(() =>
          repository.update(id, expected, patch, 'update', employee.employeeId),
        ),
      );
    },

    /**
     * 删除 = 归档；已经归档的再删一次直接成功（幂等，不再写修订）。v5 问题树：还有已发布的父节点
     * 在用它 → 409 FAQ_HAS_PARENTS，消息里列出这些父节点（graph design §2.3）。
     */
    async archive(
      employee: FaqActor,
      rawId: string,
      rawBody: unknown,
    ): Promise<HelpdeskFaq> {
      const id = faqId(rawId);
      const expected = version(record(rawBody));
      const current = await repository.get(id);
      if (!current) throw notFound();
      if (current.status === 'archived') return current;
      if (current.version !== expected) throw conflict(current.version);
      const parents = await liveParents(id);
      if (parents.length > 0)
        throw new HelpdeskError(
          409,
          'FAQ_HAS_PARENTS',
          `This question is still a follow-up or option of: ${parents
            .map((parent) => `"${parent.questionEn}" (${parent.key})`)
            .join(', ')
            .slice(0, 800)}. Remove it there first.`,
        );
      return written(
        await repository.update(
          id,
          expected,
          { status: 'archived' },
          'archive',
          employee.employeeId,
        ),
      );
    },

    async published(
      raw: PublishedQuery,
      ifNoneMatch?: string,
    ): Promise<PublishedResult> {
      const input = queryText(raw, [
        'locale',
        'popular',
        'category',
        'q',
        'limit',
      ]);
      const lang = locale(input.locale);
      const popular = optionalPopular(input.popular);
      const category = optionalCategory(input.category);
      const limit = positiveInt(
        input.limit,
        'limit',
        FAQ_LIMITS.publicLimitDefault,
        FAQ_LIMITS.publicLimitMax,
      );
      const q = search(input.q);
      // 第一版发布之后只读那一版快照（single switch）；之前读逐条发布的行
      const release = await releaseVersion();
      const scope = release === null ? {} : { release };
      const rows = q
        ? await repository.searchPublished({
            locale: lang,
            boost: null,
            text: q,
            limit,
            category,
            popular,
            ...scope,
          })
        : await repository.listPublished({
            category,
            popular,
            limit,
            ...scope,
          });
      const faqs = rows.map((faq) => publicShape(faq, lang));
      const etag = publishedEtag(faqs);
      return {
        etag,
        notModified: ifNoneMatchHits(ifNoneMatch, etag),
        body: { faqs, etag },
      };
    },

    async publishedOne(
      rawId: string,
      raw: Pick<PublishedQuery, 'locale'>,
    ): Promise<PublicFaq> {
      const lang = locale(queryText(raw, ['locale']).locale);
      if (!isUuid(rawId)) throw notFound();
      const found = await repository.getPublished(rawId.toLowerCase(), {
        release: await releaseVersion(),
      });
      // choice 节点不是文章（只有一句提问），旧的 Portal 不会渲染选项
      if (!found || found.type === 'choice') throw notFound();
      return publicShape(found, lang);
    },
  };
}
