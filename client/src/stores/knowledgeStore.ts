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

/** 编辑器草稿状态（§3.3：编辑后 500ms 防抖自动保存） */
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
  flushSave: () => Promise<void>

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

let debounceTimer: ReturnType<typeof setTimeout> | null = null

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
    await get().flushSave()
    // flushSave 后详情可能已刷新，重新取 page，避免写回旧 contentMd
    const page = get().details[courseId]?.pages.find((p) => p.id === pageId)
    if (!page) return
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
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      void get().flushSave()
    }, 500)
  },

  async flushSave() {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    const { draft } = get()
    if (!draft || draft.saveState === 'idle' || draft.saveState === 'saving') return
    set((s) => ({ draft: s.draft ? { ...s.draft, saveState: 'saving' } : null }))
    try {
      await knowledgeApi.updatePage(draft.pageId, {
        title: draft.title,
        contentMd: draft.contentMd,
        sectionTags: draft.sectionTags,
      })
      const courseId = get().selectedCourseId
      if (courseId) await get().refreshDetail(courseId)
      const cur = get().draft
      if (cur && cur.pageId === draft.pageId) {
        set({ draft: { ...cur, saveState: 'saved' } })
      }
    } catch {
      const cur = get().draft
      if (cur && cur.pageId === draft.pageId) {
        set({ draft: { ...cur, saveState: 'error' } })
      }
    }
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
    await get().flushSave()
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
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    set({ draft: null, selectedPageId: null })
    await get().refreshDetail(courseId)
  },

  async deleteCourse(id) {
    await knowledgeApi.deleteCourse(id)
    const { selectedCourseId } = get()
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
