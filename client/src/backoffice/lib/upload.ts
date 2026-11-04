import { boRequest } from './api'
import { notifySessionChanged } from './navigation'
import { serverText } from './i18n/serverText'

export type UploadResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; errorMessage?: string }

export type UploadProgress = { pct: number; loaded: number; total: number }

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 带上传进度的单次上传（fetch 无法拿到上传进度，用 XHR 的 upload.onprogress）。
 * 超时/断网都收敛成稳定错误码，页面可以给出「可重试」的明确提示。
 */
export function uploadFileWithProgress<T>(
  url: string,
  file: Blob,
  onProgress?: (pct: number, loaded: number, total: number) => void,
  opts?: {
    field?: string
    method?: 'POST' | 'PUT'
    signal?: AbortSignal
    timeoutMs?: number
  },
): Promise<UploadResult<T>> {
  return new Promise((resolve) => {
    if (opts?.signal?.aborted) {
      resolve({ success: false, error: 'ABORTED' })
      return
    }
    const xhr = new XMLHttpRequest()
    xhr.open(opts?.method ?? 'POST', url)
    xhr.withCredentials = true
    xhr.timeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress?.(
          Math.round((event.loaded / event.total) * 100),
          event.loaded,
          event.total,
        )
      }
    }
    xhr.onload = () => {
      if (xhr.status === 401 || xhr.status === 403) notifySessionChanged()
      try {
        const body = JSON.parse(xhr.responseText) as {
          success?: boolean
          data?: T
          error?: { code?: string; message?: string } | null
        } | null
        if (body?.success === true) resolve({ success: true, data: body.data as T })
        else
          resolve({
            success: false,
            error: body?.error?.code ?? `HTTP_${xhr.status}`,
            errorMessage: serverText(body?.error?.message),
          })
      } catch {
        // 响应体不是 JSON 信封（多为网关 5xx/504 或单请求被边缘切断），带上真实状态码便于定位
        resolve({
          success: false,
          error: `HTTP_${xhr.status}`,
          errorMessage: `HTTP ${xhr.status}${xhr.statusText ? ` ${xhr.statusText}` : ''}`,
        })
      }
    }
    xhr.onerror = () => resolve({ success: false, error: 'NETWORK_ERROR' })
    xhr.ontimeout = () => resolve({ success: false, error: 'TIMEOUT' })
    xhr.onabort = () => resolve({ success: false, error: 'ABORTED' })
    const onSignalAbort = () => xhr.abort()
    opts?.signal?.addEventListener('abort', onSignalAbort, { once: true })
    const form = new FormData()
    form.append(opts?.field ?? 'file', file)
    xhr.send(form)
  })
}

/** 可重试的错误：网络、超时、网关 5xx；4xx 业务错误不重试，直接把原因给用户。 */
export function isRetryableUploadError(code: string): boolean {
  if (code === 'NETWORK_ERROR' || code === 'TIMEOUT') return true
  const match = /^HTTP_(\d{3})$/.exec(code)
  return Boolean(match && Number(match[1]) >= 500)
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export type ChunkedUploadResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; errorMessage?: string; cancelled?: boolean }

export interface ChunkedUploadCallbacks {
  /** 分块上传进度（附带整体已传字节，用于显示 MB 与剩余时间） */
  onProgress?: (progress: UploadProgress) => void
  /** 所有分块传完、服务端正在合并/校验 */
  onProcessing?: () => void
  signal?: AbortSignal
}

/**
 * 大文件分块上传：先开会话拿 chunkSize，再逐块 PUT，最后 complete。
 * 每块失败自动重试（最多 3 次），用户取消时主动释放服务端会话。
 * 用于视频等 100MB+ 文件：单请求会被 CloudFront/App Runner 中途切断。
 */
export async function uploadMediaInChunks<T>(
  params: { courseId: string; file: File; callbacks?: ChunkedUploadCallbacks },
): Promise<ChunkedUploadResult<T>> {
  const { courseId, file, callbacks } = params
  const signal = callbacks?.signal
  const base = `/api/backoffice/courses/${courseId}/media`
  const chunkUrl = (sessionId: string, index: number) =>
    `${base}/sessions/${sessionId}/chunk?index=${index}`

  const init = await boRequest<{ sessionId: string; chunkSize: number }>(`${base}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileName: file.name, bytesTotal: file.size }),
  })
  if (!init.success) {
    return { success: false, error: init.error, errorMessage: init.message }
  }
  const sessionId = init.data.sessionId
  const chunkSize = Math.max(1, init.data.chunkSize || 5 * 1024 * 1024)
  const total = file.size
  let sent = 0

  const cleanup = () => {
    void boRequest(`${base}/sessions/${sessionId}`, { method: 'DELETE' })
  }

  for (let index = 0; sent < total; index++) {
    if (signal?.aborted) {
      cleanup()
      return { success: false, error: 'ABORTED', cancelled: true }
    }
    const start = index * chunkSize
    const blob = file.slice(start, Math.min(start + chunkSize, total))
    let attempt = 0
    let chunkResult: UploadResult<unknown> = { success: false, error: 'NETWORK_ERROR' }
    while (attempt < 3) {
      chunkResult = await uploadFileWithProgress(
        chunkUrl(sessionId, index),
        blob,
        (pct, loaded) => {
          callbacks?.onProgress?.({
            pct: Math.min(99, Math.round(((sent + (blob.size * pct) / 100) / total) * 100)),
            loaded: sent + loaded,
            total,
          })
        },
        { field: 'chunk', method: 'PUT', signal },
      )
      if (chunkResult.success) break
      if (chunkResult.error === 'ABORTED' || !isRetryableUploadError(chunkResult.error)) break
      attempt += 1
      await new Promise((resolve) => setTimeout(resolve, 600 * attempt))
    }
    if (!chunkResult.success) {
      cleanup()
      if (chunkResult.error === 'ABORTED') {
        return { success: false, error: 'ABORTED', cancelled: true }
      }
      return { success: false, error: chunkResult.error, errorMessage: chunkResult.errorMessage }
    }
    sent += blob.size
    callbacks?.onProgress?.({ pct: Math.min(99, Math.round((sent / total) * 100)), loaded: sent, total })
  }

  callbacks?.onProcessing?.()
  const done = await boRequest<T>(`${base}/sessions/${sessionId}/complete`, { method: 'POST' })
  if (!done.success) {
    return { success: false, error: done.error, errorMessage: done.message }
  }
  return { success: true, data: done.data as T }
}
