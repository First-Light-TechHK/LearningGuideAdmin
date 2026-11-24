import { boRequest } from './api'
import { uploadFileWithProgress, type UploadResult } from './upload'

/**
 * 课程包上传：≤ 200 MB 走单次 POST；更大的包走分块会话（每块 5 MB），
 * 规避 CloudFront / App Runner 的单请求上限。分块通道只做上传，结构与媒体规格不变。
 * 200 MB 与服务端 PACKAGE_DIRECT_UPLOAD_BYTES 默认值一致；服务端仍会再校验。
 */
export const PACKAGE_DIRECT_UPLOAD_BYTES = 200 * 1024 * 1024
export const PACKAGE_CHUNK_BYTES = 5 * 1024 * 1024

type ChunkSession = { jobId: string; chunkSize?: number }

/** 导入作业里轮询需要的最小字段（直传与分块 complete 返回同一个作业视图）。 */
export type ImportJobStatus = {
  jobId: string
  status: string
  stage?: string | null
  progress?: number | null
  error?: string | null
}

/** 到了这些状态就不再轮询：可以确认 / 已失败 / 已取消。 */
export const IMPORT_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'AWAITING_CONFIRM',
  'FAILED',
  'CANCELLED',
])

export const IMPORT_POLL_INTERVAL_MS = 1500
const IMPORT_POLL_MAX_ATTEMPTS = 600

export type ImportPollOutcome<T> =
  | { ok: true; job: T }
  | { ok: false; job: T; reason: 'status-unavailable'; code?: string; message?: string }
  | { ok: false; job: T; reason: 'timeout' }

/**
 * 轮询导入作业直到终态（AWAITING_CONFIRM / FAILED / CANCELLED）。
 *
 * 直传（≤ 200 MB）服务端同步校验，返回时通常已是终态；
 * 分块通道（> 200 MB）complete 只返回 PACKAGE_QUEUED / VALIDATING，后台才拼包校验，
 * 确认按钮与 confirm 都必须等到 AWAITING_CONFIRM，否则服务端按 PACKAGE_CONFLICT(409) 拒绝。
 */
export async function waitForImportJob<T extends ImportJobStatus>(
  initial: T,
  onUpdate?: (job: T) => void,
): Promise<ImportPollOutcome<T>> {
  let job = initial
  for (
    let attempt = 0;
    attempt < IMPORT_POLL_MAX_ATTEMPTS && !IMPORT_TERMINAL_STATUSES.has(job.status);
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, IMPORT_POLL_INTERVAL_MS))
    const poll = await boRequest<T>(`/api/backoffice/courses/import/${job.jobId}`)
    if (!poll.success) {
      return { ok: false, job, reason: 'status-unavailable', code: poll.code ?? poll.error, message: poll.message }
    }
    job = poll.data
    onUpdate?.(job)
  }
  if (!IMPORT_TERMINAL_STATUSES.has(job.status)) return { ok: false, job, reason: 'timeout' }
  return { ok: true, job }
}

export async function uploadCoursePackage<T>(
  file: File,
  onProgress?: (pct: number) => void,
  targetCourseId?: string,
): Promise<UploadResult<T>> {
  if (file.size <= PACKAGE_DIRECT_UPLOAD_BYTES) {
    const url = targetCourseId
      ? `/api/backoffice/courses/${targetCourseId}/import`
      : '/api/backoffice/courses/import'
    return uploadFileWithProgress<T>(url, file, onProgress)
  }

  const session = await boRequest<ChunkSession>('/api/backoffice/courses/import/package/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fileName: file.name,
      bytesTotal: file.size,
      ...(targetCourseId ? { courseId: targetCourseId } : {}),
    }),
  })
  if (!session.success) {
    return { success: false, error: session.code ?? session.error, errorMessage: session.message }
  }
  const { jobId } = session.data
  const chunkSize = Math.max(1, session.data.chunkSize ?? PACKAGE_CHUNK_BYTES)
  const count = Math.ceil(file.size / chunkSize)
  let uploadedBytes = 0
  for (let index = 0; index < count; index++) {
    const start = index * chunkSize
    const blob = file.slice(start, Math.min(file.size, start + chunkSize))
    const result = await uploadFileWithProgress<{ progress: number }>(
      `/api/backoffice/courses/import/package/${jobId}/chunk?index=${index}`,
      blob,
      (_pct, loaded) => onProgress?.(Math.min(99, Math.round(((uploadedBytes + loaded) / file.size) * 100))),
      { field: 'chunk', method: 'PUT' },
    )
    if (!result.success) return result
    uploadedBytes += blob.size
    onProgress?.(Math.min(99, Math.round((uploadedBytes / file.size) * 100)))
  }
  const completed = await boRequest<T>(`/api/backoffice/courses/import/package/${jobId}/complete`, { method: 'POST' })
  if (!completed.success) {
    return { success: false, error: completed.code ?? completed.error, errorMessage: completed.message }
  }
  onProgress?.(100)
  return { success: true, data: completed.data }
}
