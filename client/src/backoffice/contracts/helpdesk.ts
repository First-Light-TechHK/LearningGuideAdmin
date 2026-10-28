/**
 * HelpDesk（设计文档 §4A / §5.4，Figma 1324:2）：BackOffice Server `/api/helpdesk/**` 返回的形状，
 * 与 server/src/backoffice/modules/helpdesk/contracts.ts、questions/questionContracts.ts 保持一致。
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

/** Enquiry Type（Figma 1216:6），工单与 Common Questions 共用。 */
export const HELPDESK_CATEGORIES = [
  "technical_support",
  "course_content",
  "payments_subscriptions",
  "other",
] as const;
export type HelpdeskCategory = (typeof HELPDESK_CATEGORIES)[number];

export const HELPDESK_LOCALES = ["en-GB", "zh-CN"] as const;
export type HelpdeskLocale = (typeof HELPDESK_LOCALES)[number];

/** 列表筛选：Portal 只接受一个状态值，或 needs_reply / all。 */
export const LIST_STATUS_FILTERS = ["all", "needs_reply", ...TICKET_STATUSES] as const;
export type ListStatusFilter = (typeof LIST_STATUS_FILTERS)[number];

export type AuthorKind = "learner" | "agent" | "system";

export type Agent = { id: string; name: string };

export type EnquiryRow = {
  id: string;
  number: string;
  subject: string;
  category: string;
  status: TicketStatus;
  locale: string;
  learner: { id: string; email: string; name: string };
  contactEmail: string | null;
  /** 第一条消息的前 120 字。 */
  preview: string;
  unreadByAgent: boolean;
  tags: string[];
  needsReply: boolean;
  assignee: Agent | null;
  sequence: number;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  lastMessageBy: AuthorKind | null;
  confirmDueAt?: string | null;
  closedAt?: string | null;
  closeReason?: string | null;
  rating?: number | null;
};

export type TicketAttachment = {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
  /** 图片内联；其它文件下载。 */
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

export type TicketStudent = {
  id: string;
  name: string;
  accountEmail: string;
  contactEmail: string | null;
  joinedAt: string | null;
  totalEnquiries: number | null;
  currentCourse: { id: string; title: string } | null;
};

export type TicketSubscription = {
  planName: string;
  billingCycle: string;
  status: string;
  renewalDate: string | null;
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

export type EnquiryDetail = EnquiryRow & {
  student: TicketStudent | null;
  subscription: TicketSubscription | null;
  messages: TicketMessage[];
  events: TicketEvent[];
  available: AvailableActions;
};

export type EnquiryCounts = Record<TicketStatus, number> & { needsReply: number; all: number };

export type EnquiryList = {
  tickets: EnquiryRow[];
  nextCursor: string | null;
  counts: EnquiryCounts;
};

export type AgentActionInput =
  | { action: "claim" | "propose_resolution"; expectedSequence: number }
  | { action: "add_tag" | "remove_tag"; tag: string; expectedSequence: number }
  | { action: "mark_read"; expectedSequence?: number };

/** 与服务端一致的常量。 */
export const MESSAGE_BODY_MAX = 5000;
export const CONFIRM_WINDOW_HOURS = 72;
export const TAG_MAX_LENGTH = 32;
export const TAGS_PER_TICKET_MAX = 10;
export const SEARCH_MAX = 120;
export const PAGE_SIZE = 30;

/* ------------------------------ Common Questions ------------------------------ */

export const QUESTION_STATUSES = ["draft", "published", "archived"] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export type QuestionStats = { shown: number; solved: number; declined: number };

export type HelpdeskQuestion = {
  id: string;
  locale: HelpdeskLocale;
  category: HelpdeskCategory;
  question: string;
  answer: string;
  keywords: string[];
  status: QuestionStatus;
  featured: boolean;
  sortOrder: number;
  version: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  stats: QuestionStats;
};

export type QuestionFields = {
  locale: HelpdeskLocale;
  category: HelpdeskCategory;
  question: string;
  answer: string;
  keywords: string[];
  featured: boolean;
};

export type QuestionCreateBody = QuestionFields & { publish: boolean };
export type QuestionUpdateBody = QuestionFields & { version: number };
export type QuestionTransition = "publish" | "unpublish" | "archive";
