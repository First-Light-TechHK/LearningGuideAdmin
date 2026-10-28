import { http } from './client'
import { notifySessionChanged } from '../backoffice/lib/navigation'

/** AI Tutor 接口封装（§5.2；chat-stream 为 SSE，在 aiStore 中经 fetch 处理） */

export type AiMode = 'LECTURE' | 'SOCRATIC' | 'ASSESSMENT'

/** 单模式的 AI 配置（2026-10-27：仅含 System Prompt；Welcome / Model 已提升为课程级共享） */
export interface AiModeView {
  /** 该模式自定义 System Prompt 覆盖值（null = 未自定义，前端回退该模式模板默认值） */
  systemPrompt: string | null
}

export interface AiConfigView {
  courseId: string
  /** 「测试所选 Release」id（2026-10-20 按 Release 维度；§5.2） */
  releaseId: string | null
  /** 「测试所选 Release」versionTag（§4.3.1 对话头部展示） */
  releaseTag: string | null
  /** 测试所选 Release 是否为上线版本（决定头部徽章 Testing / Live） */
  isLive: boolean
  llmProvider: string
  hasApiKey: boolean
  /** 是否对用户侧开放（课程级，§4.2.6） */
  online: boolean
  /** 课程级统一 Welcome Message（2026-10-27 起不再按模式区分） */
  welcomeMsg: string | null
  /** 课程级统一 LLM Model（2026-10-27 起不再按模式区分） */
  model: string
  /** Lecture 模式 System Prompt */
  lecture: AiModeView
  /** Socratic 模式 System Prompt */
  socratic: AiModeView
  /** Assessment 模式 System Prompt（2026-10-27 新增；仅配置，不参与学员端对话） */
  assessment: AiModeView
}

export interface PromptTemplate {
  id: string
  mode: string
  systemPrompt: string
  welcomeMsg: string
  isDefault: boolean
}

/** 「管理所有 online」弹窗的行视图（§4.2.6） */
export interface AiTutorListView {
  courseId: string
  title: string
  online: boolean
  /** Portal course.slug；null 表示还没和 Portal 课程对应 */
  externalId: string | null
  hasLiveRelease: boolean
  /** 学员端是否真的能看到入口（externalId && online && hasLiveRelease） */
  available: boolean
  blockedReason: 'not-synced' | 'no-live-release' | 'not-online' | null
}

export const aiApi = {
  listModels: () => http.get<string[]>('/ai/models').then((r) => r.data),
  listPrompts: () =>
    http.get<PromptTemplate[]>('/ai/prompts').then((r) => r.data),
  getConfig: (courseId: string) =>
    http.get<AiConfigView>(`/ai/config/${courseId}`).then((r) => r.data),
  /** 保存配置（§4.2.5；2026-10-27：System Prompt 按 mode 写入；Welcome / Model 写入课程级共享列） */
  saveConfig: (data: {
    courseId: string
    /** 写入的 Release：传当前界面上看到的版本，避免他人刚切换测试版本时写错版本 */
    releaseId?: string
    mode: AiMode
    llmProvider: string
    systemPrompt?: string
    welcomeMsg?: string
    llmModel: string
  }) => http.put<AiConfigView>('/ai/config', data).then((r) => r.data),
  /** 重置为默认模板（§4.2.4；2026-10-27：只重置该模式的 System Prompt，不动共享 Welcome / Model） */
  resetConfig: (courseId: string, mode: AiMode) =>
    http
      .post<AiConfigView>(`/ai/config/${courseId}/reset`, { mode })
      .then((r) => r.data),
  /** 设置 Online 状态（§4.2.6，开关即时生效） */
  setOnline: (courseId: string, online: boolean) =>
    http
      .put<AiConfigView>(`/ai/config/${courseId}/online`, { online })
      .then((r) => r.data),
  /** 设置「测试所选 Release」（§4.3.1/§5.2，2026-10-20 新增） */
  setActiveRelease: (courseId: string, releaseId: string) =>
    http
      .put<AiConfigView>(`/ai/config/${courseId}/active-release`, { releaseId })
      .then((r) => r.data),
  /** 全部 AI Tutor 及 Online 状态（§4.2.6，「管理所有 online」弹窗数据源） */
  listTutors: () =>
    http.get<AiTutorListView[]>('/ai/tutors').then((r) => r.data),
}

/** SSE 帧回调：delta 增量 / done 结束 / error 错误 */
export type ChatStreamEvent =
  | { delta: string }
  | { done: true }
  | { error: string }

/**
 * 流式对话（§4.4.1）：POST + fetch ReadableStream（EventSource 不支持 POST）。
 * 非 2xx 时后端返回标准错误信封（§5.3），解析其 message 抛出。
 */
export async function chatStream(
  payload: {
    courseId: string
    message: string
    mode: AiMode
    history: Array<{ role: 'user' | 'assistant'; content: string }>
  },
  onEvent: (e: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/ai/chat-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })

  if (!res.ok || !res.body) {
    if (res.status === 401) notifySessionChanged()
    let msg = `请求失败（HTTP ${res.status}）`
    try {
      const json = (await res.json()) as { error?: { message?: string } }
      if (json.error?.message) msg = json.error.message
    } catch {
      /* 非 JSON 错误体：使用默认消息 */
    }
    throw new Error(msg)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const line = frame.trim()
      if (!line.startsWith('data:')) continue
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as ChatStreamEvent)
      } catch {
        /* 忽略非 JSON 帧 */
      }
    }
  }
}
