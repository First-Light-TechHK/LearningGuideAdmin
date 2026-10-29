import { Logger } from '@nestjs/common';

import {
  ATTACHMENT_CHARSETS,
  ATTACHMENT_CONTENT_TYPES,
  ATTACHMENT_INLINE_TYPES,
  ATTACHMENT_MAX_BYTES,
  type Agent,
  type AgentAction,
  ASSIST_FEEDBACK,
  type AssistFeedback,
  type AttachmentCharset,
  type AttachmentFile,
  type AuthorKind,
  type PortalTicketList,
  type TicketAiAssist,
  type TicketAttachment,
  type TicketDetail,
  type TicketEvent,
  type ListStatusFilter,
  ORDER_ID_PATTERN,
  ORDER_PLAN_NAME_MAX,
  type TicketMessage,
  type TicketOrder,
  type TicketStatus,
  type TicketStudent,
  type TicketSubscription,
  type TicketSummary,
} from './contracts';

/**
 * Portal HelpDesk 集成接口的唯一客户端（Tickets v1 §4 / §5 Integration）。
 *
 * - 鉴权：`Authorization: Bearer PORTAL_HELPDESK_TOKEN`（RFC 6750）；地址取
 *   `PORTAL_HELPDESK_BASE_URL`。两者每次请求现读，令牌轮换后无需改代码或重启。
 * - 任一未配置：503 HELPDESK_NOT_CONNECTED，且不发出请求。
 * - Portal 错误为 RFC 9457 problem+json，在这里映射成 BackOffice 统一错误码。
 * - Portal 字段名与预期有出入时，只改本文件里的 normalise* 函数。
 */

const JSON_TIMEOUT_MS = 5_000;
const ATTACHMENT_TIMEOUT_MS = 10_000;
const EVENT_TYPE_PREFIX = 'com.ilovelearningguide.helpdesk.ticket.';
const PROBLEM_CODE = /^[a-z][a-z0-9_]{0,63}$/i;
const PREVIEW_MAX = 120;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** BackOffice 对浏览器抛出的 HelpDesk 错误；控制器转成统一信封。 */
export class HelpdeskError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HelpdeskError';
  }
}

export function notConnected(): HelpdeskError {
  return new HelpdeskError(
    503,
    'HELPDESK_NOT_CONNECTED',
    'HelpDesk is not connected yet',
  );
}

function unavailable(status = 502): HelpdeskError {
  return new HelpdeskError(
    status,
    'HELPDESK_UNAVAILABLE',
    'HelpDesk service is unavailable, please try again',
  );
}

export type PortalHelpdeskConfig = { baseUrl: string; token: string };

/** 每次调用现读环境变量；地址必须是 http(s) URL。 */
export function portalHelpdeskConfig(): PortalHelpdeskConfig | null {
  const rawBase = process.env.PORTAL_HELPDESK_BASE_URL?.trim() ?? '';
  const token = process.env.PORTAL_HELPDESK_TOKEN?.trim() ?? '';
  if (rawBase === '' || token === '') return null;
  try {
    const url = new URL(rawBase);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return { baseUrl: rawBase.replace(/\/+$/, ''), token };
}

export type ListQuery = {
  /** 单个状态或 needs_reply；不传 = 全部（Portal 只接受一个值）。 */
  status?: Exclude<ListStatusFilter, 'all'>;
  category?: string;
  tag?: string;
  q?: string;
  /** v2：只看已标记的（Portal 只认 flagged=true）。 */
  flagged?: boolean;
  /** v2：某个学员的工单（学员时间线）。 */
  learnerId?: string;
  limit?: number;
  cursor?: string;
};

export type MessageInput = {
  body: string;
  internal: boolean;
  agent: Agent;
  expectedSequence: number;
};

export type ActionInput = {
  action: AgentAction;
  agent: Agent;
  /** mark_read 可不带；其余动作必带。 */
  expectedSequence?: number;
  /** add_tag / remove_tag 必带。 */
  tag?: string;
};

/** 属性写法（而非方法写法）：实现是闭包，不依赖 this。 */
export type PortalHelpdeskClient = {
  listTickets: (query: ListQuery) => Promise<PortalTicketList>;
  getTicket: (ticketId: string) => Promise<TicketDetail>;
  /** Portal 未返回工单体时为 null（调用方再读一次）。 */
  postMessage: (
    ticketId: string,
    input: MessageInput,
    idempotencyKey: string,
  ) => Promise<TicketDetail | null>;
  postAction: (
    ticketId: string,
    input: ActionInput,
    idempotencyKey: string,
  ) => Promise<TicketDetail | null>;
  getAttachment: (attachmentId: string) => Promise<AttachmentFile>;
};

export type PortalHelpdeskClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  attachmentTimeoutMs?: number;
};

// ------------------------------------------------------------------ 归一化

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 依次取第一个存在的字段（camelCase 优先，snake_case 兜底）。 */
function pick(raw: Raw, ...keys: string[]): unknown {
  for (const key of keys) {
    if (raw[key] !== undefined) return raw[key];
  }
  return undefined;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed)
    ? parsed
    : fallback;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = num(value, Number.NaN);
  return Number.isNaN(parsed) ? null : parsed;
}

function authorKind(value: unknown): AuthorKind | null {
  return value === 'learner' || value === 'agent' || value === 'system'
    ? value
    : null;
}

function normaliseLearner(raw: Raw): TicketSummary['learner'] {
  const nested = pick(raw, 'learner', 'user');
  if (isRecord(nested)) {
    return {
      id: str(nested.id),
      email: str(nested.email),
      name: str(nested.name),
    };
  }
  return {
    id: str(pick(raw, 'userId', 'user_id')),
    email: str(pick(raw, 'userEmail', 'user_email')),
    name: str(pick(raw, 'userName', 'user_name')),
  };
}

function normaliseAssignee(raw: Raw): Agent | null {
  const nested = raw.assignee;
  if (isRecord(nested)) {
    const id = strOrNull(nested.id);
    return id ? { id, name: str(nested.name) } : null;
  }
  const id = strOrNull(pick(raw, 'assigneeId', 'assignee_id'));
  return id
    ? { id, name: str(pick(raw, 'assigneeName', 'assignee_name')) }
    : null;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function normaliseTags(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (tag): tag is string => typeof tag === 'string' && tag !== '',
      )
    : [];
}

export function normaliseSummary(raw: unknown): TicketSummary {
  const r = isRecord(raw) ? raw : {};
  return {
    id: str(r.id),
    number: str(r.number),
    subject: str(r.subject),
    category: str(r.category),
    status: str(r.status) as TicketStatus,
    locale: str(r.locale, 'en-GB'),
    learner: normaliseLearner(r),
    contactEmail: strOrNull(pick(r, 'contactEmail', 'contact_email')),
    preview: str(r.preview).slice(0, PREVIEW_MAX),
    unreadByAgent: pick(r, 'unreadByAgent', 'unread_by_agent') === true,
    tags: normaliseTags(r.tags),
    needsReply: boolOrNull(pick(r, 'needsReply', 'needs_reply')),
    assignee: normaliseAssignee(r),
    sequence: num(r.sequence),
    createdAt: str(pick(r, 'createdAt', 'created_at')),
    updatedAt: str(pick(r, 'updatedAt', 'updated_at')),
    lastMessageAt: strOrNull(pick(r, 'lastMessageAt', 'last_message_at')),
    lastMessageBy: authorKind(pick(r, 'lastMessageBy', 'last_message_by')),
    confirmDueAt: strOrNull(pick(r, 'confirmDueAt', 'confirm_due_at')),
    closedAt: strOrNull(pick(r, 'closedAt', 'closed_at')),
    closeReason: strOrNull(pick(r, 'closeReason', 'close_reason')),
    rating: numOrNull(r.rating),
    flagged:
      r.flagged === true ||
      strOrNull(pick(r, 'flaggedAt', 'flagged_at')) !== null,
    orderId: orderId(pick(r, 'orderId', 'order_id')),
  };
}

// ------------------------------------------------------------ v4 Part A 订单

/** 订单号：与 Portal 同一格式（字母、数字、_、-，最长 64），否则 null。 */
function orderId(value: unknown): string | null {
  return typeof value === 'string' && ORDER_ID_PATTERN.test(value)
    ? value
    : null;
}

/** 状态 / 类型 / 支付方式：小写标识符；Portal 以后新增的值原样保留。 */
const ORDER_TOKEN = /^[a-z][a-z0-9_]{0,31}$/;
const CURRENCY = /^[A-Za-z]{3}$/;

function orderToken(value: unknown): string | null {
  return typeof value === 'string' && ORDER_TOKEN.test(value) ? value : null;
}

function orderAmount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function orderText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replace(CONTROL_CHARS, '').trim();
  return clean === '' ? null : clean.slice(0, max);
}

function isoTime(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
    ? value
    : null;
}

/**
 * Portal 的订单投影：只取 8 个字段（多给的一律丢弃），格式不对的字段为 null；
 * 没有合格订单号的整体视为没有订单。
 */
export function normaliseOrder(raw: unknown): TicketOrder | null {
  if (!isRecord(raw)) return null;
  const id = orderId(raw.id);
  if (id === null) return null;
  const currency = pick(raw, 'currency');
  return {
    id,
    status: orderToken(raw.status),
    amount: orderAmount(raw.amount),
    currency:
      typeof currency === 'string' && CURRENCY.test(currency)
        ? currency.toLowerCase()
        : null,
    planName: orderText(
      pick(raw, 'planName', 'plan_name'),
      ORDER_PLAN_NAME_MAX,
    ),
    kind: orderToken(raw.kind),
    createdAt: isoTime(pick(raw, 'createdAt', 'created_at')),
    paymentMode: orderToken(pick(raw, 'paymentMode', 'payment_mode')),
  };
}

function isInlineType(contentType: string): boolean {
  return (ATTACHMENT_INLINE_TYPES as readonly string[]).includes(contentType);
}

function normaliseAttachment(raw: Raw): TicketAttachment {
  const contentType = str(pick(raw, 'contentType', 'content_type'));
  return {
    id: str(raw.id),
    fileName: str(pick(raw, 'fileName', 'file_name')),
    contentType,
    size: num(pick(raw, 'size', 'sizeBytes', 'size_bytes')),
    inline: isInlineType(contentType),
  };
}

function normaliseMessage(raw: Raw): TicketMessage {
  const attachments = raw.attachments;
  return {
    id: str(raw.id),
    authorKind: authorKind(pick(raw, 'authorKind', 'author_kind')) ?? 'system',
    authorName: str(pick(raw, 'authorName', 'author_name')),
    body: str(raw.body),
    internal: raw.internal === true,
    attachments: Array.isArray(attachments)
      ? attachments.filter(isRecord).map(normaliseAttachment)
      : [],
    createdAt: str(pick(raw, 'createdAt', 'created_at')),
  };
}

function normaliseEvent(raw: Raw): TicketEvent {
  const type = str(raw.type);
  const data = isRecord(raw.data) ? raw.data : {};
  const actor = data.actor;
  return {
    id: str(raw.id),
    type: type.startsWith(EVENT_TYPE_PREFIX)
      ? type.slice(EVENT_TYPE_PREFIX.length)
      : type,
    time: str(raw.time),
    sequence: num(raw.sequence),
    data: {
      fromState: strOrNull(pick(data, 'fromState', 'from_state')),
      toState: strOrNull(pick(data, 'toState', 'to_state')),
      actor: isRecord(actor)
        ? {
            kind: str(actor.kind),
            id: strOrNull(actor.id),
            name: strOrNull(actor.name),
          }
        : null,
      reason: strOrNull(data.reason),
      messageId: strOrNull(pick(data, 'messageId', 'message_id')),
    },
  };
}

/** 右栏学员信息；Portal 没给 student 时用 learner 兜底（其余字段为 null）。 */
function normaliseStudent(raw: unknown, summary: TicketSummary): TicketStudent {
  const s = isRecord(raw) ? raw : {};
  const course = pick(s, 'currentCourse', 'current_course');
  const total = numOrNull(pick(s, 'totalEnquiries', 'total_enquiries'));
  return {
    id: str(s.id, summary.learner.id),
    name: str(s.name, summary.learner.name),
    accountEmail: str(
      pick(s, 'accountEmail', 'account_email'),
      summary.learner.email,
    ),
    contactEmail:
      strOrNull(pick(s, 'contactEmail', 'contact_email')) ??
      summary.contactEmail,
    joinedAt: strOrNull(pick(s, 'joinedAt', 'joined_at')),
    totalEnquiries: total === null ? null : Math.max(0, Math.floor(total)),
    currentCourse:
      isRecord(course) && typeof course.id === 'string'
        ? { id: course.id, title: str(course.title) }
        : null,
  };
}

function assistFeedback(value: unknown): AssistFeedback | null {
  return (ASSIST_FEEDBACK as readonly unknown[]).includes(value)
    ? (value as AssistFeedback)
    : null;
}

/** AI 回答的评分：只认 1–5 的整数（Portal 新增的字段，旧的 Portal 不给），别的都当没评。 */
function assistRating(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 5
    ? value
    : null;
}

function normaliseAiAssist(raw: Raw): TicketAiAssist {
  return {
    id: str(raw.id),
    source: str(raw.source),
    question: str(raw.question),
    faqId: strOrNull(pick(raw, 'faqId', 'faq_id')),
    faqQuestion: strOrNull(pick(raw, 'faqQuestion', 'faq_question')),
    answer: strOrNull(raw.answer),
    feedback: assistFeedback(raw.feedback),
    rating: assistRating(raw.rating),
    createdAt: str(pick(raw, 'createdAt', 'created_at')),
  };
}

function normaliseSubscription(raw: unknown): TicketSubscription | null {
  if (!isRecord(raw)) return null;
  return {
    planName: str(pick(raw, 'planName', 'plan_name')),
    billingCycle: str(pick(raw, 'billingCycle', 'billing_cycle')),
    status: str(raw.status),
    renewalDate: strOrNull(pick(raw, 'renewalDate', 'renewal_date')),
  };
}

export function normaliseDetail(raw: unknown): TicketDetail {
  const r = isRecord(raw) ? raw : {};
  const summary = normaliseSummary(r);
  const order = normaliseOrder(r.order);
  return {
    ...summary,
    orderId: summary.orderId ?? order?.id ?? null,
    student: normaliseStudent(r.student, summary),
    subscription: normaliseSubscription(r.subscription),
    order,
    messages: Array.isArray(r.messages)
      ? r.messages.filter(isRecord).map(normaliseMessage)
      : [],
    events: Array.isArray(r.events)
      ? r.events.filter(isRecord).map(normaliseEvent)
      : [],
    aiAssist: Array.isArray(r.aiAssist)
      ? r.aiAssist.filter(isRecord).map(normaliseAiAssist)
      : [],
  };
}

function normaliseList(raw: unknown): PortalTicketList {
  const r = isRecord(raw) ? raw : {};
  const counts: Record<string, number> = {};
  if (isRecord(r.counts)) {
    for (const [key, value] of Object.entries(r.counts)) {
      if (typeof value === 'number' && Number.isFinite(value))
        counts[key] = value;
    }
  }
  return {
    tickets: Array.isArray(r.tickets)
      ? r.tickets.filter(isRecord).map(normaliseSummary)
      : [],
    nextCursor: strOrNull(pick(r, 'nextCursor', 'next_cursor')),
    counts,
  };
}

/** 文本附件 Content-Type 里的 charset，只认 UTF-8 / UTF-16；旧编码（GBK 等）与非文本类型为 null。 */
function textCharset(
  contentType: string,
  header: string,
): AttachmentCharset | null {
  if (!contentType.startsWith('text/')) return null;
  const match = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(header);
  const charset = match ? match[1].toLowerCase() : null;
  return (ATTACHMENT_CHARSETS as readonly string[]).includes(charset ?? '')
    ? (charset as AttachmentCharset)
    : null;
}

/**
 * Content-Disposition 里的文件名（RFC 6266：filename* 优先）；去掉路径与控制字符，最长 120。
 */
export function dispositionFileName(header: string | null): string | null {
  if (!header) return null;
  let name: string | null = null;
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended) {
    try {
      name = decodeURIComponent(extended[2].trim());
    } catch {
      name = null;
    }
  }
  if (name === null) {
    const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(
      header,
    );
    if (plain)
      name = (plain[1] ?? plain[2] ?? '').replace(/\\(.)/g, '$1').trim();
  }
  if (!name) return null;
  const base = (name.split(/[\\/]/).pop() ?? '').replace(CONTROL_CHARS, '');
  return base === '' || base === '.' || base === '..'
    ? null
    : base.slice(0, 120);
}

// ------------------------------------------------------------------ 错误映射

type Problem = { code?: unknown; detail?: unknown; title?: unknown };

/** RFC 9457 problem+json → BackOffice 错误；Portal 的 401/403 绝不透传成员工会话失效。 */
function mapProblem(
  status: number,
  problem: Problem,
  notFoundCode: string,
  logger: Logger,
): HelpdeskError {
  const portalCode =
    typeof problem.code === 'string' && PROBLEM_CODE.test(problem.code)
      ? problem.code
      : null;
  const message =
    (typeof problem.detail === 'string' && problem.detail) ||
    (typeof problem.title === 'string' && problem.title) ||
    `Portal HelpDesk returned ${status}`;

  if (status === 401 || status === 403) {
    logger.warn(`Portal rejected the HelpDesk service token (${status})`);
    return notConnected();
  }
  if (status === 503 && portalCode === 'integration_disabled')
    return notConnected();
  if (status >= 500) {
    logger.warn(`Portal HelpDesk failed with ${status}`);
    return unavailable();
  }
  if (status === 404) return new HelpdeskError(404, notFoundCode, 'Not found');
  // Portal 的 400（invalid_request / validation_failed / idempotency_key_required）
  // 对员工来说都是「输入有误」：统一成 BackOffice 自己的 INVALID_INPUT。
  if (status === 400)
    return new HelpdeskError(400, 'INVALID_INPUT', message.slice(0, 300));
  const fallback =
    status === 409
      ? 'CONFLICT'
      : status === 429
        ? 'RATE_LIMITED'
        : 'INVALID_INPUT';
  return new HelpdeskError(
    status,
    portalCode ? portalCode.toUpperCase() : fallback,
    message.slice(0, 300),
  );
}

async function readProblem(response: Response): Promise<Problem> {
  try {
    const parsed: unknown = JSON.parse(await response.text());
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// ------------------------------------------------------------------ 客户端

export function createPortalHelpdeskClient(
  options: PortalHelpdeskClientOptions = {},
): PortalHelpdeskClient {
  const logger = new Logger('PortalHelpdeskClient');
  // 默认在调用时才取全局 fetch，便于测试替换
  const fetchImpl: typeof fetch =
    options.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? JSON_TIMEOUT_MS;
  const attachmentTimeoutMs =
    options.attachmentTimeoutMs ?? ATTACHMENT_TIMEOUT_MS;

  async function send(
    method: 'GET' | 'POST',
    path: string,
    init: {
      body?: unknown;
      idempotencyKey?: string;
      accept?: string;
      timeout: number;
      notFoundCode: string;
    },
  ): Promise<Response> {
    const config = portalHelpdeskConfig();
    if (!config) throw notConnected();
    const headers: Record<string, string> = {
      authorization: `Bearer ${config.token}`,
      accept: init.accept ?? 'application/json, application/problem+json',
    };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;

    let response: Response;
    try {
      response = await fetchImpl(
        `${config.baseUrl}/api/integration/helpdesk${path}`,
        {
          method,
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: AbortSignal.timeout(init.timeout),
          redirect: 'error',
        },
      );
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        logger.warn(`Portal HelpDesk timed out after ${init.timeout}ms`);
        throw unavailable(504);
      }
      logger.warn('Portal HelpDesk is unreachable');
      throw unavailable();
    }
    if (!response.ok) {
      throw mapProblem(
        response.status,
        await readProblem(response),
        init.notFoundCode,
        logger,
      );
    }
    return response;
  }

  async function readJson(response: Response): Promise<unknown> {
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw unavailable();
    }
    if (text.trim() === '') return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw unavailable();
    }
  }

  async function readTicket(response: Response): Promise<TicketDetail> {
    const parsed = await readJson(response);
    if (!isRecord(parsed) || typeof parsed.id !== 'string') throw unavailable();
    return normaliseDetail(parsed);
  }

  async function writeTicket(
    path: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<TicketDetail | null> {
    const response = await send('POST', path, {
      body,
      idempotencyKey,
      timeout: timeoutMs,
      notFoundCode: 'TICKET_NOT_FOUND',
    });
    const parsed = await readJson(response);
    if (!isRecord(parsed)) return null;
    // 有的实现会包一层 { ticket }
    const ticket = isRecord(parsed.ticket) ? parsed.ticket : parsed;
    return typeof ticket.id === 'string' && Array.isArray(ticket.messages)
      ? normaliseDetail(ticket)
      : null;
  }

  const ticketPath = (id: string) => `/tickets/${encodeURIComponent(id)}`;

  return {
    async listTickets(query) {
      const params = new URLSearchParams();
      if (query.status) params.set('status', query.status);
      if (query.category) params.set('category', query.category);
      if (query.tag) params.set('tag', query.tag);
      if (query.q) params.set('q', query.q);
      if (query.flagged) params.set('flagged', 'true');
      if (query.learnerId) params.set('learnerId', query.learnerId);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      if (query.cursor) params.set('cursor', query.cursor);
      const search = params.toString();
      const response = await send(
        'GET',
        `/tickets${search ? `?${search}` : ''}`,
        { timeout: timeoutMs, notFoundCode: 'TICKET_NOT_FOUND' },
      );
      const parsed = await readJson(response);
      if (!isRecord(parsed)) throw unavailable();
      return normaliseList(parsed);
    },

    async getTicket(ticketId) {
      const response = await send('GET', ticketPath(ticketId), {
        timeout: timeoutMs,
        notFoundCode: 'TICKET_NOT_FOUND',
      });
      return readTicket(response);
    },

    postMessage(ticketId, input, idempotencyKey) {
      return writeTicket(
        `${ticketPath(ticketId)}/messages`,
        {
          body: input.body,
          internal: input.internal,
          agent: input.agent,
          expectedSequence: input.expectedSequence,
        },
        idempotencyKey,
      );
    },

    postAction(ticketId, input, idempotencyKey) {
      const body: Record<string, unknown> = { action: input.action };
      if (input.tag !== undefined) body.tag = input.tag;
      body.agent = input.agent;
      if (input.expectedSequence !== undefined)
        body.expectedSequence = input.expectedSequence;
      return writeTicket(
        `${ticketPath(ticketId)}/actions`,
        body,
        idempotencyKey,
      );
    },

    async getAttachment(attachmentId) {
      const response = await send(
        'GET',
        `/attachments/${encodeURIComponent(attachmentId)}`,
        {
          accept: `${ATTACHMENT_CONTENT_TYPES.join(', ')}, application/problem+json`,
          timeout: attachmentTimeoutMs,
          notFoundCode: 'ATTACHMENT_NOT_FOUND',
        },
      );
      const header = response.headers.get('content-type') ?? '';
      const contentType = header.split(';')[0].trim().toLowerCase();
      if (
        !(ATTACHMENT_CONTENT_TYPES as readonly string[]).includes(contentType)
      ) {
        logger.warn(`Portal returned an attachment of type "${contentType}"`);
        throw unavailable();
      }
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > ATTACHMENT_MAX_BYTES)
        throw unavailable();
      let data: Buffer;
      try {
        data = Buffer.from(await response.arrayBuffer());
      } catch {
        throw unavailable();
      }
      if (data.length > ATTACHMENT_MAX_BYTES) throw unavailable();
      return {
        contentType,
        charset: textCharset(contentType, header),
        data,
        fileName: dispositionFileName(
          response.headers.get('content-disposition'),
        ),
      };
    },
  };
}
