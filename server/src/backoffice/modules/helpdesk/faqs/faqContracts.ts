import type {
  FaqCategory,
  FaqEdgeKind,
  FaqNodeType,
  FaqSignal,
  HelpdeskLocale,
} from '../../../../contracts/helpdesk-qa';

/**
 * Helpdesk FAQ（Tickets v2 Figma addendum §1）：一条 FAQ 是一条中英双语记录（Figma 1379:299）。
 * 表结构见迁移 20261029090000_helpdesk_faqs；这里是服务层与接口的形状。
 */
export const FAQ_STATUSES = ['published', 'archived'] as const;
export type FaqStatus = (typeof FAQ_STATUSES)[number];

export const FAQ_LIMITS = {
  questionMax: 200,
  answerMax: 4000,
  keywordsMax: 20,
  keywordMax: 40,
  searchMax: 200,
  /** 员工端表格每页 10 行（Figma 1379:2）。 */
  pageSize: 10,
  pageSizeMax: 50,
  /** Portal 读列表的 limit 上限（§2）。 */
  publicLimitMax: 100,
  publicLimitDefault: 50,
  /** Agent 一次至多看这么多候选（v5 assist 用 10 个，v4 推荐 8 个）。 */
  candidatesMax: 10,
  /** v5 Part A：每条 FAQ 的信号标签至多这么多个（= FAQ_SIGNALS 的个数）。 */
  signalsMax: 8,
  /** v5 问题树（迁移 20261030090000）：key 的长度上限与格式（小写字母数字开头，再接字母数字 . _ -）。 */
  keyMax: 80,
  /** 学员问法（helpdesk_faq_phrasings.text）。 */
  phrasingMax: 200,
  phrasingsMax: 30,
  /** 追问 chip 的覆盖文字上限（= 问题上限）。 */
  followUpLabelMax: 200,
  /** 选项按钮（graph design §1）：≤ 24 个中文字 / 40 个英文字符（按码点算，解析后的文字）。 */
  optionLabelMaxZh: 24,
  optionLabelMaxEn: 40,
  /** choice 节点 2–4 个选项；answer 节点至多 6 条追问（展示 4 条）。 */
  optionsMin: 2,
  optionsMax: 4,
  followUpsMax: 6,
  followUpsShown: 4,
  /** 离最近的入口节点至多这么多条边。 */
  depthMax: 4,
} as const;

export const FAQ_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;

/** 问法的语言（zh-TW = 学员的繁体问法，检索时与简体同样匹配）。 */
export const PHRASING_LOCALES = ['en-GB', 'zh-CN', 'zh-TW'] as const;
export type PhrasingLocale = (typeof PHRASING_LOCALES)[number];

export const PHRASING_SOURCES = ['staff', 'flywheel', 'seed'] as const;
export type PhrasingSource = (typeof PHRASING_SOURCES)[number];

export type HelpdeskFaq = {
  id: string;
  /** v5 问题树：稳定的 slug，改文字也不变（唯一；旧行按英文问题回填）。 */
  key: string;
  /** answer = FAQ 卡片；choice = 一句提问（answerEn / answerZh）+ 2–4 个选项。 */
  type: FaqNodeType;
  /** true：可被新问题直接命中、可做 starter / 情境 chip；false：只能经边到达。 */
  entry: boolean;
  category: FaqCategory;
  popular: boolean;
  questionEn: string;
  /** Markdown 子集（**粗体**、1. 有序、- 无序、[链接](https://… / mailto:)、段落）。 */
  answerEn: string;
  questionZh: string;
  answerZh: string;
  keywords: string[];
  /** v5 Part A：这条 FAQ 适合哪些学员情境（FAQ_SIGNALS，按 chip 优先级排好、去重）；迁移 20261030080000。 */
  signals: FaqSignal[];
  status: FaqStatus;
  version: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FaqRevisionAction = 'create' | 'update' | 'archive';

export type FaqRevision = {
  id: string;
  faqId: string;
  version: number;
  action: FaqRevisionAction;
  employeeId: string | null;
  at: string;
  snapshot: Record<string, unknown>;
};

/** 员工端列表一页。 */
export type FaqPage = {
  faqs: HelpdeskFaq[];
  total: number;
  page: number;
  pageSize: number;
};

/** Portal 读到的公开形状：按语言挑好字段，只含已发布的（§2）。 */
export type PublicFaq = {
  id: string;
  category: FaqCategory;
  popular: boolean;
  question: string;
  answer: string;
  /** v5 Part A（契约 fixture v6，增量）：旧的 Portal 不读。 */
  signals: FaqSignal[];
  updatedAt: string;
};

export type PublishedFaqs = {
  faqs: PublicFaq[];
  etag: string;
};

/** 该语言的问题 / 答案。 */
export function localised(
  faq: Pick<HelpdeskFaq, 'questionEn' | 'answerEn' | 'questionZh' | 'answerZh'>,
  locale: HelpdeskLocale,
): { question: string; answer: string } {
  return locale === 'zh-CN'
    ? { question: faq.questionZh, answer: faq.answerZh }
    : { question: faq.questionEn, answer: faq.answerEn };
}

/** 问题树的一条边（helpdesk_faq_edges）：parent → child，follow_up 追问 / option 选项。 */
export type FaqEdgeRow = {
  id: string;
  parentId: string;
  childId: string;
  kind: FaqEdgeKind;
  position: number;
  /** chip / 按钮文字的覆盖；null = 用子节点的问题。 */
  labelEn: string | null;
  labelZh: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FaqEdgeRevisionAction = 'create' | 'update' | 'delete';

export type FaqEdgeRevision = {
  id: string;
  edgeId: string;
  parentId: string;
  childId: string;
  action: FaqEdgeRevisionAction;
  before: FaqEdgeRow | null;
  after: FaqEdgeRow | null;
  employeeId: string | null;
  at: string;
};

/** 学员的一种问法（helpdesk_faq_phrasings）：只用于检索，不改答案。 */
export type FaqPhrasing = {
  id: string;
  faqId: string;
  locale: PhrasingLocale;
  text: string;
  source: PhrasingSource;
  createdBy: string | null;
  createdAt: string;
};

/** 写操作的执行人：员工（SessionEmployee 满足）或种子脚本（null）。 */
export type FaqActor = {
  employeeId: string | null;
  /** 员工的显示名（登录会话带的；FAQ 候选的历史里显示是谁）。 */
  displayName?: string | null;
};
