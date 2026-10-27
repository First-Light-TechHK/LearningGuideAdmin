import { create } from 'zustand'
import {
  knowledgeApi,
  type Course,
  type CourseDetail,
  type ExternalCourseStatus,
  type PageNode,
  type SyncSummary,
  type TagItem,
} from '../api/knowledge'

/** 编辑器草稿状态（§3.3：编辑期间每 5 分钟自动保存，离开编辑页/切页立即保存） */
export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

interface PageDraft {
  pageId: string
  title: string
  contentMd: string
  /** H1-H6 级标签映射：{ "h{n}-slug": ["tag1"] } */
  sectionTags: Record<string, string[]>
  saveState: SaveState
}

interface KnowledgeState {
  courses: Course[]
  details: Record<string, CourseDetail>
  expandedCourseIds: string[]
  selectedCourseId: string | null
  selectedPageId: string | null
  lastPageIdByCourse: Record<string, string>
  draft: PageDraft | null
  loading: boolean

  // 外部源同步（§3.2.2）
  externalCourses: ExternalCourseStatus[]
  externalCoursesError: string | null
  selectedExternalId: string | null
  syncing: boolean

  // 全局 Tag 词库（§3.3.3 方案 B）
  tags: TagItem[]
  /** 词库加载中标志，防止多个 TagManager 同时发起请求 */
  tagsLoading: boolean

  loadCourses: () => Promise<void>
  toggleExpand: (courseId: string) => Promise<void>
  selectPage: (courseId: string, pageId: string) => Promise<void>
  editDraft: (patch: Partial<Pick<PageDraft, 'title' | 'contentMd' | 'sectionTags'>>) => void
  /** 立即保存；返回 false 表示失败（调用方必须阻断切页/切课程等后续动作） */
  flushSave: () => Promise<boolean>

  deleteCourse: (id: string) => Promise<void>
  createPage: (courseId: string, title: string) => Promise<void>
  deletePage: (courseId: string, pageId: string) => Promise<void>
  /** 批量重排 Course 下 Page 顺序（§5.1.2，2026-10-19：左侧树拖拽排序） */
  reorderPages: (courseId: string, orderedIds: string[]) => Promise<void>

  refreshDetail: (courseId: string) => Promise<void>

  loadExternalCourses: () => Promise<void>
  selectExternal: (externalId: string) => Promise<void>
  runSync: (mode: 'structure' | 'all') => Promise<SyncSummary>

  /** 弹窗 Import（§3.2.3 两步流程）：以转换预览内容建页 → 刷新树并选中新页 */
  importDocument: (
    courseId: string,
    doc: { title: string; contentMd: string },
  ) => Promise<void>

  afterActivateRelease: (courseId: string) => Promise<void>

  /** TOC 点击：设置目标 heading 文本，PageEditor 监听后滚动定位 */
  tocScrollTarget: string | null
  scrollToHeading: (heading: string) => void
  clearTocScrollTarget: () => void

  /** Tag 词库：加载 / 新增 / 删除 / 改色 */
  loadTags: () => Promise<void>
  createTag: (name: string, color?: string) => Promise<TagItem>
  deleteTag: (name: string) => Promise<void>
  updateTagColor: (name: string, color: string) => Promise<void>
}

/**
 * 自动保存节奏（2026-10-29 用户指定）：
 * - 编辑期间每 5 分钟自动保存一次；
 * - 离开编辑页 / 切换页面 / 切换课程时立即保存（flushSave）。
 */
const AUTOSAVE_INTERVAL_MS = 5 * 60 * 1000
let autosaveTimer: ReturnType<typeof setInterval> | null = null
/** 当前在飞的保存请求（串行化，防止乱序 PUT 覆盖新内容） */
let savingPromise: Promise<boolean> | null = null

function stopAutosave() {
  if (autosaveTimer) {
    clearInterval(autosaveTimer)
    autosaveTimer = null
  }
}

function startAutosave() {
  if (autosaveTimer) return
  autosaveTimer = setInterval(() => {
    void useKnowledgeStore.getState().flushSave()
  }, AUTOSAVE_INTERVAL_MS)
}

/**
 * 浏览器刷新/关闭时的本地草稿兜底（2026-10-29）。
 * 由 store 统一持有 key 与清理职责：保存成功、切页、激活版本、删除页时都必须清掉，
 * 否则陈旧快照会在下次打开页面时被误判为「未保存草稿」并覆盖更新的服务端内容。
 */
export const localDraftKey = (pageId: string) => `kg.draft.${pageId}`

export function clearLocalDraft(pageId: string | null | undefined) {
  if (!pageId) return
  try {
    localStorage.removeItem(localDraftKey(pageId))
  } catch {
    /* 本地存储不可用：忽略 */
  }
}

/**
 * 编辑器注册的「把当前文档立即提交进 draft」回调（2026-10-29）。
 * 编辑器文本即 contentMd，提交只是取一次字符串（300ms 防抖）；切页/保存前必须调用它，
 * 否则会保存旧内容、丢失最后几次输入。
 */
let draftFlusher: (() => void) | null = null

export function registerDraftFlusher(fn: (() => void) | null) {
  draftFlusher = fn
}

export const useKnowledgeStore = create<KnowledgeState>((set, get) => ({
  courses: [],
  details: {},
  expandedCourseIds: [],
  selectedCourseId: null,
  selectedPageId: null,
  lastPageIdByCourse: {},
  draft: null,
  loading: false,

  externalCourses: [],
  externalCoursesError: null,
  selectedExternalId: null,
  syncing: false,

  tags: [],
  tagsLoading: false,

  async loadCourses() {
    set({ loading: true })
    try {
      const courses = await knowledgeApi.listCourses()
      set({ courses })
      const sel = get().selectedCourseId
      if (sel && get().details[sel]) {
        await get().refreshDetail(sel)
      }
    } finally {
      set({ loading: false })
    }
  },

  async toggleExpand(courseId) {
    const { expandedCourseIds, details } = get()
    if (expandedCourseIds.includes(courseId)) {
      set({ expandedCourseIds: expandedCourseIds.filter((id) => id !== courseId) })
      return
    }
    set({ expandedCourseIds: [...expandedCourseIds, courseId] })
    if (!details[courseId]) {
      const detail = await knowledgeApi.getCourse(courseId)
      set((s) => ({ details: { ...s.details, [courseId]: detail } }))
    }
  },

  async selectPage(courseId, pageId) {
    // 2026-10-22 修复：重复点击当前 Page 不重置 draft，避免编辑器反复 replaceBlocks
    // 导致目录/正文出现重复 Heading。
    if (
      get().selectedCourseId === courseId &&
      get().selectedPageId === pageId &&
      get().draft
    )
      return
    // 保存失败必须阻断切页，否则整页编辑内容会被新 draft 覆盖而丢失
    if (!(await get().flushSave())) return
    // 收尾：把等待窗口内的新输入再提交并保存（最多 3 次有界重试），仍不干净则放弃切换
    for (let attempt = 0; attempt < 3; attempt++) {
      draftFlusher?.()
      if (!(await get().flushSave())) return
      const st = get().draft
      if (!st || st.saveState === 'saved' || st.saveState === 'idle') break
      if (attempt === 2) return
      await new Promise((r) => setTimeout(r, 120))
    }
    // 最后一刻再做一次提交：覆盖「最后一次 flush 与 set 之间」的输入（同步、零成本）
    draftFlusher?.()
    const leaving = get().draft
    if (leaving && leaving.saveState !== 'saved' && leaving.saveState !== 'idle') return
    // 保存可能真的写了库并刷新了详情：必须在保存之后再取 page，避免用旧 contentMd 作为新页基线
    const page = get().details[courseId]?.pages.find((p) => p.id === pageId)
    if (!page) return
    clearLocalDraft(leaving?.pageId)
    set({
      selectedCourseId: courseId,
      selectedPageId: pageId,
      lastPageIdByCourse: { ...get().lastPageIdByCourse, [courseId]: pageId },
      draft: {
        pageId,
        title: page.title,
        contentMd: page.contentMd,
        sectionTags: page.sectionTags ?? {},
        saveState: 'idle',
      },
    })
  },

  editDraft(patch) {
    const { draft } = get()
    if (!draft) return
    set({
      draft: { ...draft, ...patch, saveState: 'dirty' },
    })
    // 2026-10-29：不再每次编辑都防抖保存（1 次全量序列化 + 1 次写库太贵），
    // 改为编辑期间每 5 分钟自动保存；离开编辑页/切页时由 flushSave 立即保存。
    startAutosave()
  },

  /**
   * 立即保存当前草稿（2026-10-29 重写）。
   * - 返回 boolean：调用方（切页/切课程/发布）必须先判断，失败时阻断后续动作，避免静默丢稿；
   * - 用「请求快照」判定是否把状态置为 saved：请求期间用户又改了内容 → 保持 dirty 并重启自动保存，
   *   不会出现「标签显示已保存但服务器是旧内容」；
   * - 同一时刻只允许一个写入在飞（savingPromise 串行化），杜绝乱序 PUT 覆盖新内容。
   */
  async flushSave(): Promise<boolean> {
    // 先让编辑器把尚未提交的最新文本写进 draft
    draftFlusher?.()

    // 已有请求在飞：等它结束，再按最新内容决定是否补一次保存
    if (savingPromise) {
      const ok = await savingPromise
      if (!ok) return false
      return get().flushSave()
    }

    const { draft } = get()
    // idle/saved 无需再写库；error 允许在下次 flush 时重试。
    // （'saving' 分支不可达：saving 期间 savingPromise 必非空，已在上面 await 处理）
    if (!draft || draft.saveState === 'idle' || draft.saveState === 'saved') {
      stopAutosave()
      return true
    }

    stopAutosave()
    const snapshot = {
      pageId: draft.pageId,
      title: draft.title,
      contentMd: draft.contentMd,
      sectionTags: draft.sectionTags,
    }
    set((s) => ({ draft: s.draft ? { ...s.draft, saveState: 'saving' } : null }))

    savingPromise = (async () => {
      try {
        await knowledgeApi.updatePage(snapshot.pageId, {
          title: snapshot.title,
          contentMd: snapshot.contentMd,
          sectionTags: snapshot.sectionTags,
        })
        const courseId = get().selectedCourseId
        if (courseId) await get().refreshDetail(courseId)
        return true
      } catch {
        return false
      }
    })()
    const ok = await savingPromise
    savingPromise = null

    const cur = get().draft
    if (cur && cur.pageId === snapshot.pageId) {
      if (!ok) {
        set({ draft: { ...cur, saveState: 'error' } })
        return false
      }
      // 请求期间内容是否又变了（变了就不能标 saved）
      const unchanged =
        cur.contentMd === snapshot.contentMd &&
        cur.title === snapshot.title &&
        JSON.stringify(cur.sectionTags) === JSON.stringify(snapshot.sectionTags)
      set({ draft: { ...cur, saveState: unchanged ? 'saved' : 'dirty' } })
      if (unchanged) {
        // 已成功保存：本地兜底草稿必须清除，避免下次打开被误判为「未保存」
        clearLocalDraft(snapshot.pageId)
      } else {
        startAutosave()
      }
    }
    return true
  },

  async loadExternalCourses() {
    try {
      const externalCourses = await knowledgeApi.listExternalCourses()
      set({ externalCourses, externalCoursesError: null })
    } catch (e) {
      set({ externalCourses: [], externalCoursesError: (e as Error).message })
    }
  },

  async selectExternal(externalId) {
    if (get().selectedExternalId === externalId) return
    // 与 selectPage 对齐：先提交最新文本、保存失败或仍有未落库内容则阻断，成功后再清本地草稿
    if (!(await get().flushSave())) return
    for (let attempt = 0; attempt < 3; attempt++) {
      draftFlusher?.()
      if (!(await get().flushSave())) return
      const st = get().draft
      if (!st || st.saveState === 'saved' || st.saveState === 'idle') break
      if (attempt === 2) return
      await new Promise((r) => setTimeout(r, 120))
    }
    draftFlusher?.()
    const leaving = get().draft
    if (leaving && leaving.saveState !== 'saved' && leaving.saveState !== 'idle') return
    clearLocalDraft(leaving?.pageId)
    set({ selectedExternalId: externalId, selectedPageId: null, draft: null })
  },

  async runSync(mode) {
    const { selectedExternalId } = get()
    if (!selectedExternalId) throw new Error('未选择同步目标')
    set({ syncing: true })
    try {
      const summary =
        mode === 'structure'
          ? await knowledgeApi.syncStructure(selectedExternalId)
          : await knowledgeApi.syncAll(selectedExternalId)
      await get().loadCourses()
      await get().loadExternalCourses()
      const local = get().externalCourses.find(
        (e) => e.externalId === selectedExternalId,
      )
      if (local?.localCourseId) {
        await get().refreshDetail(local.localCourseId)
      }
      return summary
    } finally {
      set({ syncing: false })
    }
  },

  async importDocument(courseId, doc) {
    const page = await knowledgeApi.createPage(courseId, {
      title: doc.title,
      contentMd: doc.contentMd,
    })
    await get().refreshDetail(courseId)
    await get().selectPage(courseId, page.id)
  },

  async afterActivateRelease(courseId) {
    // 2026-10-19 既有裁决：激活版本后服务端已用快照整体替换可编辑内容，
    // 必须丢弃草稿（不得回写激活前的旧内容），并清除本地兜底草稿。
    const leavingPageId = get().draft?.pageId ?? null
    stopAutosave()
    set({ draft: null, selectedPageId: null })
    clearLocalDraft(leavingPageId)
    await get().refreshDetail(courseId)
  },

  async deleteCourse(id) {
    await knowledgeApi.deleteCourse(id)
    const { selectedCourseId } = get()
    // 删除课程会连带删除其页面：清掉当前页本地兜底草稿，避免下次打开误提示恢复
    if (selectedCourseId === id) clearLocalDraft(get().draft?.pageId)
    const details = { ...get().details }
    delete details[id]
    set({
      details,
      ...(selectedCourseId === id
        ? { selectedCourseId: null, selectedPageId: null, draft: null }
        : {}),
    })
    await get().loadCourses()
  },

  async createPage(courseId, title) {
    await knowledgeApi.createPage(courseId, { title, contentMd: `# ${title}\n` })
    await get().refreshDetail(courseId)
  },

  async deletePage(courseId, pageId) {
    await knowledgeApi.deletePage(pageId)
    clearLocalDraft(pageId)
    await get().refreshDetail(courseId)
    if (get().selectedPageId === pageId) {
      set({ draft: null, selectedPageId: null })
    }
  },

  async reorderPages(courseId, orderedIds) {
    // 乐观更新：先按目标顺序重排本地 pages（sortOrder 与下标对齐），失败再回滚
    const detail = get().details[courseId]
    if (detail) {
      const byId = new Map(detail.pages.map((p) => [p.id, p]))
      const pages: PageNode[] = []
      orderedIds.forEach((id, index) => {
        const p = byId.get(id)
        if (p) pages.push({ ...p, sortOrder: index })
      })
      set((s) => ({ details: { ...s.details, [courseId]: { ...detail, pages } } }))
    }
    try {
      await knowledgeApi.reorderPages(courseId, orderedIds)
    } catch (e) {
      await get().refreshDetail(courseId)
      throw e
    }
  },

  async refreshDetail(courseId) {
    const detail = await knowledgeApi.getCourse(courseId)
    set((s) => ({ details: { ...s.details, [courseId]: detail } }))
  },

  tocScrollTarget: null,
  scrollToHeading(heading) {
    set({ tocScrollTarget: heading })
  },
  clearTocScrollTarget() {
    set({ tocScrollTarget: null })
  },

  async loadTags() {
    // 防止多个 TagManager 同时发起请求（并发去重）
    if (get().tagsLoading) return
    set({ tagsLoading: true })
    try {
      const tags = await knowledgeApi.listTags()
      set({ tags })
    } catch {
      // 加载失败不抛错，TagManager 仍可用（新 tag 走 createTag）
    } finally {
      set({ tagsLoading: false })
    }
  },
  async createTag(name, color) {
    const tag = await knowledgeApi.createTag(name, color)
    await get().loadTags()
    return tag
  },
  async deleteTag(name) {
    await knowledgeApi.deleteTag(name)
    // 删除后刷新词库
    await get().loadTags()
  },
  async updateTagColor(name, color) {
    await knowledgeApi.updateTagColor(name, color)
    await get().loadTags()
  },
}))

/** 从树数据中按 pageId 找 Page */
export function findPage(detail: CourseDetail | undefined, pageId: string): PageNode | undefined {
  return detail?.pages.find((p) => p.id === pageId)
}
