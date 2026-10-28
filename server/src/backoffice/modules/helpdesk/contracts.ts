import { HELPDESK_CATEGORIES } from '../../../contracts/helpdesk-qa';

/**
 * HelpDesk Tickets v1（docs/Learning_Guide_BackOffice_Agent_Development_Document.md §4A）
 * + Figma addendum §D（Enquiries 三栏、学员信息、订阅、标签、未读）。
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

/** Enquiry Type（Figma 1216:6），与 Common Questions 共用。 */
export const TICKET_CATEGORIES = HELPDESK_CATEGORIES;

export type AuthorKind = 'learner' | 'agent' | 'system';

/**
 * 员工端写操作（学员端的 cancel / confirm / reject / close / rate 不在 BackOffice）。
 * Figma「Mark as reviewed」= propose_resolution（假设，待产品确认）。
 */
export const AGENT_ACTIONS = [
  'claim',
  'propose_resolution',
  'add_tag',
  'remove_tag',
  'mark_read',
] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];

/** 标签：每个 ≤32 字符，每单 ≤10 个（上限由 Portal 判定）。 */
export const TAG_MAX_LENGTH = 32;
export const TAGS_PER_TICKET_MAX = 10;

/** 列表筛选：单个状态、needs_reply 或 all（Portal 只接受一个值）。 */
export const LIST_STATUS_FILTERS = [
  'all',
  'needs_reply',
  'OPEN',
  'ASSIGNED',
  'WAITING_USER',
  'PENDING_CONFIRM',
  'CLOSED',
  'CANCELLED',
] as const;
export type ListStatusFilter = (typeof LIST_STATUS_FILTERS)[number];

/** 与 Portal 一致的常量，只用于界面提示；窗口到期的判定在 Portal。 */
export const CONFIRM_WINDOW_HOURS = 72;
export const REOPEN_WINDOW_DAYS = 7;
export const MESSAGE_BODY_MAX = 5000;
/** Figma addendum §B：每个附件 ≤10 MB；图片内联显示，其余一律下载；绝不放行 html / svg。 */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_INLINE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;
export const ATTACHMENT_CONTENT_TYPES = [
  ...ATTACHMENT_INLINE_TYPES,
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;

export type Agent = { id: string; name: string };

export type TicketSummary = {
  id: string;
  number: string;
  subject: string;
  category: string;
  status: TicketStatus;
  locale: string;
  learner: { id: string; email: string; name: string };
  /** 学员填写的联系邮箱（默认账号邮箱）；回复邮件发到这里。 */
  contactEmail: string | null;
  /** 第一条消息的前 120 字。 */
  preview: string;
  /** 学员新建或发消息后为 true，员工打开（mark_read）后清除。 */
  unreadByAgent: boolean;
  tags: string[];
  /** Portal 直接给出的待回复标记；没给时为 null，由 BackOffice 推算。 */
  needsReply: boolean | null;
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
  /** 图片：缩略图内联显示；其它文件：下载。 */
  inline: boolean;
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

/** 右栏「Student Information」（Figma 1324:2），Portal 只读投影。 */
export type TicketStudent = {
  id: string;
  name: string;
  accountEmail: string;
  contactEmail: string | null;
  joinedAt: string | null;
  totalEnquiries: number | null;
  currentCourse: { id: string; title: string } | null;
};

/** 右栏「Current Subscription Plan」；没有订阅时整体为 null（界面显示 —）。 */
export type TicketSubscription = {
  planName: string;
  billingCycle: string;
  status: string;
  renewalDate: string | null;
};

export type TicketDetail = TicketSummary & {
  student: TicketStudent | null;
  subscription: TicketSubscription | null;
  messages: TicketMessage[];
  events: TicketEvent[];
};

export type PortalTicketList = {
  tickets: TicketSummary[];
  nextCursor: string | null;
  /** Portal 按状态给出的数量（可能另带 needsReply）。 */
  counts: Record<string, number>;
};

/** txt / csv 可能的编码：Portal 认得出 UTF-8 / UTF-16 就标出来，GBK 等旧编码不标 charset。 */
export const ATTACHMENT_CHARSETS = ['utf-8', 'utf-16le', 'utf-16be'] as const;
export type AttachmentCharset = (typeof ATTACHMENT_CHARSETS)[number];

export type AttachmentFile = {
  contentType: string;
  /** 文本附件上 Portal 标的 charset（仅 UTF-8 / UTF-16）；其它情况 null。 */
  charset: AttachmentCharset | null;
  data: Buffer;
  /** Portal Content-Disposition 里的文件名（已去掉路径）；没有则 null。 */
  fileName: string | null;
};

export type AvailableActions = {
  claim: boolean;
  reply: boolean;
  internalNote: boolean;
  /** Figma「Mark as reviewed」。 */
  proposeResolution: boolean;
  tag: boolean;
  markRead: boolean;
};

export type EnquiryCounts = Record<TicketStatus, number> & {
  needsReply: number;
  all: number;
};

export type EnquiryRow = TicketSummary & { needsReply: boolean };

export type EnquiryList = {
  tickets: EnquiryRow[];
  nextCursor: string | null;
  counts: EnquiryCounts;
};

export type EnquiryDetail = TicketDetail & {
  needsReply: boolean;
  available: AvailableActions;
};
