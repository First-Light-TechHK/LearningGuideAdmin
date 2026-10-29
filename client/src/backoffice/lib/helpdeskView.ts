import {
  HELPDESK_CATEGORIES,
  LIST_STATUS_FILTERS,
  PAGE_SIZE,
  SEARCH_MAX,
  TAGS_PER_TICKET_MAX,
  TAG_MAX_LENGTH,
  TIMELINE_LIMIT,
  type AgentActionInput,
  type AssistFeedback,
  type AvailableActions,
  type HelpdeskCategory,
  type ListStatusFilter,
  type TicketMessage,
  type TicketStatus,
} from '../contracts/helpdesk'
import type { Locale } from './i18n/config'

/**
 * HelpDesk Enquiries（Figma 1324:2）的纯逻辑：颜色、首字母、时间、筛选参数、可见操作。
 * 不依赖 React，单测在 client/tests/helpdesk-view.test.ts。
 */

export type Swatch = { bg: string; fg: string }

/** Figma 1324:2 列表头像的 8 组底色 / 字色（按顺序）。 */
export const AVATAR_PALETTE: readonly Swatch[] = [
  { bg: '#dbeafe', fg: '#146eff' },
  { bg: '#dcfce7', fg: '#16a34a' },
  { bg: '#fef3c7', fg: '#d97706' },
  { bg: '#f3e8ff', fg: '#9333ea' },
  { bg: '#fee2e2', fg: '#dc2626' },
  { bg: '#e0f2fe', fg: '#0284c7' },
  { bg: '#fff7ed', fg: '#ea580c' },
  { bg: '#f0fdf4', fg: '#16a34a' },
]

/** 标签色：只用 Figma 1324:2 里出现的三组（login issue / account access / payment）。 */
export const TAG_PALETTE: readonly Swatch[] = [
  { bg: '#eff6ff', fg: '#146eff' },
  { bg: '#fff7ed', fg: '#ea580c' },
  { bg: '#f0fdf4', fg: '#16a34a' },
]

/** 学员时间线卡片外的头像（Figma 1324:2 v2：每张卡片都是同一个学员，颜色固定）。 */
export const TIMELINE_AVATAR: Swatch = { bg: '#ddebff', fg: '#1d63d6' }

/**
 * 卡片上的 Enquiry Type 标签（Figma 1324:2 v2）：画板里只有 Technical Support 与 Payments & Subscriptions；
 * Course Content 用同一组蓝色、Other（及 Portal 新增的类型）用 FAQ 表格的灰色胶囊（待视觉验收）。
 */
const ENQUIRY_TYPE_SWATCH: Record<HelpdeskCategory, Swatch> = {
  technical_support: { bg: '#ebf3ff', fg: '#2469d6' },
  course_content: { bg: '#ebf3ff', fg: '#2469d6' },
  payments_subscriptions: { bg: '#efe9ff', fg: '#7756c7' },
  other: { bg: '#f2f5f9', fg: '#69778b' },
}

export function enquiryTypeColor(category: string): Swatch {
  return (ENQUIRY_TYPE_SWATCH as Record<string, Swatch>)[category] ?? ENQUIRY_TYPE_SWATCH.other
}

/** FNV-1a 32 位：同一输入永远同一结果，用来挑颜色。 */
function hash(text: string): number {
  let value = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i)
    value = Math.imul(value, 0x01000193) >>> 0
  }
  return value
}

export function avatarColor(seed: string): Swatch {
  return AVATAR_PALETTE[hash(seed) % AVATAR_PALETTE.length]
}

export function tagColor(tag: string): Swatch {
  return TAG_PALETTE[hash(tag.trim().toLowerCase()) % TAG_PALETTE.length]
}

const CJK = /[぀-ヿ㐀-鿿가-힯]/

/** 「Emily Carter」→ EC；单词取首字母；中文名取第一个字；没有名字用邮箱首字母。 */
export function initials(name: string, email = ''): string {
  const trimmed = name.trim()
  if (trimmed) {
    if (CJK.test(trimmed[0])) return trimmed[0]
    const words = trimmed.split(/\s+/)
    const letters = words.length === 1 ? [words[0]] : [words[0], words[words.length - 1]]
    return letters.map((word) => Array.from(word)[0].toUpperCase()).join('')
  }
  const first = email.trim()[0]
  return first ? first.toUpperCase() : '?'
}

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** 列表时间：今天「14:32」，今年「16 May」/「5月16日」，往年带年份。 */
export function listTime(iso: string | null | undefined, locale: Locale, now = new Date()): string {
  const date = parse(iso)
  if (!date) return ''
  if (sameDay(date, now)) {
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
  }
  const options: Intl.DateTimeFormatOptions =
    date.getFullYear() === now.getFullYear()
      ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' }
  return new Intl.DateTimeFormat(locale, options).format(date)
}

/** 「15 Jan 2024」/「2024年1月15日」；没有日期返回 —。 */
export function longDate(iso: string | null | undefined, locale: Locale): string {
  const date = parse(iso)
  if (!date) return '—'
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(date)
}

export type DayLabel = { kind: 'today' } | { kind: 'yesterday' } | { kind: 'date'; text: string }

/** 对话区日期分隔条。 */
export function dayLabel(iso: string | null | undefined, locale: Locale, now = new Date()): DayLabel | null {
  const date = parse(iso)
  if (!date) return null
  if (sameDay(date, now)) return { kind: 'today' }
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(date, yesterday)) return { kind: 'yesterday' }
  return { kind: 'date', text: longDate(iso, locale) }
}

/** 附件大小「245 KB」。 */
export function fileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  const mb = bytes / (1024 * 1024)
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`
}

/* ------------------------------------ 列表 ------------------------------------ */

/** 滚动加载：追加新行，重复的行原位替换（同一工单在两页之间变动时不重复出现）。 */
export function mergeTickets<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const byId = new Map(incoming.map((row) => [row.id, row]))
  const merged = current.map((row) => byId.get(row.id) ?? row)
  const seen = new Set(current.map((row) => row.id))
  for (const row of incoming) {
    if (!seen.has(row.id)) {
      merged.push(row)
      seen.add(row.id)
    }
  }
  return merged
}

const ROW_FIELDS = [
  'subject',
  'category',
  'status',
  'tags',
  'unreadByAgent',
  'needsReply',
  'assignee',
  'sequence',
  'updatedAt',
  'lastMessageAt',
  'lastMessageBy',
  'contactEmail',
  'flagged',
  'available',
] as const

/** 写操作成功后，把详情里的最新摘要字段同步回左栏那一行（其它行原样返回）。 */
export function applyDetailToRow<T extends { id: string }>(rows: T[], detail: { id: string } & Record<string, unknown>): T[] {
  return rows.map((row) => {
    if (row.id !== detail.id) return row
    const next: Record<string, unknown> = { ...row }
    for (const field of ROW_FIELDS) if (field in detail) next[field] = detail[field]
    return next as T
  })
}

/** 打开工单时是否调 mark_read：只有 FULL、确有未读、Server 允许时。VIEW 打开不清未读。 */
export function shouldMarkRead(
  ticket: { unreadByAgent: boolean; available: Pick<AvailableActions, 'markRead'> },
  canWrite: boolean,
): boolean {
  return canWrite && ticket.unreadByAgent && ticket.available.markRead
}

/** mark_read 带上员工看到的 sequence：之后学员又发来的消息仍保持未读（Portal 只在 sequence 未变时清除）。 */
export function markReadInput(ticket: { sequence: number }): AgentActionInput {
  return { action: 'mark_read', expectedSequence: ticket.sequence }
}

/** Claim（接单）：以页面上的 sequence 为准，工单已变则 409 stale 重新加载。 */
export function claimInput(ticket: { sequence: number }): AgentActionInput {
  return { action: 'claim', expectedSequence: ticket.sequence }
}

export type EnquiryControls = {
  /** 卡片操作栏（Figma 1324:2 的 4 个按钮）：VIEW 整个不显示。 */
  actionBar: boolean
  /** 接单（spec §7 Claim）：只在 OPEN 时可用；接单后才出现 Mark as reviewed（状态表）。 */
  claim: boolean
  /** Figma「Mark as reviewed」= propose_resolution。 */
  markReviewed: boolean
  composer: boolean
  reply: boolean
  internalNote: boolean
  editTags: boolean
  /** Flag follow-up（flag / unflag）。 */
  flag: boolean
}

/** 写操作控件：VIEW 一律不显示；FULL 按 Server 给的 available。 */
export function enquiryControls(ticket: { available: AvailableActions }, canWrite: boolean): EnquiryControls {
  const a = ticket.available
  const reply = canWrite && a.reply
  const internalNote = canWrite && a.internalNote
  return {
    actionBar: canWrite,
    claim: canWrite && a.claim,
    markReviewed: canWrite && a.proposeResolution,
    composer: reply || internalNote,
    reply,
    internalNote,
    editTags: canWrite && a.tag,
    flag: canWrite && a.flag === true,
  }
}

/** Flag follow-up 是开关：没标记就 flag，已标记就 unflag；带员工看到的 sequence。 */
export function flagInput(ticket: { flagged: boolean; sequence: number }): AgentActionInput {
  return { action: ticket.flagged ? 'unflag' : 'flag', expectedSequence: ticket.sequence }
}

/* ---------------------------------- 学员时间线 ---------------------------------- */

type TimelineCard = { id: string; learner: { id: string }; createdAt: string }

/**
 * 中栏（Figma 1324:2，v2 §3d）：选中的工单 + 同一学员的其它工单（最多 10 条，新的在前）。
 * 别的学员的工单一律不显示；选中的那条即使比最新 10 条还旧也一定在。
 */
export function timelineCards<T extends TimelineCard>(selected: T, rows: T[]): T[] {
  const learner = selected.learner.id
  const others = rows.filter((row) => row.id !== selected.id && row.learner.id === learner)
  const newest = (a: T, b: T) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
  const cards = [...others, selected].sort(newest).slice(0, TIMELINE_LIMIT)
  return cards.includes(selected) ? cards : [...cards, selected]
}

/** 日期分隔条「28 Oct 2026」/「2026年10月28日」，同一天的卡片放在一组。 */
export function groupByDay<T extends { createdAt: string }>(cards: T[], locale: Locale): { label: string; cards: T[] }[] {
  const groups: { label: string; cards: T[] }[] = []
  for (const card of cards) {
    const label = longDate(card.createdAt, locale)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.cards.push(card)
    else groups.push({ label, cards: [card] })
  }
  return groups
}

/** 卡片上「contact email · 14:32」的时间（日期已在分隔条上）。 */
export function cardTime(iso: string | null | undefined, locale: Locale): string {
  const date = parse(iso)
  if (!date) return ''
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
}

/** 内部备注只在「Internal notes」面板里；其余（回复、系统行）是卡片下的对话。 */
export function splitNotes(messages: TicketMessage[]): { notes: TicketMessage[]; conversation: TicketMessage[] } {
  return {
    notes: messages.filter((m) => m.internal),
    conversation: messages.filter((m) => !m.internal),
  }
}

/**
 * AI 块的学员反馈行（v2 §3d）：helpful（以及提交时的 solved）绿色「Yes, this solved my issue」；
 * not_helpful 与提交时的 declined 红色「No, I still submit to support team」；没有反馈（或 edited）不显示。
 */
export function assistFeedbackTone(feedback: AssistFeedback | null): 'positive' | 'negative' | null {
  if (feedback === 'helpful' || feedback === 'solved') return 'positive'
  if (feedback === 'not_helpful' || feedback === 'declined') return 'negative'
  return null
}

/** v3 §2：学员评分只认 1–5 的整数，其它（没评、跳过、旧数据、越界）都当没有评分。 */
export function ratingValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5 ? value : null
}

/**
 * v3 §2：工单卡片上的「评分 n/5 / 未评分」何时出现。与 Portal EnquiryDetail 的评分区一致：
 * 关闭后学员才能评，所以已关闭的显示（没评就是「未评分」）；评过之后重新打开的仍显示评分。
 * 未关闭且没评分的不显示，免得每张进行中的卡片都挂一个「未评分」。
 */
export function showTicketRating(ticket: { status: TicketStatus; rating?: number | null }): boolean {
  return ticket.status === 'CLOSED' || ratingValue(ticket.rating) !== null
}

/** 中栏：第一条公开的学员消息是 Enquiry 卡片，其余按原顺序排在下面。 */
export function splitThread(messages: TicketMessage[]): { enquiry: TicketMessage | null; rest: TicketMessage[] } {
  const index = messages.findIndex((m) => m.authorKind === 'learner' && !m.internal)
  if (index < 0) return { enquiry: null, rest: messages }
  return { enquiry: messages[index], rest: messages.filter((_, i) => i !== index) }
}

/* ------------------------------------ 标签 ------------------------------------ */

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/** 去首尾空白、合并中间空白；空、超过 32 字或含控制字符返回 null（与 Server 一致）。 */
export function normalizeTag(raw: string): string | null {
  if (CONTROL.test(raw)) return null
  const tag = raw.trim().replace(/\s+/g, ' ')
  if (tag === '' || tag.length > TAG_MAX_LENGTH) return null
  return tag
}

export function tagAddError(tags: string[], raw: string): 'invalid' | 'duplicate' | 'limit' | null {
  const tag = normalizeTag(raw)
  if (!tag) return 'invalid'
  if (tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) return 'duplicate'
  if (tags.length >= TAGS_PER_TICKET_MAX) return 'limit'
  return null
}

/* ------------------------------------ 筛选 ------------------------------------ */

export type EnquiryFilters = {
  q: string
  status: ListStatusFilter
  category: HelpdeskCategory | 'all'
  tag: string
  /** v2：只看标了 Flag follow-up 的（地址栏 flagged=true）。 */
  flagged: boolean
}

export const DEFAULT_ENQUIRY_FILTERS: EnquiryFilters = { q: '', status: 'all', category: 'all', tag: '', flagged: false }

function isStatusFilter(value: string | null): value is ListStatusFilter {
  return value !== null && (LIST_STATUS_FILTERS as readonly string[]).includes(value)
}

function isCategory(value: string | null): value is HelpdeskCategory {
  return value !== null && (HELPDESK_CATEGORIES as readonly string[]).includes(value)
}

/** 地址栏 → 筛选；未知值回到缺省，旧书签不会报错。 */
export function readEnquiryFilters(params: URLSearchParams): EnquiryFilters {
  const status = params.get('status')
  const category = params.get('category')
  return {
    q: (params.get('q') ?? '').trim().slice(0, SEARCH_MAX),
    status: isStatusFilter(status) ? status : 'all',
    category: isCategory(category) ? category : 'all',
    tag: normalizeTag(params.get('tag') ?? '') ?? '',
    flagged: params.get('flagged') === 'true',
  }
}

/**
 * 筛选 → 地址栏：缺省值不写，其它参数保留。'all' 只是状态 / 类型的缺省值；
 * 搜索词或标签写 all 是真的要搜 all，只有空才不写。
 */
export function writeEnquiryFilters(params: URLSearchParams, patch: Partial<EnquiryFilters>): URLSearchParams {
  const next = new URLSearchParams(params)
  for (const [key, value] of Object.entries(patch) as [keyof EnquiryFilters, unknown][]) {
    const text = String(value ?? '').trim()
    if (text === '' || text === String(DEFAULT_ENQUIRY_FILTERS[key])) next.delete(key)
    else next.set(key, text)
  }
  return next
}

/**
 * 搜索框跟着地址栏走（返回、侧栏回到 /help-desk 时清掉旧词）；员工正在输入（防抖未到）
 * 或框里只是同一个词多了空白时，保留框里的原样。
 */
export function resyncQuery(input: string, urlQ: string, typing: boolean, max = SEARCH_MAX): string {
  if (typing) return input
  return input.trim().slice(0, max) === urlQ ? input : urlQ
}

/** 输入法正在组字（中文 / 日文选词）时的 Enter 属于输入法，不能当作提交。 */
export function isImeComposing(event: { keyCode: number; nativeEvent: { isComposing?: boolean } }): boolean {
  return event.nativeEvent.isComposing === true || event.keyCode === 229
}

/* ---------------------------------- 写操作结果 ---------------------------------- */

export type SettlePlan = {
  /** 写操作是否在当前打开的这条咨询上生效（调用方据此提示 / 清空草稿）。 */
  ok: boolean
  /** 左栏要同步的最新摘要（发给哪条就同步哪条，不管现在打开的是哪条）。 */
  row: { id: string } | null
  /** 是否把结果放进中栏 / 右栏：只有还停在发出请求的那条咨询上时。 */
  adoptTicket: boolean
  /** 409 STALE_TICKET：重新加载这条咨询。 */
  reload: boolean
  notice: 'clear' | 'stale' | 'error' | null
}

/**
 * 写操作（回复、Claim、Mark as reviewed、标签）的响应只作用于发出请求的那条咨询：
 * 员工已切到另一条时，只更新左栏那一行，不把旧咨询换进来、不在新咨询上提示。
 */
export function settlePlan<T extends { id: string }>(
  result: { ok: true; data: T } | { ok: false; code: string; status: number },
  sentFor: string,
  current: string | null,
): SettlePlan {
  const open = sentFor === current
  if (result.ok) {
    return { ok: open, row: result.data, adoptTicket: open, reload: false, notice: open ? 'clear' : null }
  }
  if (!open) return { ok: false, row: null, adoptTicket: false, reload: false, notice: null }
  if (result.code === 'STALE_TICKET') return { ok: false, row: null, adoptTicket: false, reload: true, notice: 'stale' }
  return { ok: false, row: null, adoptTicket: false, reload: false, notice: 'error' }
}

/** 一次写操作的标记（按引用比较，结束时只清自己）。 */
export type BusyToken = { readonly label: string }
/** 每条咨询各自进行中的写操作：A 还在跑时切到 B 再切回来，A 的按钮仍是禁用的。 */
export type Busy = Readonly<Record<string, BusyToken>>
export const NO_BUSY: Busy = Object.freeze({})

export function startBusy(busy: Busy, ticketId: string, token: BusyToken): Busy {
  return { ...busy, [ticketId]: token }
}

/** 进行中的写操作只禁用它所属那条咨询的按钮。 */
export function visibleBusy(busy: Busy, ticketId: string | null): string | null {
  return ticketId !== null && Object.hasOwn(busy, ticketId) ? busy[ticketId].label : null
}

/** 请求结束时只清掉自己设的那条（别的咨询的、或之后同一条新发的写操作不受影响）。 */
export function clearBusy(busy: Busy, ticketId: string, token: BusyToken): Busy {
  if (busy[ticketId] !== token) return busy
  const rest = { ...busy }
  delete rest[ticketId]
  return rest
}

export type ComposerKey = { key: string; body: string; internal: boolean }

/**
 * 回复框的 Idempotency-Key：同一份草稿（同正文、同回复 / 内部备注）重试沿用同一个，
 * 否则换新（Portal 对同一个 key 不同内容回 IDEMPOTENCY_CONFLICT）。
 */
export function composerKey(
  previous: ComposerKey | null,
  body: string,
  internal: boolean,
  make: () => string,
): ComposerKey {
  if (previous && previous.body === body && previous.internal === internal) return previous
  return { key: make(), body, internal }
}

/** 打开即已读：要调 mark_read 时给出请求体（带员工看到的 sequence），否则 null。 */
export function markReadOnOpen(
  ticket: { sequence: number; unreadByAgent: boolean; available: Pick<AvailableActions, 'markRead'> },
  canWrite: boolean,
): AgentActionInput | null {
  return shouldMarkRead(ticket, canWrite) ? markReadInput(ticket) : null
}

/** 页头写控件：VIEW 没有「+ Add FAQ」，也不会打开 FAQ 抽屉。 */
export function helpDeskPageControls(canWrite: boolean): { addFaq: boolean; faqDrawer: boolean } {
  return { addFaq: canWrite, faqDrawer: canWrite }
}

/** BackOffice 列表接口的查询串。 */
export function enquiryQuery(filters: EnquiryFilters, cursor?: string | null, limit = PAGE_SIZE): string {
  const query = new URLSearchParams()
  if (filters.status !== 'all') query.set('status', filters.status)
  if (filters.category !== 'all') query.set('category', filters.category)
  if (filters.tag) query.set('tag', filters.tag)
  if (filters.flagged) query.set('flagged', 'true')
  const q = filters.q.trim().slice(0, SEARCH_MAX)
  if (q) query.set('q', q)
  if (cursor) query.set('cursor', cursor)
  query.set('limit', String(limit))
  return query.toString()
}

/** 筛选按钮上的数字（不含搜索框）。 */
export function activeFilterCount(filters: EnquiryFilters): number {
  return [filters.status !== 'all', filters.category !== 'all', filters.tag !== '', filters.flagged].filter(Boolean)
    .length
}

/** 订阅状态胶囊：Active 绿色（Figma），付款异常（含 Portal 的 grace 宽限期）琥珀色，其它中性。 */
export function subscriptionTone(status: string): 'success' | 'warning' | 'neutral' {
  const value = status.trim().toLowerCase()
  if (value === 'active' || value === 'trialing') return 'success'
  if (value === 'past_due' || value === 'unpaid' || value === 'incomplete' || value === 'grace') return 'warning'
  return 'neutral'
}
