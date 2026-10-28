import type {
  AgentAction,
  BoardResult,
  BoardTicketDetail,
  HelpdeskTab,
} from '../contracts/helpdesk'
import { notifySessionChanged } from './navigation'

/**
 * HelpDesk 接口（设计文档 §5.4）。与 boRequest 一样解统一信封，但保留 HelpDesk 自己的错误码
 * （HELPDESK_NOT_CONNECTED / STALE_TICKET / INVALID_TRANSITION …），页面按码显示文案。
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

function postJson<T>(url: string, body: unknown, idempotencyKey: string): Promise<HelpdeskResult<T>> {
  return request<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  })
}

export function listTickets(params: { tab: HelpdeskTab; q?: string; cursor?: string | null }) {
  const search = new URLSearchParams({ tab: params.tab })
  if (params.q && params.q.trim() !== '') search.set('q', params.q.trim())
  if (params.cursor) search.set('cursor', params.cursor)
  return request<BoardResult>(`/api/helpdesk/tickets?${search.toString()}`)
}

export function getTicket(ticketId: string) {
  return request<BoardTicketDetail>(`/api/helpdesk/tickets/${encodeURIComponent(ticketId)}`)
}

export function sendMessage(
  ticketId: string,
  input: { body: string; internal: boolean; expectedSequence: number },
  idempotencyKey: string,
) {
  return postJson<BoardTicketDetail>(
    `/api/helpdesk/tickets/${encodeURIComponent(ticketId)}/messages`,
    input,
    idempotencyKey,
  )
}

export function sendAction(
  ticketId: string,
  input: { action: AgentAction; expectedSequence: number },
  idempotencyKey: string,
) {
  return postJson<BoardTicketDetail>(
    `/api/helpdesk/tickets/${encodeURIComponent(ticketId)}/actions`,
    input,
    idempotencyKey,
  )
}

/** 附件图片走 BackOffice Server 代理，浏览器不直连 Portal。 */
export function attachmentUrl(attachmentId: string): string {
  return `/api/helpdesk/attachments/${encodeURIComponent(attachmentId)}`
}

/** Idempotency-Key：一次提交一个，重试沿用。 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
