/**
 * HelpDesk（设计文档 §4A / §5.4，Figma 1324:2 / 1379:2 / 1379:299；Tickets v2）：BackOffice Server
 * `/api/helpdesk/**` 返回的形状，与 server/src/backoffice/modules/helpdesk/contracts.ts、
 * faqs/faqContracts.ts 保持一致。
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

/** 工单的 Enquiry Type（Figma 1216:6）。 */
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

export type AvailableActions = {
  claim: boolean;
  reply: boolean;
  internalNote: boolean;
  /** Figma「Mark as reviewed」。 */
  proposeResolution: boolean;
  tag: boolean;
  markRead: boolean;
  /** Figma「Flag follow-up」（v2：任何状态都可用）。 */
  flag: boolean;
};

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
  /** v2：员工标了「Flag follow-up」。 */
  flagged: boolean;
  /** 每一行都带可用操作：学员时间线上的每张卡片都有操作栏。 */
  available: AvailableActions;
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

/** AI 助手回答的学员反馈（v2 §4a）；没有反馈为 null。 */
export const ASSIST_FEEDBACK = ["helpful", "not_helpful", "solved", "declined", "edited"] as const;
export type AssistFeedback = (typeof ASSIST_FEEDBACK)[number];

/** 工单关联的 AI 助手回答（v2 §4a aiAssist，旧的在前）；answer 是当时展示给学员的原文。 */
export type TicketAiAssist = {
  id: string;
  source: string;
  question: string;
  faqId: string | null;
  faqQuestion: string | null;
  answer: string | null;
  feedback: AssistFeedback | null;
  createdAt: string;
};

/**
 * 「查看链路」：GET /api/helpdesk/agent-runs/:runId（helpdesk-agent-v2-pi-dsh §2）。
 * 一次 AI 推荐 = 一个 run（id 就是 AI 块的 id）；事件是 dsh SessionEvent 的导出副本，学员原文已脱敏。
 */
export type AgentRunEvent = {
  runId: string;
  seq: number;
  type: string;
  time: string;
  data: Record<string, unknown>;
};

export type AgentRun = {
  runId: string;
  /** 同一段对话的第一个 run；自己就是第一个时为 null。 */
  parentRunId: string | null;
  chain: string[];
  events: AgentRunEvent[];
};

export type EnquiryDetail = EnquiryRow & {
  student: TicketStudent | null;
  subscription: TicketSubscription | null;
  messages: TicketMessage[];
  events: TicketEvent[];
  aiAssist: TicketAiAssist[];
};

export type EnquiryCounts = Record<TicketStatus, number> & { needsReply: number; all: number };

export type EnquiryList = {
  tickets: EnquiryRow[];
  nextCursor: string | null;
  counts: EnquiryCounts;
};

export type AgentActionInput =
  | { action: "claim" | "propose_resolution" | "flag" | "unflag"; expectedSequence: number }
  | { action: "add_tag" | "remove_tag"; tag: string; expectedSequence: number }
  | { action: "mark_read"; expectedSequence?: number };

/** 与服务端一致的常量。 */
export const MESSAGE_BODY_MAX = 5000;
export const CONFIRM_WINDOW_HOURS = 72;
export const TAG_MAX_LENGTH = 32;
export const TAGS_PER_TICKET_MAX = 10;
export const SEARCH_MAX = 120;
export const PAGE_SIZE = 30;

/** 学员时间线：选中工单的学员最多 10 条工单（新的在前）。 */
export const TIMELINE_LIMIT = 10;

/* ----------------------------------- FAQs ----------------------------------- */

/** FAQ 分类（Figma 1379:2 / 1387:2；v2 §1）。 */
export const FAQ_CATEGORIES = ["account_technical", "courses_learning", "payments_subscriptions", "other"] as const;
export type FaqCategory = (typeof FAQ_CATEGORIES)[number];

/** 一条中英双语 FAQ（保存即发布；删除 = 归档，列表里看不到）。 */
export type HelpdeskFaq = {
  id: string;
  category: FaqCategory;
  popular: boolean;
  questionEn: string;
  answerEn: string;
  questionZh: string;
  answerZh: string;
  keywords: string[];
  status: "published" | "archived";
  version: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FaqPage = { faqs: HelpdeskFaq[]; total: number; page: number; pageSize: number };

export type FaqBody = {
  category: FaqCategory;
  popular: boolean;
  questionEn: string;
  answerEn: string;
  questionZh: string;
  answerZh: string;
  keywords: string[];
};
