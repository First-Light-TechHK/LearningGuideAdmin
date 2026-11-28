import { notifySessionChanged } from '../backoffice/lib/navigation'
import { serverText } from '../backoffice/lib/i18n/serverText'

export type FileDownload = { blob: Blob; filename: string }

export class DownloadResponseError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export async function fetchFileDownload(url: string, fallback: string, request?: RequestInit): Promise<FileDownload> {
  const response = await fetch(url, { ...request, credentials: 'include' })
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) notifySessionChanged()
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null
    throw new DownloadResponseError(serverText(body?.error?.message), response.status)
  }
  const disposition = response.headers.get('Content-Disposition') ?? ''
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1]
  let filename = plain ?? fallback
  if (encoded) {
    try { filename = decodeURIComponent(encoded) } catch { /* Fall back to the plain filename. */ }
  }
  return { blob: await response.blob(), filename }
}

export function saveFileDownload({ blob, filename }: FileDownload) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  try {
    link.click()
  } finally {
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}
