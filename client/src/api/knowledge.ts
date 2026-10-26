import { http } from './client'

// ============ 类型（与后端 Prisma 模型字段对齐，§2） ============

export type SyncState = 'SYNCED' | 'STALE'

export interface PageNode {
  id: string
  title: string
  contentMd: string
  /** H1-H6 级标签映射：{ "h{n}-slug": ["tag1"] }（2026-10-16：移除页面级 tags） */
  sectionTags: Record<string, string[]> | null
  sortOrder: number
  syncState: SyncState
}

export interface Course {
  id: string
  title: string
  description: string | null
  externalId: string | null
  createdAt: string
  updatedAt: string
}

/** 2026-10-16 扁平化：原 Course.lessons → Course.pages（两级结构） */
export interface CourseDetail extends Course {
  pages: PageNode[]
}

export interface ReleaseSummary {
  id: string
  versionTag: string
  revisionNotes: string
  createdAt: string
  /** 是否为 Live（上线）版本（2026-10-20 语义：`currentReleaseId`） */
  isActive: boolean
  /** 是否为 AI Tutor 后台「测试所选 Release」（2026-10-20 新增；删除保护用） */
  isTestSelected: boolean
  /** 是否为当前编辑版本（2026-10-20 新增：`Course.editingReleaseId`；历史弹窗 `editing` 标识） */
  isEditing: boolean
}

export interface ReleaseDetail
  extends Omit<ReleaseSummary, 'isActive' | 'isTestSelected' | 'isEditing'> {
  courseId: string
  isActive?: boolean
  isTestSelected?: boolean
  isEditing?: boolean
  snapshotData: {
    pages: Array<{
      id: string
      title: string
      contentMd: string
      sectionTags: Record<string, string[]> | null
    }>
  }
}

/** 全局 Tag 词库项（§5.1.6 / §3.3.3 方案 B） */
export interface TagItem {
  id: string
  name: string
  color: string
}

// 外部源同步（§3.2.2 / §5.1.4）
export interface ExternalCourseStatus {
  externalId: string
  title: string
  localCourseId: string | null
  status: 'not_synced' | 'synced' | 'has_updates'
}

export interface SyncSummary {
  created: number
  /** 2026-10-26 新增：新建的课程数（映射表课程首次导入时无 lesson，需单独计数） */
  courseCreated: number
  /** 2026-10-22 标题同步新增：更新过的标题数（课程标题 + 课时标题） */
  updated: number
  staleMarked: number
  unchanged: boolean
}

// ============ 接口封装（§5.1 知识库相关） ============

export const knowledgeApi = {
  // 课程 CRUD（§5.1.1）
  listCourses: () =>
    http.get<Course[]>('/courses').then((r) => r.data),
  getCourse: (id: string) =>
    http.get<CourseDetail>(`/courses/${id}`).then((r) => r.data),
  updateCourse: (id: string, data: Partial<Course>) =>
    http.put<Course>(`/courses/${id}`, data).then((r) => r.data),
  deleteCourse: (id: string) =>
    http.delete(`/courses/${id}`).then((r) => r.data),

  // 页面 CRUD（§5.1.2，2026-10-16 扁平化：Page 直接挂 Course）
  createPage: (
    courseId: string,
    data: { title: string; contentMd: string; sectionTags?: Record<string, string[]> },
  ) => http.post<PageNode>(`/courses/${courseId}/pages`, data).then((r) => r.data),
  getPage: (id: string) =>
    http.get<PageNode>(`/pages/${id}`).then((r) => r.data),
  updatePage: (
    id: string,
    data: { title?: string; contentMd?: string; sectionTags?: Record<string, string[]>; sortOrder?: number },
  ) => http.put<PageNode>(`/pages/${id}`, data).then((r) => r.data),
  /** 批量重排 Course 下 Page 顺序（§5.1.2，2026-10-19 新增，左侧树拖拽排序用） */
  reorderPages: (courseId: string, orderedIds: string[]) =>
    http
      .put<{ orderedIds: string[] }>(`/courses/${courseId}/pages/reorder`, { orderedIds })
      .then((r) => r.data),
  deletePage: (id: string) =>
    http.delete(`/pages/${id}`).then((r) => r.data),

  // 全局 Tag 词库（§5.1.6 / §3.3.3 方案 B）
  listTags: () => http.get<TagItem[]>('/tags').then((r) => r.data),
  createTag: (name: string, color?: string) =>
    http.post<TagItem>('/tags', { name, color }).then((r) => r.data),
  updateTagColor: (name: string, color: string) =>
    http.put<TagItem>(`/tags/${encodeURIComponent(name)}`, { color }).then((r) => r.data),
  deleteTag: (name: string) =>
    http.delete(`/tags/${encodeURIComponent(name)}`).then((r) => r.data),

  // 发布与版本（§5.1.3）
  publish: (courseId: string, revisionNotes: string) =>
    http.post<ReleaseDetail>(`/courses/${courseId}/release`, { revisionNotes }).then((r) => r.data),
  listReleases: (courseId: string) =>
    http.get<ReleaseSummary[]>(`/courses/${courseId}/releases`).then((r) => r.data),
  getRelease: (releaseId: string) =>
    http.get<ReleaseDetail>(`/releases/${releaseId}`).then((r) => r.data),
  /** 删除版本（§3.4.5，2026-10-20 新增）：Live / 后台测试所选版本后端返回 409 */
  deleteRelease: (releaseId: string) =>
    http
      .delete<{ id: string; versionTag: string }>(`/releases/${releaseId}`)
      .then((r) => r.data),
  activateRelease: (courseId: string, releaseId: string) =>
    http
      .post<{ id: string; versionTag: string }>(
        `/courses/${courseId}/activate-release`,
        { releaseId },
      )
      .then((r) => r.data),
  /** Set Live（§3.4.4，2026-10-20 新增）：轻量切换上线指针，不重建草稿 */
  setLive: (courseId: string, releaseId: string) =>
    http
      .post<{ id: string; versionTag: string }>(`/courses/${courseId}/set-live`, {
        releaseId,
      })
      .then((r) => r.data),

  // 同步（§5.1.4 / §3.2.2 外部源接管模型）
  listExternalCourses: () =>
    http.get<ExternalCourseStatus[]>('/sync/external-courses').then((r) => r.data),
  syncStructure: (externalId: string) =>
    http.post<SyncSummary>('/sync/structure', { externalId }).then((r) => r.data),
  syncAll: (externalId: string) =>
    http.post<SyncSummary>('/sync/all', { externalId }).then((r) => r.data),

  // 文档转换（§5.1.5 / §3.2.3 / §10）：仅本地转换返回预览，不建页；
  // Import 经上方 createPage（§5.1.2）建页
  convertFile: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return http
      .post<ConvertedDocument>('/files/convert', form, { timeout: 60000 })
      .then((r) => r.data)
  },
}

/** §5.1.5 转换结果（title=文件名去扩展名） */
export interface ConvertedDocument {
  title: string
  markdown: string
}

/** §10.1 上传白名单（与 server/src/files/files.service.ts ALLOWED_EXTENSIONS 保持一致） */
export const UPLOAD_ALLOWED_EXTENSIONS = [
  '.txt',
  '.md',
  '.csv',
  '.pdf',
  '.docx',
  '.xlsx',
  '.html',
  '.xml',
  '.doc',
  '.xls',
] as const

/** §10.1 单文件大小上限 15MB */
export const UPLOAD_MAX_FILE_SIZE = 15 * 1024 * 1024
