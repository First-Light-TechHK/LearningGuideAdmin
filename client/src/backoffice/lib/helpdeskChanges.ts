import { FAQ_CHANGE_SUBJECTS, type FaqChange, type FaqChangeSubject, type FaqFieldChange } from '../contracts/helpdesk'
import { faqCategoryLabel, faqSignalLabel } from './helpdeskFormat'
import type { Locale } from './i18n/config'
import { t } from './i18n/messages'

/**
 * FAQ 修改记录（Change Log 与 FAQ 抽屉的 History，Figma 草案 2.6–2.9，用户 2026-10-30 确认）的纯逻辑：
 * 地址栏筛选（?tab=changes&q=&by=&type=&range=&faq=&page=）、接口查询串（时间段按浏览器本地的零点）、
 * 每一行的标题与一句话摘要、字段的显示值、列表的加减（关键词、情境）、长文字改了哪一段。
 * 单测在 client/tests/helpdesk-changes.test.ts。
 */

export const CHANGE_PAGE_SIZE = 10
export const CHANGE_SEARCH_MAX = 200
export const CHANGE_RANGES = ['all', 'today', '7d', '30d', '90d'] as const
export type ChangeRange = (typeof CHANGE_RANGES)[number]
export type ChangeType = FaqChangeSubject | 'all'

export type ChangeFilters = {
  q: string
  /** 'all'、'system'（种子 / 系统写入）或员工 id。 */
  by: string
  type: ChangeType
  range: ChangeRange
  /** 只看一条 FAQ（「Open in Change Log」）；'' = 全部。 */
  faq: string
  page: number
}

/** Figma 2.6 缺省「Last 30 days」。 */
export const DEFAULT_CHANGE_FILTERS: ChangeFilters = {
  q: '',
  by: 'all',
  type: 'all',
  range: '30d',
  faq: '',
  page: 1,
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function readChangeFilters(params: URLSearchParams): ChangeFilters {
  const by = params.get('by') ?? ''
  const type = params.get('type') as ChangeType | null
  const range = params.get('range') as ChangeRange | null
  const faq = params.get('faq') ?? ''
  const page = Number(params.get('page'))
  return {
    q: (params.get('q') ?? '').trim().slice(0, CHANGE_SEARCH_MAX),
    by: by === 'system' || UUID.test(by) ? by.toLowerCase() : 'all',
    type: type && (FAQ_CHANGE_SUBJECTS as readonly string[]).includes(type) ? type : 'all',
    range: range && (CHANGE_RANGES as readonly string[]).includes(range) ? range : DEFAULT_CHANGE_FILTERS.range,
    faq: UUID.test(faq) ? faq.toLowerCase() : '',
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  }
}

/** 筛选 → 地址栏：缺省值不写，其它参数（tab）保留。 */
export function writeChangeFilters(params: URLSearchParams, patch: Partial<ChangeFilters>): URLSearchParams {
  const next = new URLSearchParams(params)
  for (const [key, value] of Object.entries(patch) as [keyof ChangeFilters, unknown][]) {
    const text = String(value ?? '').trim()
    if (text === '' || text === String(DEFAULT_CHANGE_FILTERS[key])) next.delete(key)
    else next.set(key, text)
  }
  return next
}

/** 一条 FAQ 在 Change Log 里的地址（全部时间，不然旧的改动被「最近 30 天」藏起来）。 */
export function changeLogHref(locale: Locale, faqId: string): string {
  return `/${locale}/help-desk?tab=changes&range=all&faq=${encodeURIComponent(faqId)}`
}

/** 时间段的起点：本地今天零点往前推（today = 今天零点）。 */
export function rangeStart(range: ChangeRange, now: Date): Date | null {
  const days = { all: null, today: 0, '7d': 6, '30d': 29, '90d': 89 }[range]
  if (days === null) return null
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  start.setDate(start.getDate() - days)
  return start
}

/** BackOffice 接口的查询串。 */
export function changeQuery(filters: ChangeFilters, now: Date): string {
  const query = new URLSearchParams()
  if (filters.type !== 'all') query.set('subject', filters.type)
  if (filters.by !== 'all') query.set('employee', filters.by)
  if (filters.faq) query.set('faq', filters.faq)
  const from = rangeStart(filters.range, now)
  if (from) query.set('from', from.toISOString())
  const q = filters.q.trim().slice(0, CHANGE_SEARCH_MAX)
  if (q) query.set('q', q)
  query.set('page', String(filters.page))
  query.set('pageSize', String(CHANGE_PAGE_SIZE))
  return query.toString()
}

/* ---------------------------------- 显示 ---------------------------------- */

function question(locale: Locale, node: { questionEn: string; questionZh: string } | null): string {
  if (!node) return ''
  return locale === 'zh-CN' ? node.questionZh || node.questionEn : node.questionEn || node.questionZh
}

/** 第几个（position 从 0 起）：1st / 2nd / 3rd / 4th；中文「第 2 个」。 */
export function ordinal(locale: Locale, position: number): string {
  const n = position + 1
  if (locale === 'zh-CN') return `第 ${n} 个`
  const tens = n % 100
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th')
  return `${n}${suffix}`
}

export function personName(locale: Locale, change: Pick<FaqChange, 'employee'>): string {
  if (!change.employee) return t(locale, 'helpDesk.changes.system')
  return change.employee.name || t(locale, 'helpDesk.changes.formerEmployee')
}

export function personRole(locale: Locale, change: Pick<FaqChange, 'employee'>): string {
  const role = change.employee?.role
  if (!change.employee) return t(locale, 'helpDesk.changes.systemHint')
  return role ? t(locale, `roles.${role}`) : ''
}

export function fieldLabel(locale: Locale, field: string): string {
  return t(locale, `helpDesk.changes.fields.${field}`)
}

/** 一个字段值的显示文字（列表另有 listDiff；长文字另有 textDiff）。 */
export function fieldValue(locale: Locale, field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return t(locale, 'helpDesk.changes.empty_value')
  if (field === 'category') return faqCategoryLabel(locale, String(value))
  if (field === 'popular' || field === 'entry') return t(locale, value ? 'helpDesk.faqs.yes' : 'helpDesk.faqs.no')
  if (field === 'type') return t(locale, `helpDesk.graph.types.${String(value)}`)
  if (field === 'status') return t(locale, `helpDesk.changes.status.${String(value)}`)
  if (field === 'position') return ordinal(locale, Number(value))
  if (field === 'kind') return t(locale, `helpDesk.changes.subjects.${String(value)}`)
  if (field === 'signals' && Array.isArray(value)) return value.map((s) => faqSignalLabel(locale, String(s))).join(', ')
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

export const LIST_FIELDS = ['keywords', 'signals'] as const
export const TEXT_FIELDS = ['answerEn', 'answerZh', 'questionEn', 'questionZh'] as const

export function isListField(field: string): boolean {
  return (LIST_FIELDS as readonly string[]).includes(field)
}

export function isTextField(field: string): boolean {
  return (TEXT_FIELDS as readonly string[]).includes(field)
}

/** 列表字段的加减（保持原来的顺序；没变的也给出，界面灰着显示）。 */
export function listDiff(before: unknown, after: unknown): { kept: string[]; removed: string[]; added: string[] } {
  const b = Array.isArray(before) ? before.map(String) : []
  const a = Array.isArray(after) ? after.map(String) : []
  return {
    kept: a.filter((item) => b.includes(item)),
    removed: b.filter((item) => !a.includes(item)),
    added: a.filter((item) => !b.includes(item)),
  }
}

export type TextPart = { text: string; changed: boolean }

/**
 * 长文字改了哪一段：去掉相同的开头和结尾（按字符，退到词 / 句的边界），中间那段标出来。
 * 只是给人看的提示，不是完整的 diff；没变返回整段不标。
 */
export function textDiff(before: string, after: string): { before: TextPart[]; after: TextPart[] } {
  if (before === after)
    return {
      before: [{ text: before, changed: false }],
      after: [{ text: after, changed: false }],
    }
  let start = 0
  const max = Math.min(before.length, after.length)
  while (start < max && before[start] === after[start]) start += 1
  let end = 0
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end += 1
  // 退到边界（空白或标点之后），避免把一个词切成两半
  const boundary = /[\s.,;:!?。，；：！？、]/
  while (start > 0 && !boundary.test(before[start - 1])) start -= 1
  while (end > 0 && !boundary.test(before[before.length - end] ?? '')) end -= 1
  const parts = (text: string): TextPart[] =>
    [
      { text: text.slice(0, start), changed: false },
      { text: text.slice(start, text.length - end), changed: true },
      { text: text.slice(text.length - end), changed: false },
    ].filter((part) => part.text !== '')
  return { before: parts(before), after: parts(after) }
}

/** 行的标题：FAQ 的问题；追问 / 选项是「父 → 子」；版本是「Version N」。 */
export function changeTitle(locale: Locale, change: FaqChange): string {
  if (change.subject === 'release')
    return t(locale, 'helpDesk.changes.version', {
      version: change.release?.version ?? '',
    })
  if (change.subject === 'follow_up' || change.subject === 'option')
    return `${question(locale, change.faq)} → ${question(locale, change.child)}`
  return question(locale, change.faq)
}

/** 行的小字类型：FAQ / Follow-up / Option / Phrasing / Release。 */
export function subjectLabel(locale: Locale, change: Pick<FaqChange, 'subject'>): string {
  return t(locale, `helpDesk.changes.subjects.${change.subject}`)
}

export function actionLabel(locale: Locale, change: Pick<FaqChange, 'action'>): string {
  return t(locale, `helpDesk.changes.actions.${change.action}`)
}

/** 动作的颜色（Figma 2.6 的 chip）：新增绿、修改蓝、删除红、发布紫、其它灰。 */
export function actionTone(change: Pick<FaqChange, 'action'>): 'green' | 'blue' | 'red' | 'purple' | 'neutral' {
  switch (change.action) {
    case 'created':
    case 'added':
      return 'green'
    case 'edited':
    case 'changed':
    case 'reordered':
      return 'blue'
    case 'archived':
    case 'removed':
      return 'red'
    case 'published':
    case 'rolled_back':
      return 'purple'
    default:
      return 'neutral'
  }
}

function find(change: FaqChange, field: string): FaqFieldChange | undefined {
  return change.changes.find((c) => c.field === field)
}

function phrasingLine(locale: Locale, change: FaqChange): string {
  const p = change.phrasing
  if (!p) return ''
  return t(locale, 'helpDesk.changes.summary.phrasing', {
    text: p.text,
    language: t(locale, `helpDesk.graph.phrasingLocales.${p.locale}`),
  })
}

/** 「What changed」下面那一句。 */
export function changeSummary(locale: Locale, change: FaqChange): string {
  const s = (key: string, values?: Record<string, string | number>) => t(locale, `helpDesk.changes.summary.${key}`, values)
  switch (change.subject) {
    case 'faq': {
      if (change.action === 'archived') return s('archived')
      if (change.action === 'created') {
        const category = find(change, 'category')
        const popular = find(change, 'popular')?.after === true
        return [category ? faqCategoryLabel(locale, String(category.after)) : '', popular ? t(locale, 'helpDesk.changes.popular') : '']
          .filter(Boolean)
          .join(' · ')
      }
      if (change.changes.length === 0) return s('noFields')
      return change.changes.map((c) => fieldLabel(locale, c.field)).join(' · ')
    }
    case 'follow_up':
    case 'option': {
      const position = find(change, 'position')
      if (change.action === 'added')
        return s('shown', {
          position: ordinal(locale, Number(position?.after ?? 0)),
        })
      if (change.action === 'removed') return s('unlinked')
      if (change.action === 'reordered')
        return s('moved', {
          from: ordinal(locale, Number(position?.before ?? 0)),
          to: ordinal(locale, Number(position?.after ?? 0)),
        })
      const label = find(change, locale === 'zh-CN' ? 'labelZh' : 'labelEn') ?? find(change, 'labelEn') ?? find(change, 'labelZh')
      if (label) return label.after ? s('customText', { text: String(label.after) }) : s('questionText')
      return s('noFields')
    }
    case 'phrasing':
      return phrasingLine(locale, change)
    case 'release': {
      const r = change.release
      if (!r) return ''
      if (change.action === 'published') return s('published', { version: r.version })
      if (change.action === 'rolled_back') return s('rolledBack', { version: r.sourceVersion ?? '' })
      return r.problems === 0 ? s('checksPassed') : s('problems', { count: r.problems })
    }
  }
}

/** 「Learners see it」一栏。 */
export function learnersLine(
  locale: Locale,
  change: Pick<FaqChange, 'learners' | 'liveIn'>,
): { state: 'live' | 'pending'; hint: string } | null {
  if (change.learners === null) return null
  if (change.learners === 'pending')
    return {
      state: 'pending',
      hint: t(locale, change.liveIn ? 'helpDesk.changes.learners.rolledBack' : 'helpDesk.changes.learners.pendingHint', {
        version: change.liveIn ?? '',
      }),
    }
  return {
    state: 'live',
    hint: change.liveIn
      ? t(locale, 'helpDesk.changes.learners.liveIn', {
          version: change.liveIn,
        })
      : t(locale, 'helpDesk.changes.learners.liveNow'),
  }
}

/** 「30 Oct 2026」与「16:20」（列表两行）。 */
export function changeDate(iso: string, locale: Locale): { date: string; time: string } {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return { date: '—', time: '' }
  return {
    date: new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(date),
    time: new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(date),
  }
}

/** 详情里的「30 Oct 2026, 16:20:05」。 */
export function changeDateTime(iso: string, locale: Locale): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(date)
}

/** 浏览器的时区（详情里注明时间是哪个时区的）。 */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}
