import type {
  HelpdeskCategory,
  HelpdeskLocale,
  HelpdeskQuestion,
  QuestionCreateBody,
  QuestionStatus,
  QuestionUpdateBody,
} from '../contracts/helpdesk'

/**
 * Common Questions（Figma addendum §A，设计文档 §4A.7）的纯逻辑：表单校验、筛选参数、排序、行操作。
 * 单测在 client/tests/helpdesk-questions.test.ts；上限与 Server questionContracts.ts 一致。
 */
export const QUESTION_LIMITS = {
  questionMax: 200,
  answerMax: 4000,
  keywordsMax: 20,
  keywordMax: 40,
  searchMax: 200,
} as const

export type QuestionDraft = {
  locale: HelpdeskLocale
  category: HelpdeskCategory | null
  question: string
  answer: string
  keywords: string[]
  featured: boolean
  /** 只在新建时有效：保存后立即发布。 */
  publish: boolean
}

export type DraftErrors = Partial<
  Record<'category' | 'question' | 'answer' | 'keywords', 'required' | 'tooLong' | 'tooMany'>
>

export function emptyDraft(locale: HelpdeskLocale): QuestionDraft {
  return { locale, category: null, question: '', answer: '', keywords: [], featured: false, publish: false }
}

export function draftFromQuestion(question: HelpdeskQuestion): QuestionDraft {
  return {
    locale: question.locale,
    category: question.category,
    question: question.question,
    answer: question.answer,
    keywords: [...question.keywords],
    featured: question.featured,
    publish: false,
  }
}

export function normalizeKeywords(keywords: string[]): string[] {
  const seen = new Set<string>()
  for (const raw of keywords) {
    const keyword = raw.trim().toLowerCase()
    if (keyword) seen.add(keyword)
  }
  return [...seen]
}

export function validateDraft(draft: QuestionDraft): DraftErrors {
  const errors: DraftErrors = {}
  if (!draft.category) errors.category = 'required'
  const question = draft.question.trim()
  if (!question) errors.question = 'required'
  else if (question.length > QUESTION_LIMITS.questionMax) errors.question = 'tooLong'
  const answer = draft.answer.trim()
  if (!answer) errors.answer = 'required'
  else if (answer.length > QUESTION_LIMITS.answerMax) errors.answer = 'tooLong'
  const keywords = normalizeKeywords(draft.keywords)
  if (keywords.length > QUESTION_LIMITS.keywordsMax) errors.keywords = 'tooMany'
  else if (keywords.some((keyword) => keyword.length > QUESTION_LIMITS.keywordMax)) errors.keywords = 'tooLong'
  return errors
}

function fields(draft: QuestionDraft) {
  return {
    locale: draft.locale,
    category: draft.category as HelpdeskCategory,
    question: draft.question.trim(),
    answer: draft.answer.trim(),
    keywords: normalizeKeywords(draft.keywords),
    featured: draft.featured,
  }
}

export function toCreateBody(draft: QuestionDraft): QuestionCreateBody {
  return { ...fields(draft), publish: draft.publish }
}

export function toUpdateBody(draft: QuestionDraft, version: number): QuestionUpdateBody {
  return { version, ...fields(draft) }
}

/** 状态筛选：active = 草稿 + 已发布（Server 缺省），all 含已归档。 */
export type QuestionStatusFilter = 'active' | 'all' | QuestionStatus

export type QuestionFilters = {
  locale: HelpdeskLocale | 'all'
  category: HelpdeskCategory | 'all'
  status: QuestionStatusFilter
  q: string
}

export function questionQuery(filters: QuestionFilters): string {
  const query = new URLSearchParams()
  if (filters.locale !== 'all') query.set('locale', filters.locale)
  if (filters.category !== 'all') query.set('category', filters.category)
  if (filters.status !== 'active') query.set('status', filters.status)
  const q = filters.q.trim().slice(0, QUESTION_LIMITS.searchMax)
  if (q) query.set('q', q)
  return query.toString()
}

/**
 * 排序按语言各自独立（Portal 按 sort_order 展示该语言的问题），
 * 所以只在「选定一种语言、没有其它筛选」时提供上移 / 下移，避免只重排一部分。
 */
export function canReorder(filters: QuestionFilters): boolean {
  return filters.locale !== 'all' && filters.category === 'all' && filters.status === 'active' && filters.q.trim() === ''
}

/** 把第 index 行上移（-1）或下移（+1），返回整份新顺序；越界返回 null。 */
export function moveQuestion(
  rows: Pick<HelpdeskQuestion, 'id' | 'version'>[],
  index: number,
  delta: -1 | 1,
): { id: string; version: number }[] | null {
  const target = index + delta
  if (index < 0 || index >= rows.length || target < 0 || target >= rows.length) return null
  const order = rows.map(({ id, version }) => ({ id, version }))
  ;[order[index], order[target]] = [order[target], order[index]]
  return order
}

export type QuestionActions = {
  edit: boolean
  publish: boolean
  unpublish: boolean
  archive: boolean
  reorder: boolean
}

/** 行操作（与 Server 状态机一致）：归档后不能编辑，只能重新发布；VIEW 什么都没有。 */
export function questionActions(question: Pick<HelpdeskQuestion, 'status'>, canWrite: boolean): QuestionActions {
  if (!canWrite) return { edit: false, publish: false, unpublish: false, archive: false, reorder: false }
  const { status } = question
  return {
    edit: status !== 'archived',
    publish: status !== 'published',
    unpublish: status === 'published',
    archive: status !== 'archived',
    reorder: status !== 'archived',
  }
}

/**
 * 编辑弹窗保存失败后怎么办：版本冲突 → 取最新版本（保留草稿）再让员工重试；
 * 问题已不存在 → 关掉弹窗；其它错误在弹窗里提示。
 */
export function questionSaveFailure(code: string, editing: boolean): 'reload' | 'close' | 'show' {
  if (!editing) return 'show'
  if (code === 'VERSION_CONFLICT') return 'reload'
  if (code === 'QUESTION_NOT_FOUND') return 'close'
  return 'show'
}

export type QuestionSaveOutcome = 'saved' | 'conflict' | 'gone'

/** 页面收到弹窗结果：刷新列表、是否关弹窗、提示哪句（saved = 已保存，gone = 问题不存在）。 */
export function afterQuestionSave(outcome: QuestionSaveOutcome): {
  refresh: boolean
  close: boolean
  toast: 'saved' | 'gone' | null
} {
  if (outcome === 'saved') return { refresh: true, close: true, toast: 'saved' }
  if (outcome === 'gone') return { refresh: true, close: true, toast: 'gone' }
  return { refresh: true, close: false, toast: null }
}
