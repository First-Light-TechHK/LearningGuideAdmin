import { randomUUID } from 'node:crypto';

import type { SessionEmployee } from '../../contracts/employee';
import {
  AGENT_ACTIONS,
  HELPDESK_TABS,
  MESSAGE_BODY_MAX,
  type Agent,
  type AgentAction,
  type AttachmentFile,
  type AvailableActions,
  type BoardResult,
  type BoardTicketDetail,
  type HelpdeskTab,
  type TicketDetail,
  type TicketStatus,
  type TicketSummary,
} from './contracts';
import {
  createPortalHelpdeskClient,
  HelpdeskError,
  type PortalHelpdeskClient,
} from './portalHelpdeskClient';

/**
 * HelpDesk 看板与工单操作（设计文档 §4A）。状态机只在 Portal 执行；
 * 这里负责：Tab → Portal 状态过滤、待回复判定、可用操作提示、输入校验、
 * 以及把当前登录员工注入为 agent（请求体里的 agent 一律忽略）。
 */

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const MAX_QUERY = 200;
const MAX_CURSOR = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTACHMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Idempotency-Key：可见 ASCII，最长 255。 */
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

export const TAB_STATUSES: Record<HelpdeskTab, TicketStatus[] | null> = {
  needsReply: ['OPEN', 'ASSIGNED'],
  waitingUser: ['WAITING_USER'],
  awaitingConfirm: ['PENDING_CONFIRM'],
  closed: ['CLOSED', 'CANCELLED'],
  all: null,
};

/** 待回复 = 新工单（OPEN），或已受理且最后一条消息来自学员。 */
export function needsReply(
  ticket: Pick<TicketSummary, 'status' | 'lastMessageBy'>,
): boolean {
  if (ticket.status === 'OPEN') return true;
  return ticket.status === 'ASSIGNED' && ticket.lastMessageBy === 'learner';
}

function count(counts: Record<string, number>, key: string): number {
  const value = counts[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/** Tab 数量：Portal 按状态计数；若 Portal 直接给出 needsReply 则以它为准。 */
export function tabCounts(
  counts: Record<string, number>,
): Record<HelpdeskTab, number> {
  const open = count(counts, 'OPEN');
  const assigned = count(counts, 'ASSIGNED');
  const waitingUser = count(counts, 'WAITING_USER');
  const awaitingConfirm = count(counts, 'PENDING_CONFIRM');
  const closed = count(counts, 'CLOSED') + count(counts, 'CANCELLED');
  const portalNeedsReply =
    counts.needsReply !== undefined ? counts.needsReply : counts.needs_reply;
  return {
    needsReply:
      portalNeedsReply !== undefined
        ? count({ n: portalNeedsReply }, 'n')
        : open + assigned,
    waitingUser,
    awaitingConfirm,
    closed,
    all: open + assigned + waitingUser + awaitingConfirm + closed,
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
  if (!UUID.test(raw)) throw invalid('Invalid ticket id');
  return raw;
}

function idempotencyKey(raw: string | undefined): string {
  if (raw === undefined || raw === '') return randomUUID();
  if (!IDEMPOTENCY_KEY.test(raw)) throw invalid('Invalid Idempotency-Key');
  return raw;
}

function expectedSequence(body: Record<string, unknown>): number {
  const value = body.expectedSequence;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    throw invalid('expectedSequence must be a non-negative integer');
  return value;
}

export type ListInput = {
  tab?: string;
  q?: string;
  cursor?: string;
  limit?: string;
};

function parseList(input: ListInput) {
  const tab = (input.tab ?? 'all') as HelpdeskTab;
  if (!(HELPDESK_TABS as readonly string[]).includes(tab))
    throw invalid('Unknown tab');
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
  return { tab, q, cursor, limit };
}

function withBoard(detail: TicketDetail): BoardTicketDetail {
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
  ): Promise<BoardTicketDetail> {
    return withBoard(written ?? (await portal.getTicket(id)));
  }

  return {
    async list(input: ListInput): Promise<BoardResult> {
      const { tab, q, cursor, limit } = parseList(input);
      const result = await portal.listTickets({
        statuses: TAB_STATUSES[tab] ?? undefined,
        q: q === '' ? undefined : q,
        cursor: cursor === '' ? undefined : cursor,
        limit,
      });
      const tickets = result.tickets
        .map((ticket) => ({ ...ticket, needsReply: needsReply(ticket) }))
        .filter((ticket) => tab !== 'needsReply' || ticket.needsReply);
      return {
        tickets,
        nextCursor: result.nextCursor,
        counts: tabCounts(result.counts),
      };
    },

    async detail(rawId: string): Promise<BoardTicketDetail> {
      return withBoard(await portal.getTicket(ticketId(rawId)));
    },

    async reply(
      employee: SessionEmployee,
      rawId: string,
      rawBody: unknown,
      rawKey: string | undefined,
    ): Promise<BoardTicketDetail> {
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
    ): Promise<BoardTicketDetail> {
      const id = ticketId(rawId);
      const body = record(rawBody);
      const action = body.action as AgentAction;
      if (!(AGENT_ACTIONS as readonly string[]).includes(action))
        throw invalid('Unknown action');
      const sequence = expectedSequence(body);
      const key = idempotencyKey(rawKey);
      const written = await portal.postAction(
        id,
        { action, agent: agentFor(employee), expectedSequence: sequence },
        key,
      );
      return refreshed(id, written);
    },

    async attachment(rawId: string): Promise<AttachmentFile> {
      if (!ATTACHMENT_ID.test(rawId)) throw invalid('Invalid attachment id');
      return portal.getAttachment(rawId);
    },
  };
}
