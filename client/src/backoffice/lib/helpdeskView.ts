import {
  HELPDESK_CATEGORIES,
  LIST_STATUS_FILTERS,
  PAGE_SIZE,
  SEARCH_MAX,
  TAGS_PER_TICKET_MAX,
  TAG_MAX_LENGTH,
  type AvailableActions,
  type HelpdeskCategory,
  type ListStatusFilter,
  type TicketMessage,
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

export type EnquiryControls = {
  /** Figma「Mark as reviewed」= propose_resolution。 */
  markReviewed: boolean
  composer: boolean
  reply: boolean
  internalNote: boolean
  editTags: boolean
}

/** 写操作控件：VIEW 一律不显示；FULL 按 Server 给的 available。 */
export function enquiryControls(ticket: { available: AvailableActions }, canWrite: boolean): EnquiryControls {
  const a = ticket.available
  const reply = canWrite && a.reply
  const internalNote = canWrite && a.internalNote
  return {
    markReviewed: canWrite && a.proposeResolution,
    composer: reply || internalNote,
    reply,
    internalNote,
    editTags: canWrite && a.tag,
  }
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
}

export const DEFAULT_ENQUIRY_FILTERS: EnquiryFilters = { q: '', status: 'all', category: 'all', tag: '' }

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
  }
}

/** 筛选 → 地址栏：缺省值不写，其它参数保留。 */
export function writeEnquiryFilters(params: URLSearchParams, patch: Partial<EnquiryFilters>): URLSearchParams {
  const next = new URLSearchParams(params)
  for (const [key, value] of Object.entries(patch)) {
    const text = String(value ?? '').trim()
    if (text === '' || text === 'all') next.delete(key)
    else next.set(key, text)
  }
  return next
}

/** BackOffice 列表接口的查询串。 */
export function enquiryQuery(filters: EnquiryFilters, cursor?: string | null, limit = PAGE_SIZE): string {
  const query = new URLSearchParams()
  if (filters.status !== 'all') query.set('status', filters.status)
  if (filters.category !== 'all') query.set('category', filters.category)
  if (filters.tag) query.set('tag', filters.tag)
  const q = filters.q.trim().slice(0, SEARCH_MAX)
  if (q) query.set('q', q)
  if (cursor) query.set('cursor', cursor)
  query.set('limit', String(limit))
  return query.toString()
}

/** 筛选按钮上的数字（不含搜索框）。 */
export function activeFilterCount(filters: EnquiryFilters): number {
  return [filters.status !== 'all', filters.category !== 'all', filters.tag !== ''].filter(Boolean).length
}

/** 订阅状态胶囊：Active 绿色（Figma），付款异常琥珀色，其它中性。 */
export function subscriptionTone(status: string): 'success' | 'warning' | 'neutral' {
  const value = status.trim().toLowerCase()
  if (value === 'active' || value === 'trialing') return 'success'
  if (value === 'past_due' || value === 'unpaid' || value === 'incomplete') return 'warning'
  return 'neutral'
}
