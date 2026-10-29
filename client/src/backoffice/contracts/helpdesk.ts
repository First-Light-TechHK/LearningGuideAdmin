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
  /** 学员关闭后给工单的评分 1–5；没评为 null。BackOffice 卡片显示「评分 n/5 / 未评分」（v3 §2）。 */
  rating?: number | null;
  /** v2：员工标了「Flag follow-up」。 */
  flagged: boolean;
  /** v4 Part A：学员从付款记录发起咨询时关联的订单号；没有订单为 null（旧服务端没有这个字段）。 */
  orderId?: string | null;
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
  /** v3 §2：学员给这次 AI 回答的评分 1–5（「本次服务满意吗？」）；没评或跳过为 null（旧服务端没有这个字段）。 */
  rating?: number | null;
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

/**
 * v4 Part A：工单关联订单的只读投影（Portal 用代码从学员自己的订单记录构建，Admin Server 只保留这 8 个字段，
 * 格式不对的字段为 null）。AI 助手从不接触订单。
 */
export const ORDER_STATUSES = ["paid", "pending", "failed", "canceled", "refunded"] as const;
export const ORDER_KINDS = ["purchase", "trial_activation", "upgrade"] as const;
export const PAYMENT_MODES = ["demo", "stripe"] as const;

export type TicketOrder = {
  id: string;
  /** ORDER_STATUSES 之一；Portal 以后新增的值原样显示。 */
  status: string | null;
  /** 整数，最小货币单位（3900 = 39.00）。 */
  amount: number | null;
  /** ISO 4217，小写（"usd"）。 */
  currency: string | null;
  planName: string | null;
  kind: string | null;
  createdAt: string | null;
  paymentMode: string | null;
};

export type EnquiryDetail = EnquiryRow & {
  student: TicketStudent | null;
  subscription: TicketSubscription | null;
  /** v4 Part A：没有订单为 null；有 orderId 却为 null = Portal 这次没读到订单（旧服务端没有这个字段）。 */
  order?: TicketOrder | null;
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

/**
 * v5 Part A：FAQ 可打的学员情境信号（服务端 FAQ_SIGNALS，契约 fixture v6 的 faqSignal；顺序 = Portal 选
 * 「你可能遇到的问题」的优先级）。open_ticket_waiting 不是 FAQ，不在这里。
 */
export const FAQ_SIGNALS = [
  "payment_failed",
  "payment_pending",
  "recent_purchase",
  "trial_ending",
  "subscription_expired",
  "subscription_cancelled",
  "email_unverified",
  "from_order",
] as const;
export type FaqSignal = (typeof FAQ_SIGNALS)[number];

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
  /** v5 Part A：服务端总会给（迁移 20261030080000）；编辑器多选（待视觉验收）。 */
  signals?: FaqSignal[];
  /** v5 问题树（迁移 20261030090000；旧服务端没有 → 按 answer / 入口处理）：稳定的 slug。 */
  key?: string;
  type?: FaqNodeType;
  entry?: boolean;
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
  /** v5 Part A：不带 = 保留已存的标签（旧的编辑器只改文字不会清掉）。 */
  signals?: FaqSignal[];
  /** v5 问题树：不带 = 保留（新建缺省 answer、入口）。 */
  type?: FaqNodeType;
  entry?: boolean;
};

/* --------------------------- v5 问题树（graph design §5） --------------------------- */

/** answer = FAQ 卡片；choice = 一句提问 + 2–4 个选项（A/B/C/D）。 */
export const FAQ_NODE_TYPES = ["answer", "choice"] as const;
export type FaqNodeType = (typeof FAQ_NODE_TYPES)[number];
export const FAQ_EDGE_KINDS = ["follow_up", "option"] as const;
export type FaqEdgeKind = (typeof FAQ_EDGE_KINDS)[number];

/** 与服务端 faqContracts.ts FAQ_LIMITS 一致的图上限。 */
export const FAQ_GRAPH_LIMITS = {
  optionLabelMaxZh: 24,
  optionLabelMaxEn: 40,
  followUpLabelMax: 200,
  optionsMin: 2,
  optionsMax: 4,
  followUpsMax: 6,
  followUpsShown: 4,
  phrasingMax: 200,
  phrasingsMax: 30,
  depthMax: 4,
} as const;

/** 节点摘要（树、父子清单）。 */
export type FaqNodeSummary = {
  id: string;
  key: string;
  type: FaqNodeType;
  entry: boolean;
  category: FaqCategory;
  questionEn: string;
  questionZh: string;
  status: "published" | "archived";
};

export type FaqEdgeRow = {
  id: string;
  parentId: string;
  childId: string;
  kind: FaqEdgeKind;
  position: number;
  /** null = 用子节点的问题。 */
  labelEn: string | null;
  labelZh: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

/** GET /api/helpdesk/faqs/:id/edges 的一行：边、另一端的节点、解析好的文字。 */
export type FaqEdgeView = {
  edge: FaqEdgeRow;
  node: FaqNodeSummary | null;
  label: { en: string; zh: string };
};

export type FaqEdges = { children: FaqEdgeView[]; parents: FaqEdgeView[] };

/** 服务端 faqGraphChecks.ts GRAPH_RULES（新规则没有文案时原样显示）。 */
export const GRAPH_RULES = [
  "edge_endpoint",
  "duplicate_edge",
  "cycle",
  "depth",
  "orphan",
  "option_parent",
  "choice_follow_up",
  "choice_options",
  "choice_prompt",
  "follow_ups",
  "language",
  "label_length",
  "answer_blocks",
] as const;

export type GraphProblem = {
  rule: string;
  nodeId: string | null;
  key: string | null;
  parentId?: string;
  childId?: string;
  detail: string;
};

export type FaqGraphCheckResult = {
  passed: boolean;
  problems: GraphProblem[];
  counts: { nodes: number; entries: number; choices: number; edges: number; phrasings: number };
  maxDepth: number;
};

export type FaqTreeNode = {
  node: FaqNodeSummary;
  edge: FaqEdgeRow | null;
  label: { en: string; zh: string } | null;
  depth: number;
  parentCount: number;
  alsoAppearsIn: { id: string; key: string; questionEn: string; questionZh: string }[];
  warnings: GraphProblem[];
  cycle: boolean;
  truncated: boolean;
  children: FaqTreeNode[];
};

export type FaqTree = { root: FaqTreeNode; nodes: number };

export const PHRASING_LOCALES = ["en-GB", "zh-CN", "zh-TW"] as const;
export type PhrasingLocale = (typeof PHRASING_LOCALES)[number];

export type FaqPhrasing = {
  id: string;
  faqId: string;
  locale: PhrasingLocale;
  text: string;
  source: "staff" | "flywheel" | "seed";
  createdBy: string | null;
  createdAt: string;
};

export const FAQ_RELEASE_STATUSES = ["draft", "evaluating", "published", "rejected", "superseded"] as const;
export type FaqReleaseStatus = (typeof FAQ_RELEASE_STATUSES)[number];

export type FaqReleaseEvalReport = {
  kind: "retrieval" | "model" | "combined" | "rollback" | "skipped" | string;
  passed: boolean;
  summary: string;
  ranAt: string;
  metrics: Record<string, number>;
  misses: { nodeId: string; key: string; locale: string; source: string; text: string; rank: number | null }[];
  sourceVersion?: number;
};

export type FaqRelease = {
  id: string;
  version: number;
  status: FaqReleaseStatus;
  checks: FaqGraphCheckResult | null;
  evalReport: FaqReleaseEvalReport | null;
  /** 回滚版本：快照复制自哪个版本。 */
  sourceVersion: number | null;
  createdBy: string | null;
  createdAt: string;
  publishedBy: string | null;
  publishedAt: string | null;
  /** draft，且检查与评测都过了。 */
  publishable: boolean;
};

export type FaqReleaseList = { releases: FaqRelease[]; published: number | null };

export type FaqNodeRef = { id: string; key: string; questionEn: string; questionZh: string };

export type FaqSnapshotEdge = {
  parentId: string;
  childId: string;
  kind: FaqEdgeKind;
  position: number;
  labelEn: string | null;
  labelZh: string | null;
};

export type FaqSnapshotDiff = {
  nodes: { added: FaqNodeRef[]; removed: FaqNodeRef[]; changed: (FaqNodeRef & { fields: string[] })[] };
  edges: {
    added: FaqSnapshotEdge[];
    removed: FaqSnapshotEdge[];
    changed: { before: FaqSnapshotEdge; after: FaqSnapshotEdge; fields: string[] }[];
  };
  phrasings: { added: number; removed: number };
  same: boolean;
};

/** 「发布新版本」：工作副本的检查与它和当前上线版本的差异。 */
export type FaqWorkingCopy = { checks: FaqGraphCheckResult; diff: FaqSnapshotDiff; published: number | null };

export type FaqReleaseDiff = { base: number | null; head: number | "working"; diff: FaqSnapshotDiff };

/** 对话预览：与 Portal 读 faq-release/current 同一个投影（契约 FaqNode / FaqEdge）。 */
export type FaqBlock = { id: string; text: string };

export type FaqGraphNode = {
  id: string;
  key: string;
  type: FaqNodeType;
  entry: boolean;
  category: FaqCategory;
  popular: boolean;
  question: string;
  answer: string;
  blocks: FaqBlock[];
  signals: FaqSignal[];
};

export type FaqGraphEdge = { parentId: string; childId: string; kind: FaqEdgeKind; position: number; label: string };

export type FaqGraphPreview = {
  source: "working" | number;
  published: number | null;
  locale: HelpdeskLocale;
  nodes: FaqGraphNode[];
  edges: FaqGraphEdge[];
};
