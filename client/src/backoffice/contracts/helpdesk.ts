/**
 * HelpDesk 工单（设计文档 §4A / §5.4）：BackOffice Server `/api/helpdesk/**` 返回的形状，
 * 与 server/src/backoffice/modules/helpdesk/contracts.ts 保持一致。
 */
export const TICKET_STATUSES = [
  "OPEN",
  "ASSIGNED",
  "WAITING_USER",
  "PENDING_CONFIRM",
  "CLOSED",
  "CANCELLED",
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const HELPDESK_TABS = ["needsReply", "waitingUser", "awaitingConfirm", "closed", "all"] as const;
export type HelpdeskTab = (typeof HELPDESK_TABS)[number];

export function isHelpdeskTab(value: string | null | undefined): value is HelpdeskTab {
  return typeof value === "string" && (HELPDESK_TABS as readonly string[]).includes(value);
}

export type AuthorKind = "learner" | "agent" | "system";

export type Agent = { id: string; name: string };

export type BoardTicket = {
  id: string;
  number: string;
  subject: string;
  category: string;
  status: TicketStatus;
  learner: { id: string; email: string; name: string };
  assignee: Agent | null;
  sequence: number;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  lastMessageBy: AuthorKind | null;
  confirmDueAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  rating: number | null;
  needsReply: boolean;
};

export type TicketAttachment = { id: string; fileName: string; contentType: string; size: number };

export type TicketMessage = {
  id: string;
  authorKind: AuthorKind;
  authorName: string;
  body: string;
  internal: boolean;
  attachments: TicketAttachment[];
  createdAt: string;
};

export type TicketEvent = {
  id: string;
  type: string;
  time: string;
  sequence: number;
  data: {
    fromState: string | null;
    toState: string | null;
    actor: { kind: string; id: string | null; name: string | null } | null;
    reason: string | null;
    messageId: string | null;
  };
};

export type AvailableActions = {
  claim: boolean;
  reply: boolean;
  internalNote: boolean;
  proposeResolution: boolean;
};

export type BoardTicketDetail = BoardTicket & {
  locale: string;
  messages: TicketMessage[];
  events: TicketEvent[];
  available: AvailableActions;
};

export type BoardResult = {
  tickets: BoardTicket[];
  nextCursor: string | null;
  counts: Record<HelpdeskTab, number>;
};

export type AgentAction = "claim" | "propose_resolution";

/** 与服务端一致：回复正文 1–5000 字。 */
export const MESSAGE_BODY_MAX = 5000;
export const CONFIRM_WINDOW_HOURS = 72;
