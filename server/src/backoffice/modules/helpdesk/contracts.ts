/**
 * HelpDesk Tickets v1（docs/Learning_Guide_BackOffice_Agent_Development_Document.md §4A）。
 * 工单归 Portal（唯一写入方）；这里只是 BackOffice 读到的形状，字段名与 Portal 集成接口
 * 的差异统一在 portalHelpdeskClient.ts 里归一化。
 */
export const TICKET_STATUSES = [
  'OPEN',
  'ASSIGNED',
  'WAITING_USER',
  'PENDING_CONFIRM',
  'CLOSED',
  'CANCELLED',
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_CATEGORIES = [
  'account',
  'billing',
  'learning',
  'study_group',
  'other',
] as const;

export type AuthorKind = 'learner' | 'agent' | 'system';

/** 员工端写操作（学员端的 cancel / confirm / reject / close / rate 不在 BackOffice）。 */
export const AGENT_ACTIONS = ['claim', 'propose_resolution'] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];

/** 与 Portal 一致的常量，只用于界面提示；窗口到期的判定在 Portal。 */
export const CONFIRM_WINDOW_HOURS = 72;
export const REOPEN_WINDOW_DAYS = 7;
export const MESSAGE_BODY_MAX = 5000;
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const ATTACHMENT_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

export type Agent = { id: string; name: string };

export type TicketSummary = {
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
};

export type TicketAttachment = {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
};

export type TicketMessage = {
  id: string;
  authorKind: AuthorKind;
  authorName: string;
  body: string;
  internal: boolean;
  attachments: TicketAttachment[];
  createdAt: string;
};

/** CloudEvents 1.0 事件；type 去掉 com.ilovelearningguide.helpdesk.ticket. 前缀。 */
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

export type TicketDetail = TicketSummary & {
  locale: string;
  messages: TicketMessage[];
  events: TicketEvent[];
};

export type PortalTicketList = {
  tickets: TicketSummary[];
  nextCursor: string | null;
  /** Portal 按状态给出的数量（可能另带 needsReply）。 */
  counts: Record<string, number>;
};

export type AttachmentFile = { contentType: string; data: Buffer };

/** 看板 Tab（§4A.3）。 */
export const HELPDESK_TABS = [
  'needsReply',
  'waitingUser',
  'awaitingConfirm',
  'closed',
  'all',
] as const;
export type HelpdeskTab = (typeof HELPDESK_TABS)[number];

export type AvailableActions = {
  claim: boolean;
  reply: boolean;
  internalNote: boolean;
  proposeResolution: boolean;
};

export type BoardTicket = TicketSummary & { needsReply: boolean };

export type BoardResult = {
  tickets: BoardTicket[];
  nextCursor: string | null;
  counts: Record<HelpdeskTab, number>;
};

export type BoardTicketDetail = TicketDetail & {
  needsReply: boolean;
  available: AvailableActions;
};
