import { FAQ_CATEGORIES, type FaqBody, type FaqCategory, type HelpdeskFaq } from '../contracts/helpdesk'
import { safeHref, unsafeLinks } from './helpdeskMarkdown'

/**
 * FAQs（Tickets v2 §1 / §3a / §3b，Figma 1379:2 / 1379:299）的纯逻辑：草稿、校验、工具栏插入、
 * 筛选与分页、保存结果。上限与 Server faqContracts.ts 的 FAQ_LIMITS 一致；单测在
 * client/tests/helpdesk-faqs.test.ts。
 */
export const FAQ_LIMITS = {
  questionMax: 200,
  answerMax: 4000,
  keywordsMax: 20,
  keywordMax: 40,
  searchMax: 200,
  pageSize: 10,
} as const

export type Swatch = { bg: string; fg: string }

/** Figma 1379:2 分类胶囊（颜色按分类固定）。 */
export const FAQ_CATEGORY_SWATCH: Record<FaqCategory, Swatch> = {
  account_technical: { bg: '#f2f5f9', fg: '#69778b' },
  courses_learning: { bg: '#f0ebff', fg: '#7655c1' },
  payments_subscriptions: { bg: '#eaf3ff', fg: '#2468df' },
  other: { bg: '#f2f5f9', fg: '#69778b' },
}

/* ------------------------------------ 草稿 ------------------------------------ */

export type FaqDraft = {
  category: FaqCategory | null
  popular: boolean
  questionEn: string
  answerEn: string
  questionZh: string
  answerZh: string
  /** 输入框里的原文（逗号分隔）。 */
  keywords: string
}

export type FaqField = 'category' | 'questionEn' | 'answerEn' | 'questionZh' | 'answerZh' | 'keywords'
export type FaqFieldError = 'required' | 'tooLong' | 'tooMany' | 'unsafeLink'
export type FaqDraftErrors = Partial<Record<FaqField, FaqFieldError>>

export function emptyFaqDraft(): FaqDraft {
  return { category: null, popular: false, questionEn: '', answerEn: '', questionZh: '', answerZh: '', keywords: '' }
}

export function draftFromFaq(faq: HelpdeskFaq): FaqDraft {
  return {
    category: faq.category,
    popular: faq.popular,
    questionEn: faq.questionEn,
    answerEn: faq.answerEn,
    questionZh: faq.questionZh,
    answerZh: faq.answerZh,
    keywords: faq.keywords.join(', '),
  }
}

/** 逗号（含中文逗号）分隔；去空白、小写、去重（与 Server 一致）。 */
export function parseKeywords(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/[,，]/)) {
    const keyword = raw.trim().replace(/\s+/g, ' ').toLowerCase()
    if (keyword && !out.includes(keyword)) out.push(keyword)
  }
  return out
}

export function isDraftDirty(draft: FaqDraft, original: FaqDraft): boolean {
  return (Object.keys(original) as (keyof FaqDraft)[]).some((key) => draft[key] !== original[key])
}

function textError(value: string, max: number): FaqFieldError | null {
  const text = value.replace(/\r\n?/g, '\n').trim()
  if (text === '') return 'required'
  return text.length > max ? 'tooLong' : null
}

function answerError(value: string): FaqFieldError | null {
  const basic = textError(value, FAQ_LIMITS.answerMax)
  if (basic) return basic
  return unsafeLinks(value).length ? 'unsafeLink' : null
}

/** 与 Server faqService.ts 同一套规则；保存前先在本地拦住。 */
export function validateFaqDraft(draft: FaqDraft): FaqDraftErrors {
  const errors: FaqDraftErrors = {}
  const set = (field: FaqField, error: FaqFieldError | null) => {
    if (error) errors[field] = error
  }
  if (!draft.category) errors.category = 'required'
  set('questionEn', textError(draft.questionEn, FAQ_LIMITS.questionMax))
  set('answerEn', answerError(draft.answerEn))
  set('questionZh', textError(draft.questionZh, FAQ_LIMITS.questionMax))
  set('answerZh', answerError(draft.answerZh))
  const keywords = parseKeywords(draft.keywords)
  if (keywords.length > FAQ_LIMITS.keywordsMax) errors.keywords = 'tooMany'
  else if (keywords.some((keyword) => keyword.length > FAQ_LIMITS.keywordMax)) errors.keywords = 'tooLong'
  return errors
}

const tidy = (value: string) => value.replace(/\r\n?/g, '\n').trim()

export function toFaqBody(draft: FaqDraft): FaqBody {
  return {
    category: draft.category as FaqCategory,
    popular: draft.popular,
    questionEn: tidy(draft.questionEn),
    answerEn: tidy(draft.answerEn),
    questionZh: tidy(draft.questionZh),
    answerZh: tidy(draft.answerZh),
    keywords: parseKeywords(draft.keywords),
  }
}

/* ---------------------------------- 工具栏 ---------------------------------- */

export type TextEdit = { value: string; selectionStart: number; selectionEnd: number }

/** B：选中文字包上 **；没选中就插入 **** 并把光标放在中间。 */
export function applyBold(value: string, start: number, end: number): TextEdit {
  const selected = value.slice(start, end)
  const next = `${value.slice(0, start)}**${selected}**${value.slice(end)}`
  return { value: next, selectionStart: start + 2, selectionEnd: end + 2 }
}

/** 1. / •：选中的每一行（或光标所在行）加「1. 」「2. 」… 或「- 」，从行首开始。 */
export function applyList(value: string, start: number, end: number, kind: 'ordered' | 'bullet'): TextEdit {
  const lineStart = value.lastIndexOf('\n', start - 1) + 1
  const nextBreak = value.indexOf('\n', end)
  const lineEnd = nextBreak < 0 ? value.length : nextBreak
  const lines = value.slice(lineStart, lineEnd).split('\n')
  const block = lines.map((line, index) => `${kind === 'ordered' ? `${index + 1}. ` : '- '}${line}`).join('\n')
  const next = `${value.slice(0, lineStart)}${block}${value.slice(lineEnd)}`
  const blockEnd = lineStart + block.length
  // 空行只插入了标记：光标放到标记后面，方便直接输入
  if (lines.every((line) => line === '')) return { value: next, selectionStart: blockEnd, selectionEnd: blockEnd }
  return { value: next, selectionStart: lineStart, selectionEnd: blockEnd }
}

/** Link：选中文字变成链接文字（没选中就用地址本身）；地址不是 http(s) / mailto 时返回 null。 */
export function applyLink(value: string, start: number, end: number, rawUrl: string): TextEdit | null {
  const url = rawUrl.trim()
  if (!safeHref(url)) return null
  const label = value.slice(start, end) || url
  const link = `[${label}](${url})`
  const next = `${value.slice(0, start)}${link}${value.slice(end)}`
  const caret = start + link.length
  return { value: next, selectionStart: caret, selectionEnd: caret }
}

/* ---------------------------------- 筛选 / 分页 ---------------------------------- */

export type PopularFilter = 'all' | 'popular' | 'not_popular'
export type FaqFilters = { q: string; category: FaqCategory | 'all'; popular: PopularFilter; page: number }

export const DEFAULT_FAQ_FILTERS: FaqFilters = { q: '', category: 'all', popular: 'all', page: 1 }
const POPULAR_FILTERS: readonly PopularFilter[] = ['all', 'popular', 'not_popular']

function isFaqCategory(value: string | null): value is FaqCategory {
  return value !== null && (FAQ_CATEGORIES as readonly string[]).includes(value)
}

/** 地址栏 → 筛选；未知值回到缺省。 */
export function readFaqFilters(params: URLSearchParams): FaqFilters {
  const category = params.get('category')
  const popular = params.get('popular') as PopularFilter | null
  const page = Number(params.get('page'))
  return {
    q: (params.get('q') ?? '').trim().slice(0, FAQ_LIMITS.searchMax),
    category: isFaqCategory(category) ? category : 'all',
    popular: popular && POPULAR_FILTERS.includes(popular) ? popular : 'all',
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  }
}

/** 筛选 → 地址栏：缺省值不写，其它参数（tab）保留。 */
export function writeFaqFilters(params: URLSearchParams, patch: Partial<FaqFilters>): URLSearchParams {
  const next = new URLSearchParams(params)
  for (const [key, value] of Object.entries(patch) as [keyof FaqFilters, unknown][]) {
    const text = String(value ?? '').trim()
    if (text === '' || text === String(DEFAULT_FAQ_FILTERS[key])) next.delete(key)
    else next.set(key, text)
  }
  return next
}

/** BackOffice 列表接口的查询串（每页 10 条）。 */
export function faqQuery(filters: FaqFilters): string {
  const query = new URLSearchParams()
  if (filters.category !== 'all') query.set('category', filters.category)
  if (filters.popular !== 'all') query.set('popular', filters.popular === 'popular' ? 'true' : 'false')
  const q = filters.q.trim().slice(0, FAQ_LIMITS.searchMax)
  if (q) query.set('q', q)
  query.set('page', String(filters.page))
  query.set('pageSize', String(FAQ_LIMITS.pageSize))
  return query.toString()
}

/** 「Showing 1–8 of 8 FAQs」。 */
export function showingRange(page: number, pageSize: number, total: number): { from: number; to: number } {
  if (total <= 0) return { from: 0, to: 0 }
  const from = (page - 1) * pageSize + 1
  return { from: Math.min(from, total), to: Math.min(page * pageSize, total) }
}

/** 页码按钮：不超过 7 页全显示，否则首、尾、当前页前后各一页，中间用省略号。 */
export function pageWindow(page: number, totalPages: number): (number | 'gap')[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1)
  const out: (number | 'gap')[] = [1]
  const from = Math.max(2, page - 1)
  const to = Math.min(totalPages - 1, page + 1)
  if (from > 2) out.push('gap')
  for (let n = from; n <= to; n += 1) out.push(n)
  if (to < totalPages - 1) out.push('gap')
  out.push(totalPages)
  return out
}

/* ------------------------------------ 保存 ------------------------------------ */

export type FaqSaveOutcome = 'saved' | 'conflict' | 'gone' | 'error'

export function faqSaveOutcome(result: { ok: true; data: unknown } | { ok: false; code: string; status: number }): FaqSaveOutcome {
  if (result.ok) return 'saved'
  if (result.code === 'VERSION_CONFLICT') return 'conflict'
  if (result.code === 'FAQ_NOT_FOUND') return 'gone'
  return 'error'
}

export type FaqKey = { key: string; body: string }

/** 新建的 Idempotency-Key：同样的内容重试沿用同一个，内容变了换新（Server 对同 key 不同内容回 422）。 */
export function faqKeyFor(previous: FaqKey | null, body: FaqBody, make: () => string): FaqKey {
  const text = JSON.stringify(body)
  if (previous && previous.body === text) return previous
  return { key: make(), body: text }
}

export type FaqDrawerResult = 'saved' | 'deleted' | 'gone'

/** 抽屉结束后页面做什么：保存 / 删除成功提示并刷新列表；FAQ 已不存在则关闭并报错。 */
export function afterFaqSave(result: FaqDrawerResult): { refresh: boolean; close: boolean; toast: FaqDrawerResult } {
  return { refresh: true, close: true, toast: result }
}
