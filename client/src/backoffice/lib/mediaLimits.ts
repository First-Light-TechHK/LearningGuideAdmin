import { useEffect, useState } from 'react'

import { boRequest } from './api'

export type MediaLimits = {
  imageBytes: number
  videoBytes: number
  audioBytes: number
  pdfBytes: number
  modelBytes: number
  chunkSize: number
}

let cached: MediaLimits | null = null
let pending: Promise<MediaLimits | null> | null = null

/** 每个页面只请求一次：上传上限是服务端配置，前端不能写死。 */
export function loadMediaLimits(): Promise<MediaLimits | null> {
  if (cached) return Promise.resolve(cached)
  if (!pending) {
    pending = boRequest<MediaLimits>('/api/backoffice/courses/media-limits').then((result) => {
      pending = null
      if (result.success && result.data) {
        cached = result.data
        return result.data
      }
      return null
    })
  }
  return pending
}

/** 读取服务端媒体大小上限；拿不到时返回 null，页面自行决定是否展示提示。 */
export function useMediaLimits(): MediaLimits | null {
  const [limits, setLimits] = useState<MediaLimits | null>(cached)
  useEffect(() => {
    if (cached) return
    let alive = true
    void loadMediaLimits().then((value) => {
      if (alive && value) setLimits(value)
    })
    return () => {
      alive = false
    }
  }, [])
  return limits
}
