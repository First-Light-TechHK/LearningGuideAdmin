import type {
  FeatureKey,
  FeatureSettings,
  OverrideValue,
  SpecialFilter,
  StatusFilter,
  StudentActionResult,
  StudentDetails,
  StudentList,
  SubscriptionFilter,
} from '../contracts/students'
import { notifySessionChanged } from './navigation'
import { serverText } from './i18n/serverText'

/**
 * 学生管理接口。与 helpdeskApi 一样解统一信封、保留错误码（STUDENTS_NOT_CONNECTED / VERSION_CONFLICT /
 * EMAIL_TAKEN …）和服务端给员工看的说明，页面按码显示文案。浏览器只调 BackOffice Server。
 */
export type StudentsResult<T> = { ok: true; data: T } | { ok: false; code: string; status: number; message: string | null }

async function request<T>(url: string, init?: RequestInit): Promise<StudentsResult<T>> {
  try {
    const response = await fetch(url, { credentials: 'same-origin', ...init })
    if (response.status === 401 || response.status === 403) notifySessionChanged()
    const body = (await response.json().catch(() => null)) as {
      success?: boolean
      data?: T
      error?: { code?: string; message?: string } | null
    } | null
    if (body?.success === true) return { ok: true, data: body.data as T }
    const code = body?.error?.code
    return {
      ok: false,
      code: typeof code === 'string' && code !== '' ? code : 'INTERNAL_ERROR',
      status: response.status,
      message: typeof body?.error?.message === 'string' ? serverText(body.error.message) : null,
    }
  } catch {
    return { ok: false, code: 'STUDENTS_UNAVAILABLE', status: 0, message: null }
  }
}

function send<T>(method: 'POST' | 'PUT', url: string, body: unknown) {
  return request<T>(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

export type StudentFilters = { q: string; status: StatusFilter; subscription: SubscriptionFilter; special: SpecialFilter }

export function studentsQuery(filters: StudentFilters, page: number, pageSize: number) {
  const params = new URLSearchParams()
  if (filters.q.trim()) params.set('q', filters.q.trim())
  if (filters.status !== 'all') params.set('status', filters.status)
  if (filters.subscription !== 'all') params.set('subscription', filters.subscription)
  if (filters.special !== 'all') params.set('special', filters.special)
  params.set('page', String(page))
  params.set('pageSize', String(pageSize))
  return params.toString()
}

export const studentsApi = {
  list: (filters: StudentFilters, page: number, pageSize: number) =>
    request<StudentList>(`/api/students?${studentsQuery(filters, page, pageSize)}`),
  detail: (id: string) => request<StudentDetails>(`/api/students/${encodeURIComponent(id)}`),
  saveOverrides: (id: string, body: { reason: string; expectedVersion: string; overrides: Partial<Record<FeatureKey, OverrideValue>> }) =>
    send<StudentDetails>('PUT', `/api/students/${encodeURIComponent(id)}/feature-overrides`, body),
  act: (id: string, body: Record<string, unknown>) =>
    send<StudentActionResult>('POST', `/api/students/${encodeURIComponent(id)}/actions`, body),
  settings: () => request<FeatureSettings>('/api/learning-access'),
  saveSettings: (body: { reason: string; expectedVersion: string; features: Partial<Record<FeatureKey, { enabled: boolean }>> }) =>
    send<FeatureSettings>('PUT', '/api/learning-access', body),
  emergency: (body: { feature: FeatureKey; off: boolean; reason: string }) =>
    send<FeatureSettings>('POST', '/api/learning-access/emergency', body),
}
