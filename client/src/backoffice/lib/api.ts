import type { ErrorCode } from '../contracts/envelope'

const KNOWN_ERRORS: ReadonlySet<string> = new Set<ErrorCode>([
  'INVALID_INPUT',
  'INVALID_EMPLOYEE_ACCOUNT',
  'INVALID_CREDENTIALS',
  'ACCOUNT_NOT_ACTIVE',
  'EMAIL_NOT_VERIFIED',
  'NOT_AUTHORISED',
  'RATE_LIMITED',
  'PROTECTED_ADMIN_ACCOUNT',
  'INVALID_TOKEN',
  'TOKEN_EXPIRED',
  'TOKEN_ALREADY_USED',
  'DUPLICATE_EMAIL',
  'PASSWORD_TOO_WEAK',
  'PASSWORD_MISMATCH',
  'INTERNAL_ERROR',
])

export type ApiResult<T> = { success: true; data: T; error: null } | { success: false; data: null; error: ErrorCode }

/**
 * 后端统一信封是 { success, data, error: { code, message } }；
 * 页面只关心稳定错误码，这里收敛成 ErrorCode，未知错误一律 INTERNAL_ERROR。
 */
export async function boRequest<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, { credentials: 'same-origin', ...init })
    const body = (await response.json().catch(() => null)) as {
      success?: boolean
      data?: T
      error?: { code?: string } | null
    } | null
    if (body?.success === true) return { success: true, data: body.data as T, error: null }
    const code = body?.error?.code
    return {
      success: false,
      data: null,
      error: code && KNOWN_ERRORS.has(code) ? (code as ErrorCode) : 'INTERNAL_ERROR',
    }
  } catch {
    return { success: false, data: null, error: 'INTERNAL_ERROR' }
  }
}

export function postJson<T>(url: string, body: unknown): Promise<ApiResult<T>> {
  return boRequest<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 保持原页面 `const res = await fetch(); await res.json()` 的写法，json() 返回收敛后的信封。 */
export async function boFetch(url: string, init?: RequestInit): Promise<{ json: () => Promise<ApiResult<unknown>> }> {
  const result = await boRequest<unknown>(url, init)
  return { json: async () => result }
}
