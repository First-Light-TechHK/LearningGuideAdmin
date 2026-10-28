import {
  TIMELINE_LIMIT,
  type AgentActionInput,
  type EnquiryDetail,
  type EnquiryList,
  type FaqBody,
  type FaqPage,
  type HelpdeskFaq,
} from '../contracts/helpdesk'
import { faqQuery, type FaqFilters } from './helpdeskFaqs'
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
const faqPath = (faqId: string) => `/api/helpdesk/faqs/${encodeURIComponent(faqId)}`

/* ---------------------------------- Enquiries ---------------------------------- */

export function listEnquiries(filters: EnquiryFilters, cursor?: string | null) {
  return request<EnquiryList>(`/api/helpdesk/tickets?${enquiryQuery(filters, cursor)}`)
}

/** 学员时间线（Figma 1324:2 中栏）：这个学员最多 10 条工单，新的在前。 */
export function listTimeline(learnerId: string) {
  const query = new URLSearchParams({ learnerId, limit: String(TIMELINE_LIMIT) })
  return request<EnquiryList>(`/api/helpdesk/tickets?${query.toString()}`)
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

/** claim / propose_resolution（Mark as reviewed）/ add_tag / remove_tag / mark_read / flag / unflag。 */
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

/* ------------------------------------ FAQs ------------------------------------ */

export function listFaqs(filters: FaqFilters) {
  return request<FaqPage>(`/api/helpdesk/faqs?${faqQuery(filters)}`)
}

/** 版本冲突后取最新版本（抽屉保留草稿，用新 version 重试）。 */
export function getFaq(faqId: string) {
  return request<HelpdeskFaq>(faqPath(faqId))
}

/** 新建：Idempotency-Key 防止重复提交生成两条。 */
export function createFaq(body: FaqBody, idempotencyKey: string) {
  return sendJson<HelpdeskFaq>('POST', '/api/helpdesk/faqs', body, idempotencyKey)
}

export function updateFaq(faqId: string, body: FaqBody & { version: number }) {
  return sendJson<HelpdeskFaq>('PUT', faqPath(faqId), body)
}

/** Delete FAQ = 归档（幂等）。 */
export function archiveFaq(faqId: string, version: number) {
  return sendJson<HelpdeskFaq>('POST', `${faqPath(faqId)}/archive`, { version })
}
