import { create } from 'zustand'
import {
  aiApi,
  chatStream,
  type AiConfigView,
  type AiMode,
  type AiSegmentKey,
  type AiTutorListView,
  type PromptTemplate,
} from '../api/ai'
import { knowledgeApi, type Course, type ReleaseSummary } from '../api/knowledge'

/** §4.3.5 对话消息格式（role: user | ai） */
export interface ChatMessage {
  role: 'user' | 'ai'
  content: string
  createdAt: string
}

interface AiForm {
  systemPrompt: string
  welcomeMsg: string
  llmModel: string
}

interface AiState {
  courses: Course[]
  selectedCourseId: string | null
  /** 对话注入模式（仅 Lecture / Socratic；切换不重置会话，2026-10-27） */
  mode: AiMode
  /** 配置面板当前编辑的分段项（MAIN / Lecture / Socratic / Assessment），与对话 mode 解耦 */
  editMode: AiSegmentKey
  models: string[]
  templates: { LECTURE?: PromptTemplate; SOCRATIC?: PromptTemplate; ASSESSMENT?: PromptTemplate }
  config: AiConfigView | null
  form: AiForm
  /** 初始表单快照，用于检测未保存修改（§4.2.5 Unsaved changes） */
  initialForm: AiForm | null
  saving: boolean
  messages: ChatMessage[]
  streaming: boolean
  error: string | null
  /** 「管理所有 online」弹窗开关（§4.2.6） */
  tutorManagerOpen: boolean
  /** 全部 AI Tutor 列表（弹窗数据源） */
  tutors: AiTutorListView[]
  tutorsLoading: boolean
  /** 当前课程的 Release 列表（按发布时间倒序；头部 Release 选择器数据源，§4.3.1） */
  releases: ReleaseSummary[]

  init: () => Promise<void>
  selectCourse: (courseId: string) => Promise<void>
  /** 重新拉取当前课程的配置与 Release 列表（进入 AI Tutor 时刷新，避免 Release 列表过期） */
  refreshActiveCourse: () => Promise<void>
  setMode: (mode: AiMode) => void
  setEditMode: (mode: AiSegmentKey) => void
  patchForm: (patch: Partial<AiForm>) => void
  save: () => Promise<boolean>
  /** 把当前编辑模式的 System Prompt 恢复为模板默认值（只改编辑区，需 Save 才生效） */
  reset: () => void
  setOnline: (online: boolean) => Promise<void>
  setTutorOnline: (courseId: string, online: boolean) => Promise<void>
  openTutorManager: () => Promise<void>
  closeTutorManager: () => void
  /** 切换「测试所选 Release」（§4.3.1，持久化 aiTestReleaseId，并加载该 Release 的配置） */
  selectRelease: (releaseId: string) => Promise<void>
  /** Set Live：把测试所选 Release 设为上线版本（§3.4.4，轻量） */
  setLive: () => Promise<void>
  newChat: () => void
  send: (text: string) => Promise<void>
  isDirty: () => boolean
}

/** 会话按 courseId 隔离存 localStorage（2026-10-27：不再按模式隔离，模式切换不重置会话） */
const chatKey = (courseId: string) => `aitutor.chat.${courseId}`

function loadChat(courseId: string): ChatMessage[] | null {
  try {
    const raw = localStorage.getItem(chatKey(courseId))
    return raw ? (JSON.parse(raw) as ChatMessage[]) : null
  } catch {
    return null
  }
}

function persistChat(courseId: string, messages: ChatMessage[]) {
  try {
    localStorage.setItem(chatKey(courseId), JSON.stringify(messages))
  } catch {
    /* 存储满等异常不影响会话 */
  }
}

const now = () => new Date().toISOString()

/**
 * 构建表单（2026-10-29 调整）：
 * - MAIN：用户自定义值优先；null 时用后端传来的 defaultMainSystemPrompt（main.md 内容）填充 textarea
 *   （运行时 resolvePrompts 也兜底 DEFAULT_MAIN_PROMPT，这里前端展示保持一致）
 * - LECTURE/SOCRATIC/ASSESSMENT：自定义 > 该模式模板默认
 * - Welcome Message：课程级共享（config.welcomeMsg > lecture 模板默认欢迎语）
 * - LLM Model：课程级共享（config.model）
 */
function buildForm(
  config: AiConfigView | null,
  templates: AiState['templates'],
  editMode: AiSegmentKey,
): AiForm {
  if (editMode === 'MAIN') {
    return {
      // 用户自定义优先；null 时用 main.md 默认值填充（避免 textarea 空白）
      systemPrompt: config?.main.systemPrompt ?? config?.defaultMainSystemPrompt ?? '',
      welcomeMsg: config?.welcomeMsg || templates.LECTURE?.welcomeMsg || '',
      llmModel: config?.model || '',
    }
  }
  const t = templates[editMode]
  const view =
    editMode === 'LECTURE'
      ? config?.lecture
      : editMode === 'SOCRATIC'
        ? config?.socratic
        : config?.assessment
  return {
    systemPrompt: view?.systemPrompt || t?.systemPrompt || '',
    welcomeMsg: config?.welcomeMsg || templates.LECTURE?.welcomeMsg || '',
    llmModel: config?.model || '',
  }
}

export const useAiStore = create<AiState>((set, get) => ({
  courses: [],
  selectedCourseId: null,
  mode: 'LECTURE',
  editMode: 'LECTURE',
  models: [],
  templates: {},
  config: null,
  form: { systemPrompt: '', welcomeMsg: '', llmModel: '' },
  initialForm: null,
  saving: false,
  messages: [],
  streaming: false,
  error: null,
  tutorManagerOpen: false,
  tutors: [],
  tutorsLoading: false,
  releases: [],

  async init() {
    const [courses, models, prompts] = await Promise.all([
      knowledgeApi.listCourses(),
      aiApi.listModels(),
      aiApi.listPrompts(),
    ])
    const templates: AiState['templates'] = {}
    for (const p of prompts) {
      if (p.mode === 'LECTURE' || p.mode === 'SOCRATIC' || p.mode === 'ASSESSMENT') templates[p.mode] = p
    }
    set({ courses, models, templates })
    const currentId = get().selectedCourseId
    if (currentId && courses.some((course) => course.id === currentId)) {
      // 从 Knowledge 模块切回 AI Tutor 时 store 仍然存活，必须重新拉取当前课程的
      // config / Release 列表，否则新建的 Release 不会出现在版本下拉中。
      await get().refreshActiveCourse()
    } else if (courses.length > 0) {
      await get().selectCourse(courses[0].id)
    }
  },

  async refreshActiveCourse() {
    const { selectedCourseId } = get()
    if (!selectedCourseId) return
    try {
      const [config, releases] = await Promise.all([
        aiApi.getConfig(selectedCourseId),
        knowledgeApi.listReleases(selectedCourseId),
      ])
      if (get().isDirty()) {
        // 有未保存的配置修改：只刷新版本列表与配置元数据，不覆盖表单。
        set({ config, releases, error: null })
      } else {
        const { editMode, templates } = get()
        const form = buildForm(config, templates, editMode)
        set({
          config,
          releases,
          form,
          initialForm: { ...form },
          error: null,
        })
      }
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  async selectCourse(courseId) {
    // 流式回答进行中不切换课程，否则增量会写进另一门课的会话（QA 2026-10-27 A13）
    if (get().streaming) return
    const { editMode, templates } = get()
    try {
      const [config, releases] = await Promise.all([
        aiApi.getConfig(courseId),
        knowledgeApi.listReleases(courseId),
      ])
      const form = buildForm(config, templates, editMode)
      const stored = loadChat(courseId)
      set({
        selectedCourseId: courseId,
        config,
        releases,
        form,
        initialForm: { ...form },
        messages: stored ?? (form.welcomeMsg ? [{ role: 'ai', content: form.welcomeMsg, createdAt: now() }] : []),
        error: null,
      })
    } catch (e) {
      // 切换失败不抛（避免未捕获 rejection），错误经 error 状态呈现
      set({ error: (e as Error).message })
    }
  },

  /**
   * 切换对话注入模式（2026-10-27）：只更新 mode，不重置聊天会话、不切换表单。
   * 后续请求将以新模式发送，但当前会话消息保留。
   */
  setMode(mode) {
    set({ mode })
  },

  /**
   * 切换配置面板编辑分段项（MAIN / Lecture / Socratic / Assessment）：
   * 重新载入对应 System Prompt 到表单；Welcome / Model 为课程级共享，保持不变。
   */
  setEditMode(editMode) {
    const { config, templates } = get()
    const form = buildForm(config, templates, editMode)
    set({
      editMode,
      form,
      initialForm: { ...form },
    })
  },

  patchForm(patch) {
    set({ form: { ...get().form, ...patch } })
  },

  isDirty() {
    const { form, initialForm } = get()
    if (!initialForm) return false
    return (
      form.systemPrompt !== initialForm.systemPrompt ||
      form.welcomeMsg !== initialForm.welcomeMsg ||
      form.llmModel !== initialForm.llmModel
    )
  },

  async save() {
    const { selectedCourseId, form, editMode, config, templates } = get()
    if (!selectedCourseId) return false
    set({ saving: true })
    try {
      // 2026-10-29：System Prompt 按 editMode 写入；Welcome / Model 写入课程级共享列。
      // 所有分段项（含 MAIN）都做「值等于默认值则存空串」优化：
      // - MAIN 默认值 = config.defaultMainSystemPrompt（main.md 文件内容）
      // - 其他模式默认值 = 模板默认值
      // 这样数据库里只有用户自定义值才被固化，main.md 后续更新时自动跟随。
      const isMain = editMode === 'MAIN'
      const mainDefault = config?.defaultMainSystemPrompt ?? ''
      const payload: Parameters<typeof aiApi.saveConfig>[0] = {
        courseId: selectedCourseId,
        releaseId: config?.releaseId ?? undefined,
        mode: editMode,
        llmProvider: 'openrouter',
        llmModel: form.llmModel,
        systemPrompt: isMain
          ? form.systemPrompt === mainDefault ? '' : form.systemPrompt
          : form.systemPrompt === templates[editMode]?.systemPrompt
            ? ''
            : form.systemPrompt,
        welcomeMsg: form.welcomeMsg === templates.LECTURE?.welcomeMsg ? '' : form.welcomeMsg,
      }
      const next = await aiApi.saveConfig(payload)
      set({
        config: next,
        initialForm: { ...form },
        error: null,
      })
      return true
    } catch (e) {
      set({ error: (e as Error).message })
      return false
    } finally {
      set({ saving: false })
    }
  },

  reset() {
    const { editMode, templates, form, config } = get()
    // 2026-10-29：所有分段项 Reset 都恢复为各自默认值（前端显示层恢复）
    // - MAIN 恢复为 main.md 文件默认值（config.defaultMainSystemPrompt）
    // - 其他模式恢复为模板默认值
    // Save 后才真正落库为空串，运行时走文件兜底
    const defaultPrompt = editMode === 'MAIN'
      ? (config?.defaultMainSystemPrompt ?? '')
      : templates[editMode as AiMode]?.systemPrompt ?? ''
    set({ form: { ...form, systemPrompt: defaultPrompt } })
  },

  /** §4.2.6 顶部卡片 Online 开关：切换即时生效（当前选中课程） */
  async setOnline(online) {
    const { selectedCourseId, tutors } = get()
    if (!selectedCourseId) return
    try {
      const next = await aiApi.setOnline(selectedCourseId, online)
      set({
        config: next,
        // 同步弹窗列表中同一课程行的状态（若已加载）
        tutors: tutors.map((t) =>
          t.courseId === selectedCourseId ? { ...t, online: next.online } : t,
        ),
        error: null,
      })
    } catch (e) {
      set({ error: (e as Error).message })
      throw e
    }
  },

  /** §4.2.6 弹窗表格行内切换：点即改即存；若为当前课程，同步顶部卡片开关 */
  async setTutorOnline(courseId, online) {
    const next = await aiApi.setOnline(courseId, online)
    set((s) => ({
      tutors: s.tutors.map((t) => (t.courseId === courseId ? { ...t, online: next.online } : t)),
      config: s.selectedCourseId === courseId ? next : s.config,
    }))
  },

  /** 打开「管理所有 online」弹窗并拉取列表（§4.2.6） */
  async openTutorManager() {
    set({ tutorManagerOpen: true, tutorsLoading: true })
    try {
      const tutors = await aiApi.listTutors()
      set({ tutors, tutorsLoading: false })
    } catch (e) {
      set({ tutorsLoading: false, error: (e as Error).message })
    }
  },

  closeTutorManager() {
    set({ tutorManagerOpen: false })
  },

  /** §4.3.1 头部 Release 选择器：切换测试所选 Release 并加载其已保存配置（按当前 editMode） */
  async selectRelease(releaseId) {
    const { selectedCourseId, streaming } = get()
    if (!selectedCourseId || streaming) return
    try {
      const next = await aiApi.setActiveRelease(selectedCourseId, releaseId)
      const { editMode, templates } = get()
      const form = buildForm(next, templates, editMode)
      set({ config: next, form, initialForm: { ...form }, error: null })
    } catch (e) {
      set({ error: (e as Error).message })
      throw e
    }
  },

  /** §3.4.4 Set Live：把测试所选 Release 设为上线版本（轻量），并刷新配置/列表 */
  async setLive() {
    const { selectedCourseId, config } = get()
    if (!selectedCourseId || !config?.releaseId) return
    try {
      await knowledgeApi.setLive(selectedCourseId, config.releaseId)
      const [next, releases] = await Promise.all([
        aiApi.getConfig(selectedCourseId),
        knowledgeApi.listReleases(selectedCourseId),
      ])
      set({ config: next, releases, error: null })
    } catch (e) {
      set({ error: (e as Error).message })
      throw e
    }
  },

  newChat() {
    const { selectedCourseId, form, streaming } = get()
    if (!selectedCourseId || streaming) return
    const fresh = form.welcomeMsg
      ? [{ role: 'ai' as const, content: form.welcomeMsg, createdAt: now() }]
      : []
    set({ messages: fresh, error: null })
    persistChat(selectedCourseId, fresh)
  },

  async send(text) {
    const { selectedCourseId, mode, messages, streaming } = get()
    const content = text.trim()
    if (!selectedCourseId || !content || streaming) return

    const history = messages
      .filter((m) => m.content.trim())
      .slice(-10)
      .map((m) => ({ role: m.role === 'ai' ? ('assistant' as const) : ('user' as const), content: m.content }))

    let msgs: ChatMessage[] = [
      ...messages,
      { role: 'user', content, createdAt: now() },
      { role: 'ai', content: '', createdAt: now() },
    ]
    set({ messages: msgs, streaming: true, error: null })
    // 会话按课程隔离：增量先累积在本次请求自己的消息列表里，只有仍停留在发起课程时才写回界面，
    // 落盘也只写发起课程的会话（QA 2026-10-27 A13）
    const stillHere = () => get().selectedCourseId === selectedCourseId

    try {
      await chatStream(
        { courseId: selectedCourseId, message: content, mode, history },
        (e) => {
          if ('delta' in e) {
            const last = msgs[msgs.length - 1]
            msgs = [...msgs.slice(0, -1), { ...last, content: last.content + e.delta }]
            if (stillHere()) set({ messages: msgs })
          } else if ('error' in e) {
            if (stillHere()) set({ error: e.error })
          }
        },
      )
    } catch (e) {
      if (stillHere()) set({ error: (e as Error).message })
    } finally {
      // 落盘当前会话（§4.3.2：localStorage 持久化上次聊天）
      const aiEmpty = msgs.length > 0 && msgs[msgs.length - 1].role === 'ai' && !msgs[msgs.length - 1].content
      persistChat(selectedCourseId, aiEmpty ? msgs.slice(0, -1) : msgs)
      set({ streaming: false })
    }
  },
}))
