import type { ApiResult } from './api'
import { boRequest, postJson } from './api'
import type {
  AudienceResponse,
  BroadcastDetailResponse,
  BroadcastDraftInput,
  BroadcastListResponse,
  NotificationChannel,
  NotificationCopy,
  NotificationLanguage,
  SendLogDetailResponse,
  SendLogResponse,
  TemplateUpdateInput,
  TemplatesResponse,
} from '../contracts/notifications'

const BASE = '/api/backoffice/notifications'

function patchJson<T>(url: string, body: unknown): Promise<ApiResult<T>> {
  return boRequest<T>(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export const notificationsApi = {
  templates(): Promise<ApiResult<TemplatesResponse>> {
    return boRequest<TemplatesResponse>(`${BASE}/templates`)
  },

  updateTemplate(id: string, input: TemplateUpdateInput): Promise<ApiResult<{ ok: true; template: unknown }>> {
    return boRequest(`${BASE}/templates/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
  },

  testTemplate(
    id: string,
    input: {
      channel: NotificationChannel
      language: NotificationLanguage
      copy?: Partial<Record<NotificationLanguage, NotificationCopy>>
    },
  ): Promise<ApiResult<Record<string, unknown>>> {
    return postJson(`${BASE}/templates/${encodeURIComponent(id)}/test`, input)
  },

  audiences(): Promise<ApiResult<AudienceResponse>> {
    return boRequest<AudienceResponse>(`${BASE}/audiences`)
  },

  broadcasts(page = 1): Promise<ApiResult<BroadcastListResponse>> {
    return boRequest<BroadcastListResponse>(`${BASE}/broadcasts?page=${page}`)
  },

  createBroadcast(input: BroadcastDraftInput): Promise<ApiResult<{ ok: true; broadcast: unknown }>> {
    return postJson(`${BASE}/broadcasts`, input)
  },

  broadcast(id: string): Promise<ApiResult<BroadcastDetailResponse>> {
    return boRequest<BroadcastDetailResponse>(`${BASE}/broadcasts/${encodeURIComponent(id)}`)
  },

  patchBroadcast(
    id: string,
    body: Record<string, unknown>,
  ): Promise<ApiResult<{ ok: true; broadcast?: unknown; recipients?: number; withdrawn?: number }>> {
    return patchJson(`${BASE}/broadcasts/${encodeURIComponent(id)}`, body)
  },

  sendLog(query: Record<string, string | number | undefined>): Promise<ApiResult<SendLogResponse>> {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === '') continue
      params.set(key, String(value))
    }
    return boRequest<SendLogResponse>(`${BASE}/send-log?${params.toString()}`)
  },

  sendLogDetail(id: string): Promise<ApiResult<SendLogDetailResponse>> {
    return boRequest<SendLogDetailResponse>(`${BASE}/send-log/${encodeURIComponent(id)}`)
  },
}
