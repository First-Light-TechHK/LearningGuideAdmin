import { randomUUID } from 'node:crypto';

import type { SessionEmployee } from '../../contracts/employee';
import { isUuid } from '../../../common/uuidv7';
import {
  AGENT_ACTIONS,
  LIST_STATUS_FILTERS,
  MESSAGE_BODY_MAX,
  TAG_MAX_LENGTH,
  TICKET_CATEGORIES,
  TICKET_STATUSES,
  type Agent,
  type AgentAction,
  type AttachmentFile,
  type AvailableActions,
  type EnquiryCounts,
  type EnquiryDetail,
  type EnquiryList,
  type ListStatusFilter,
  type TicketDetail,
  type TicketStatus,
  type TicketSummary,
} from './contracts';
import {
  createPortalHelpdeskClient,
  HelpdeskError,
  type ActionInput,
  type PortalHelpdeskClient,
} from './portalHelpdeskClient';

/**
 * HelpDesk Enquiries（设计文档 §4A；Figma addendum §D）。状态机只在 Portal 执行；
 * 这里负责：筛选参数校验（状态 / 类型 / 标签 / 搜索）、待回复判定、可用操作提示、输入校验、
 * 以及把当前登录员工注入为 agent（请求体里的 agent 一律忽略）。
 */

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
/** 与 Portal 的 q 上限一致（HELPDESK_LIMITS.queryMax）。 */
const MAX_QUERY = 120;
const MAX_CURSOR = 512;
const ATTACHMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** 待回复：Portal 给了 needsReply 就用它；否则 OPEN，或 ASSIGNED 且学员最后发言。 */
export function needsReply(
  ticket: Pick<TicketSummary, 'status' | 'lastMessageBy'> & {
    needsReply?: boolean | null;
  },
): boolean {
  if (typeof ticket.needsReply === 'boolean') return ticket.needsReply;
  if (ticket.status === 'OPEN') return true;
  return ticket.status === 'ASSIGNED' && ticket.lastMessageBy === 'learner';
}

function count(counts: Record<string, number>, key: string): number {
  const value = counts[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/** Portal 计数（每个状态 + needs_reply + all）→ 界面用的计数；缺的项推算。 */
export function enquiryCounts(counts: Record<string, number>): EnquiryCounts {
  const byStatus = Object.fromEntries(
    TICKET_STATUSES.map((status) => [status, count(counts, status)]),
  ) as Record<TicketStatus, number>;
  const sum = TICKET_STATUSES.reduce((total, s) => total + byStatus[s], 0);
  const portalNeedsReply = counts.needs_reply ?? counts.needsReply;
  return {
    needsReply:
      portalNeedsReply !== undefined
        ? count({ n: portalNeedsReply }, 'n')
        : byStatus.OPEN + byStatus.ASSIGNED,
    all: counts.all !== undefined ? count(counts, 'all') : sum,
    ...byStatus,
  };
}

/** 按 Tickets v1 §2 状态表，员工在各状态下可做的事（最终仍以 Portal 判定为准）。 */
export function availableActions(status: TicketStatus): AvailableActions {
  const active =
    status === 'OPEN' || status === 'ASSIGNED' || status === 'WAITING_USER';
  return {
    claim: status === 'OPEN',
    reply: active,
    internalNote: active || status === 'PENDING_CONFIRM' || status === 'CLOSED',
    proposeResolution: status === 'ASSIGNED' || status === 'WAITING_USER',
    tag: true,
    markRead: true,
  };
}

export function agentFor(employee: SessionEmployee): Agent {
  return { id: employee.employeeId, name: employee.displayName };
}

function invalid(message: string): HelpdeskError {
  return new HelpdeskError(400, 'INVALID_INPUT', message);
}

function record(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function ticketId(raw: string): string {
  if (!isUuid(raw)) throw invalid('Invalid ticket id');
  return raw;
}

/** Portal 只接受 UUID 形式的 Idempotency-Key；浏览器没给时这里生成。 */
function idempotencyKey(raw: string | undefined): string {
  if (raw === undefined || raw === '') return randomUUID();
  if (!isUuid(raw)) throw invalid('Idempotency-Key must be a UUID');
  return raw.toLowerCase();
}

function expectedSequence(body: Record<string, unknown>): number {
  const value = body.expectedSequence;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    throw invalid('expectedSequence must be a non-negative integer');
  return value;
}

/** 标签：去首尾空白、合并中间空白，1–32 字符，不含控制字符。 */
function tag(value: unknown): string {
  if (typeof value !== 'string') throw invalid('tag is required');
  if (CONTROL.test(value)) throw invalid('tag has invalid characters');
  const normalised = value.trim().replace(/\s+/g, ' ');
  if (normalised.length < 1 || normalised.length > TAG_MAX_LENGTH)
    throw invalid(`tag must be 1-${TAG_MAX_LENGTH} characters`);
  return normalised;
}

export type ListInput = {
  status?: string;
  category?: string;
  tag?: string;
  q?: string;
  cursor?: string;
  limit?: string;
};

function parseList(input: ListInput) {
  const status = (input.status || 'all') as ListStatusFilter;
  if (!(LIST_STATUS_FILTERS as readonly string[]).includes(status))
    throw invalid('Unknown status');
  const category = input.category || undefined;
  if (
    category !== undefined &&
    !(TICKET_CATEGORIES as readonly string[]).includes(category)
  )
    throw invalid('Unknown enquiry type');
  const tagFilter = input.tag ? tag(input.tag) : undefined;
  const q = input.q?.trim() ?? '';
  if (q.length > MAX_QUERY) throw invalid('Search is too long');
  const cursor = input.cursor ?? '';
  if (cursor.length > MAX_CURSOR) throw invalid('Invalid cursor');
  let limit = DEFAULT_LIMIT;
  if (input.limit !== undefined && input.limit !== '') {
    limit = Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
      throw invalid('limit must be 1-100');
  }
  return {
    status: status === 'all' ? undefined : status,
    category,
    tag: tagFilter,
    q: q === '' ? undefined : q,
    cursor: cursor === '' ? undefined : cursor,
    limit,
  };
}

function withActions(detail: TicketDetail): EnquiryDetail {
  return {
    ...detail,
    needsReply: needsReply(detail),
    available: availableActions(detail.status),
  };
}

export type HelpdeskService = ReturnType<typeof createHelpdeskService>;

export function createHelpdeskService(
  portal: PortalHelpdeskClient = createPortalHelpdeskClient(),
) {
  async function refreshed(
    id: string,
    written: TicketDetail | null,
  ): Promise<EnquiryDetail> {
    return withActions(written ?? (await portal.getTicket(id)));
  }

  return {
    async list(input: ListInput): Promise<EnquiryList> {
      const result = await portal.listTickets(parseList(input));
      return {
        tickets: result.tickets.map((ticket) => ({
          ...ticket,
          needsReply: needsReply(ticket),
        })),
        nextCursor: result.nextCursor,
        counts: enquiryCounts(result.counts),
      };
    },

    async detail(rawId: string): Promise<EnquiryDetail> {
      return withActions(await portal.getTicket(ticketId(rawId)));
    },

    async reply(
      employee: SessionEmployee,
      rawId: string,
      rawBody: unknown,
      rawKey: string | undefined,
    ): Promise<EnquiryDetail> {
      const id = ticketId(rawId);
      const body = record(rawBody);
      const text = typeof body.body === 'string' ? body.body.trim() : '';
      if (text.length < 1 || text.length > MESSAGE_BODY_MAX)
        throw invalid(`Message must be 1-${MESSAGE_BODY_MAX} characters`);
      if (typeof body.internal !== 'boolean')
        throw invalid('internal must be true or false');
      const sequence = expectedSequence(body);
      const key = idempotencyKey(rawKey);
      const written = await portal.postMessage(
        id,
        {
          body: text,
          internal: body.internal,
          agent: agentFor(employee),
          expectedSequence: sequence,
        },
        key,
      );
      return refreshed(id, written);
    },

    async act(
      employee: SessionEmployee,
      rawId: string,
      rawBody: unknown,
      rawKey: string | undefined,
    ): Promise<EnquiryDetail> {
      const id = ticketId(rawId);
      const body = record(rawBody);
      const action = body.action as AgentAction;
      if (!(AGENT_ACTIONS as readonly string[]).includes(action))
        throw invalid('Unknown action');
      const input: ActionInput = { action, agent: agentFor(employee) };
      if (action === 'add_tag' || action === 'remove_tag')
        input.tag = tag(body.tag);
      // mark_read 只清未读标记，可以不带 expectedSequence
      if (action !== 'mark_read' || body.expectedSequence !== undefined)
        input.expectedSequence = expectedSequence(body);
      const key = idempotencyKey(rawKey);
      return refreshed(id, await portal.postAction(id, input, key));
    },

    async attachment(rawId: string): Promise<AttachmentFile> {
      if (!ATTACHMENT_ID.test(rawId)) throw invalid('Invalid attachment id');
      return portal.getAttachment(rawId);
    },
  };
}
