import type {
  AgentActionInput,
  EnquiryDetail,
  EnquiryList,
  HelpdeskQuestion,
  QuestionCreateBody,
  QuestionTransition,
  QuestionUpdateBody,
} from '../contracts/helpdesk'
import { questionQuery, type QuestionFilters } from './helpdeskQuestions'
import { enquiryQuery, type EnquiryFilters } from './helpdeskView'
import { notifySessionChanged } from './navigation'

/**
 * HelpDesk 接口（设计文档 §5.4）。与 boRequest 一样解统一信封，但保留 HelpDesk 自己的错误码
 * （HELPDESK_NOT_CONNECTED / STALE_TICKET / VERSION_CONFLICT …），页面按码显示文案。
 * 浏览器只调 BackOffice Server，从不直连 Portal。
 */
export type HelpdeskResult<T> = { ok: true; data: T } | { ok: false; code: string; status: number }

async function request<T>(url: string, init?: RequestInit): Promise<HelpdeskResult<T>> {
  try {
    const response = await fetch(url, { credentials: 'same-origin', ...init })
    // 会话失效或角色刚被改：让外壳重读 /api/session
    if (response.status === 401 || response.status === 403) notifySessionChanged()
    const body = (await response.json().catch(() => null)) as {
      success?: boolean
      data?: T
      error?: { code?: string } | null
    } | null
    if (body?.success === true) return { ok: true, data: body.data as T }
    const code = body?.error?.code
    return { ok: false, code: typeof code === 'string' && code !== '' ? code : 'INTERNAL_ERROR', status: response.status }
  } catch {
    return { ok: false, code: 'HELPDESK_UNAVAILABLE', status: 0 }
  }
}

function sendJson<T>(method: 'POST' | 'PUT', url: string, body: unknown, idempotencyKey?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
  return request<T>(url, { method, headers, body: JSON.stringify(body) })
}

const ticketPath = (ticketId: string) => `/api/helpdesk/tickets/${encodeURIComponent(ticketId)}`
const questionPath = (questionId: string) => `/api/helpdesk/questions/${encodeURIComponent(questionId)}`

/* ---------------------------------- Enquiries ---------------------------------- */

export function listEnquiries(filters: EnquiryFilters, cursor?: string | null) {
  return request<EnquiryList>(`/api/helpdesk/tickets?${enquiryQuery(filters, cursor)}`)
}

export function getEnquiry(ticketId: string) {
  return request<EnquiryDetail>(ticketPath(ticketId))
}

export function sendMessage(
  ticketId: string,
  input: { body: string; internal: boolean; expectedSequence: number },
  idempotencyKey: string,
) {
  return sendJson<EnquiryDetail>('POST', `${ticketPath(ticketId)}/messages`, input, idempotencyKey)
}

/** claim / propose_resolution（Mark as reviewed）/ add_tag / remove_tag / mark_read。 */
export function sendAction(ticketId: string, input: AgentActionInput, idempotencyKey: string) {
  return sendJson<EnquiryDetail>('POST', `${ticketPath(ticketId)}/actions`, input, idempotencyKey)
}

/** 附件走 BackOffice Server 代理（图片内联、其它下载）。 */
export function attachmentUrl(attachmentId: string): string {
  return `/api/helpdesk/attachments/${encodeURIComponent(attachmentId)}`
}

/** Idempotency-Key：一次提交一个 UUID v4，重试沿用（Server 只收 UUID）。 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/* ------------------------------- Common Questions ------------------------------- */

export function listQuestions(filters: QuestionFilters) {
  const query = questionQuery(filters)
  return request<{ questions: HelpdeskQuestion[] }>(`/api/helpdesk/questions${query ? `?${query}` : ''}`)
}

/** 版本冲突后取最新版本（弹窗保留草稿，用新 version 重试）。 */
export function getQuestion(questionId: string) {
  return request<HelpdeskQuestion>(questionPath(questionId))
}

export function createQuestion(body: QuestionCreateBody) {
  return sendJson<HelpdeskQuestion>('POST', '/api/helpdesk/questions', body)
}

export function updateQuestion(questionId: string, body: QuestionUpdateBody) {
  return sendJson<HelpdeskQuestion>('PUT', questionPath(questionId), body)
}

export function transitionQuestion(questionId: string, action: QuestionTransition, version: number) {
  return sendJson<HelpdeskQuestion>('POST', `${questionPath(questionId)}/${action}`, { version })
}

export function reorderQuestions(items: { id: string; version: number }[]) {
  return sendJson<{ questions: HelpdeskQuestion[] }>('POST', '/api/helpdesk/questions/reorder', { items })
}
