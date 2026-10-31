import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { useEmployee } from '../ShellRoute'
import type { CourseList } from '../contracts/course'
import { boRequest } from '../lib/api'
import { t } from '../lib/i18n/messages'
import { useLocale } from '../lib/navigation'
import { MENU_SEGMENT } from '../rbac/permissions'
import { MenuGuard } from './ModulePages'

type JobView = {
  jobId: string
  status: string
  stage?: string | null
  progress: number
  error: string | null
  courseId: string | null
  package: { courseCode: string; lessons: number; mediaFiles: number; incomplete: boolean } | null
  report: { errors: Array<{ code: string; message: string }>; warnings: Array<{ code: string; message: string }> }
}

type UploadResult<T> = { success: true; data: T } | { success: false; error: string; errorMessage?: string }

/**
 * 带上传进度的文件上传（fetch 无法获取上传进度，改用 XHR 的 upload.onprogress）。
 * error 为稳定码：NETWORK_ERROR / ABORTED / 或后端信封里的错误码。
 */
function uploadFileWithProgress<T>(
  url: string,
  file: Blob,
  onProgress: (pct: number) => void,
  opts?: { field?: string; method?: 'POST' | 'PUT' },
): Promise<UploadResult<T>> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.open(opts?.method ?? 'POST', url)
    xhr.withCredentials = true
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText) as { success?: boolean; data?: T; error?: { code?: string; message?: string } | null }
        if (body?.success === true) resolve({ success: true, data: body.data as T })
        else resolve({ success: false, error: body?.error?.code ?? `HTTP_${xhr.status}`, errorMessage: body?.error?.message ?? `HTTP ${xhr.status}` })
      } catch {
        // 响应体不是 JSON 信封（多为网关 5xx/504 或单请求被边缘切断），把真实状态码带出来便于定位
        resolve({ success: false, error: `HTTP_${xhr.status}`, errorMessage: `HTTP ${xhr.status}${xhr.statusText ? ' ' + xhr.statusText : ''}` })
      }
    }
    xhr.onerror = () => resolve({ success: false, error: 'NETWORK_ERROR' })
    xhr.onabort = () => resolve({ success: false, error: 'ABORTED' })
    const form = new FormData()
    form.append(opts?.field ?? 'file', file)
    xhr.send(form)
  })
}

function uploadErrorText(code: string, detail?: string): string {
  if (code === 'NETWORK_ERROR' || code === 'ABORTED') {
    return '上传中断（文件较大或服务被重启/网络中断）。请确认本地服务稳定后重试。'
  }
  if (detail && detail.trim()) return `导入失败：${detail}`
  return `导入失败：${code}`
}

/**
 * Course Overview（PRD CM01）：列表 + Category 筛选 + 新建 / 从包导入 / Operations 入口。
 * Publish / 版本 / 导入到已有课程在课程详情的 Versions 区完成。
 */
export function CourseManagementPage() {
  const locale = useLocale()
  return (
    <MenuGuard menu="course">
      <CourseManagementInner locale={locale} />
    </MenuGuard>
  )
}

function CourseManagementInner({ locale }: { locale: ReturnType<typeof useLocale> }) {
  const employee = useEmployee()
  const navigate = useNavigate()
  const L = (zh: string, en: string) => (locale.startsWith('zh') ? zh : en)
  const canPublish = employee.role === 'ADMIN' || employee.role === 'OPERATION_ADMIN'
  const [list, setList] = useState<CourseList | null>(null)
  const [loading, setLoading] = useState(false)
  const [importJob, setImportJob] = useState<JobView | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [uploadPct, setUploadPct] = useState<number | null>(null)
  const [categoryId, setCategoryId] = useState('')
  const [catalogCategories, setCatalogCategories] = useState<Array<{ id: string; name: string }>>([])
  const [createCategoryId, setCreateCategoryId] = useState('')
  const [createMode, setCreateMode] = useState('VIDEO_AND_TEXT')
  const [createLanguage, setCreateLanguage] = useState<string>(locale)
  const [exportingId, setExportingId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const rawFileRef = useRef<HTMLInputElement | null>(null)
  const openCourse = (id: string) => navigate(`/${locale}/course/${id}`)

  const load = useCallback(async () => {
    setLoading(true)
    const query = new URLSearchParams({ page: '1', pageSize: '50' })
    if (categoryId) query.set('categoryId', categoryId)
    const result = await boRequest<CourseList>(`/api/backoffice/courses?${query.toString()}`)
    setLoading(false)
    if (result.success) setList(result.data)
    else setMessage(t(locale, 'common.sessionUnavailable'))
  }, [locale, categoryId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void (async () => {
      const result = await boRequest<Array<{ id: string; name: string }>>(`/api/backoffice/courses/categories`)
      if (result.success) setCatalogCategories(result.data)
    })()
  }, [])

  const categories = useMemo(() => {
    const map = new Map<string, string>()
    for (const course of list?.courses ?? []) {
      if (course.category) map.set(course.category.id, course.category.name)
    }
    return [...map.entries()]
  }, [list])

  async function createCourse(form: FormData) {
    setBusy(true)
    const result = await boRequest<{ id: string }>('/api/backoffice/courses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: String(form.get('code')),
        title: String(form.get('title')),
        slug: String(form.get('slug') || ''),
        language: createLanguage,
        defaultContentLanguage: createLanguage,
        learningLanguages: [createLanguage],
        learningMode: createMode,
        categoryId: createCategoryId || null,
      }),
    })
    setBusy(false)
    if (result.success) {
      setShowCreate(false)
      await load()
      openCourse(result.data.id)
    } else setMessage(L(`新建失败：${result.error}`, `Create failed: ${result.error}`))
  }

  // 轮询后台导入作业，直到校验完成 / 失败 / 取消（异步导入：上传即返回，处理在后台）
  async function pollImportJob(initial: JobView): Promise<JobView> {
    const terminal = new Set(['AWAITING_CONFIRM', 'FAILED', 'CANCELLED'])
    let job = initial
    for (let i = 0; i < 600 && !terminal.has(job.status); i++) {
      await new Promise((r) => setTimeout(r, 1500))
      const poll = await boRequest<JobView>(`/api/backoffice/courses/import/${job.jobId}`)
      if (!poll.success) {
        setMessage(uploadErrorText(poll.error, poll.message))
        return job
      }
      job = poll.data
      if (job.status === 'VALIDATING') {
        setMessage(L(`正在后台解析并校验素材…（${job.progress ?? 0}%）`, `Parsing and validating materials… (${job.progress ?? 0}%)`))
      }
    }
    return job
  }

  async function onPickRawFile(file: File) {
    setBusy(true)
    setMessage(null)
    setUploadPct(0)
    // 大素材包单次 POST 会被 CloudFront/App Runner 中途切断，改为分块上传：
    // 先开会话拿 jobId + 块大小，再把文件切成小块逐块 PUT，最后 complete。
    const init = await boRequest<{ jobId: string; chunkSize: number }>(
      `/api/backoffice/courses/import/raw/session`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, bytesTotal: file.size }),
      },
    )
    if (!init.success) {
      setBusy(false)
      setMessage(uploadErrorText(init.error, init.message))
      return
    }
    const { jobId } = init.data
    const total = file.size
    const size = Math.max(1, init.data.chunkSize || 5 * 1024 * 1024)
    let sent = 0
    for (let index = 0; sent < total; index++) {
      const start = index * size
      const blob = file.slice(start, Math.min(start + size, total))
      const res = await uploadFileWithProgress<{ jobId: string; progress: number }>(
        `/api/backoffice/courses/import/${jobId}/chunk?index=${index}`,
        blob,
        (pct) => setUploadPct(Math.min(99, Math.round(((sent + (blob.size * pct) / 100) / total) * 100))),
        { field: 'chunk', method: 'PUT' },
      )
      if (!res.success) {
        setBusy(false)
        setUploadPct(null)
        setMessage(uploadErrorText(res.error, res.errorMessage))
        return
      }
      sent += blob.size
      setUploadPct(Math.min(99, Math.round((sent / total) * 100)))
    }
    setUploadPct(null)
    setMessage(L('上传完成，正在后台解析并校验…', 'Uploaded. Parsing and validating in the background…'))
    const comp = await boRequest<JobView>(`/api/backoffice/courses/import/${jobId}/complete`, { method: 'POST' })
    if (!comp.success) {
      setBusy(false)
      setMessage(uploadErrorText(comp.error, comp.message))
      return
    }
    const job = await pollImportJob(comp.data)
    setBusy(false)
    setImportJob(job)
    if (job.status === 'FAILED') setMessage(job.error ? `导入失败：${job.error}` : L('导入校验失败。', 'Import validation failed.'))
    else if (job.status === 'AWAITING_CONFIRM') setMessage(L('原始素材已转换。确认前请先查看校验结果。', 'Raw materials converted. Review validation before confirming.'))
  }

  async function importFromServerFolder() {
    const dir = window.prompt(L('仓库内素材目录（相对仓库根）', 'Server material folder (relative to repo root)'), 'docs/modeling-life')
    if (dir === null) return
    setBusy(true)
    setMessage(null)
    const result = await boRequest<JobView>(`/api/backoffice/courses/import/local`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir }),
    })
    if (!result.success) {
      setBusy(false)
      setMessage(uploadErrorText(result.error, result.message))
      return
    }
    setMessage(L('已提交，正在后台解析素材…', 'Submitted. Parsing materials in the background…'))
    const job = await pollImportJob(result.data)
    setBusy(false)
    setImportJob(job)
    if (job.status === 'FAILED') setMessage(job.error ? `导入失败：${job.error}` : L('导入校验失败。', 'Import validation failed.'))
    else setMessage(L('已从本地目录解析素材，请在校验信息中确认后导入。', 'Parsed materials from the server folder. Review validation before confirming.'))
  }

  async function exportCourse(course: CourseList['courses'][number]) {
    setExportingId(course.id)
    setMessage(null)
    const startExport = (version?: string) =>
      boRequest<{ jobId: string; fileName?: string }>(`/api/backoffice/courses/${course.id}/export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(version ? { version } : {}),
      })
    // 有线上版本 → 先导出线上版本；未发布或线上版本导出被拒（如不完整）→ 回退导出当前草稿
    let start = await startExport(course.liveVersionId ? undefined : 'working')
    if (!start.success && course.liveVersionId) start = await startExport('working')
    if (!start.success) {
      setExportingId(null)
      setMessage(uploadErrorText(start.error, start.message))
      return
    }
    for (let attempt = 0; attempt < 120; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const status = await boRequest<{ status: string; progress: number; fileLabel?: string; error?: string }>(
        `/api/backoffice/courses/export/${start.data.jobId}`,
      )
      if (!status.success) continue
      if (status.data.status === 'READY') {
        window.location.href = `/api/backoffice/courses/export/${start.data.jobId}/download`
        setExportingId(null)
        setMessage(L(`已导出 ${course.code}，正在下载课程包。`, `Exported ${course.code}. Downloading the package.`))
        return
      }
      if (status.data.status === 'FAILED') {
        setExportingId(null)
        setMessage(L(`导出失败：${status.data.error ?? '未知错误'}`, `Export failed: ${status.data.error ?? 'unknown error'}`))
        return
      }
    }
    setExportingId(null)
    setMessage(L('导出超时，请稍后在课程详情页重试。', 'Export timed out. Retry from the course detail page.'))
  }

  async function onPickFile(file: File) {
    const lower = file.name.toLowerCase()
    if (!lower.endsWith('.zip') && !lower.endsWith('.lgcourse.zip')) {
      setMessage(L('只能导入 .lgcourse.zip 课程包。', 'Only .lgcourse.zip course packages can be imported.'))
      if (fileRef.current) fileRef.current.value = ''
      return
    }
    setBusy(true)
    setMessage(null)
    setUploadPct(0)
    const result = await uploadFileWithProgress<JobView>(`/api/backoffice/courses/import`, file, setUploadPct)
    setUploadPct(null)
    setBusy(false)
    if (result.success) {
      setImportJob(result.data)
      if (result.data.status === 'FAILED') setMessage(result.data.error ?? L('导入校验失败。', 'Import validation failed.'))
    } else setMessage(uploadErrorText(result.error, result.errorMessage))
  }

  async function confirmImport(onConflict: string) {
    if (!importJob) return
    setBusy(true)
    const result = await boRequest<{ courseId: string }>(`/api/backoffice/courses/import/${importJob.jobId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ onConflict, reassignCodes: false }),
    })
    setBusy(false)
    if (result.success) {
      setImportJob(null)
      if (fileRef.current) fileRef.current.value = ''
      await load()
      openCourse(result.data.courseId)
    } else {
      setMessage(L(`确认导入失败：${result.error}`, `Confirm failed: ${result.error}`))
    }
  }

  return (
    <section className="card cardGrow">
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 className="cardTitle">{t(locale, 'course.title')}</h1>
          <p className="cardBody">
            {list
              ? L(
                  `${list.counts.total} 门课程 · ${list.counts.draft} 草稿 · ${list.counts.online} 在线 · ${list.counts.notPublished} 未发布`,
                  `${list.counts.total} courses · ${list.counts.draft} with draft · ${list.counts.online} online · ${list.counts.notPublished} not published`,
                )
              : t(locale, 'course.description')}
          </p>
        </div>
        {canPublish && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="button buttonGhost" disabled={busy} onClick={() => navigate(`/${locale}/operations`)}>
              {L('运营位', 'Operations')}
            </button>
            <button type="button" className="button buttonGhost" disabled={busy} onClick={() => setShowCreate(true)}>
              {L('新建课程', 'Create course')}
            </button>
            <button type="button" className="button buttonGhost" disabled={busy} onClick={() => rawFileRef.current?.click()}>
              {L('导入原始素材（.zip）', 'Import raw materials (.zip)')}
            </button>
            <button type="button" className="button buttonGhost" disabled={busy} onClick={() => void importFromServerFolder()}>
              {L('本地目录导入', 'Import from server folder')}
            </button>
            <button type="button" className="button" disabled={busy} onClick={() => fileRef.current?.click()}>
              {L('导入课程包', 'Import course package')}
            </button>
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".zip,.lgcourse.zip"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void onPickFile(file)
          }}
        />
        <input
          ref={rawFileRef}
          type="file"
          accept=".zip"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void onPickRawFile(file)
          }}
        />
      </header>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 12 }}>
        <label style={{ fontSize: 13 }}>
          {L('分类', 'Category')}{' '}
          <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} style={{ padding: 7, borderRadius: 8 }}>
            <option value="">{L('全部分类', 'All categories')}</option>
            {categories.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <button type="button" className="button buttonGhost" disabled={loading} onClick={() => void load()}>{L('刷新', 'Refresh')}</button>
      </div>

      {message && (() => {
        const isError = /fail|error|失败|中断|invalid/i.test(message)
        return (
          <p className="cardBody" role="status" style={{ color: isError ? 'var(--color-danger, #d33)' : '#1E7A3C', background: isError ? '#FDECEC' : '#E7F6EC', borderRadius: 8, padding: '8px 12px', marginTop: 8 }}>
            {isError ? '✕ ' : '✓ '}{message}
          </p>
        )
      })()}

      {uploadPct !== null && (
        <div className="cardBody" role="status" style={{ marginTop: 4, marginBottom: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
            <span>{L('正在上传文件…', 'Uploading…')}</span>
            <span>{uploadPct}%</span>
          </div>
          <div style={{ height: 8, background: '#E8EDF5', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ width: `${uploadPct}%`, height: '100%', background: '#1D6BFF', transition: 'width 0.2s ease' }} />
          </div>
          {uploadPct >= 100 && <div style={{ fontSize: 12, marginTop: 4, opacity: 0.7 }}>{L('上传完成，正在解析与校验，请稍候…', 'Upload complete. Parsing and validating…')}</div>}
        </div>
      )}

      {showCreate && (
        <form action={(form) => void createCourse(form)} style={{ marginTop: 12, padding: 16, border: '1px solid #E8EDF5', borderRadius: 12, display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
          <label>{L('课程标题', 'Course title')}<input name="title" required style={{ display: 'block', padding: 8 }} /></label>
          <label>{L('课程 ID', 'Course ID')}<input name="code" required style={{ display: 'block', padding: 8 }} /></label>
          <label>{L('短名（Slug）', 'Slug')}<input name="slug" style={{ display: 'block', padding: 8 }} /></label>
          <label>{L('内容语言', 'Content language')}<select value={createLanguage} onChange={(e) => setCreateLanguage(e.target.value)} style={{ display: 'block', padding: 8 }}><option value="en-GB">en-GB</option><option value="zh-CN">zh-CN</option></select></label>
          <label>{L('学习模式', 'Learning mode')}<select value={createMode} onChange={(e) => setCreateMode(e.target.value)} style={{ display: 'block', padding: 8 }}><option value="VIDEO_ONLY">VIDEO_ONLY</option><option value="TEXT_ONLY">TEXT_ONLY</option><option value="VIDEO_AND_TEXT">VIDEO_AND_TEXT</option></select></label>
          <label>{L('分类', 'Category')}<select value={createCategoryId} onChange={(e) => setCreateCategoryId(e.target.value)} style={{ display: 'block', padding: 8 }}><option value="">{L('未分类', 'Uncategorized')}</option>{catalogCategories.map((cat) => <option key={cat.id} value={cat.id}>{cat.name}</option>)}</select></label>
          <button className="button" disabled={busy}>{L('创建并编辑', 'Create and edit')}</button>
          <button type="button" className="button buttonGhost" onClick={() => setShowCreate(false)}>{L('取消', 'Cancel')}</button>
        </form>
      )}

      {importJob && (
        <ImportPanel
          job={importJob}
          busy={busy}
          locale={locale}
          codeExists={Boolean(list?.courses.some((c) => c.code === importJob.package?.courseCode))}
          onConfirm={confirmImport}
        />
      )}

      {loading && <p className="cardBody">{t(locale, 'common.loading')}</p>}

      {list && (
        <table className="table" style={{ width: '100%', marginTop: 16 }}>
          <thead>
            <tr>
              <th>{L('课程 ID', 'Course ID')}</th>
              <th>{L('课程', 'Course')}</th>
              <th>{L('分类', 'Category')}</th>
              <th>{L('课时', 'Lessons')}</th>
              <th>{L('草稿', 'Draft')}</th>
              <th>{L('在线', 'Live')}</th>
              <th>{L('操作', 'Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {list.courses.map((course) => (
              <tr key={course.id}>
                <td>{course.code}</td>
                <td>
                  <button type="button" onClick={() => openCourse(course.id)} style={{ fontWeight: 600, background: 'none', border: 0, padding: 0, color: '#1d6bff', cursor: 'pointer', textAlign: 'left' }}>{course.title}</button>
                  <div style={{ opacity: 0.7, fontSize: 12 }}>
                    {course.learningMode} · {course.learningLanguages.join(', ')}
                  </div>
                </td>
                <td>{course.category?.name ?? '—'}</td>
                <td>{course.lessonCount}</td>
                <td>{course.hasDraft ? <span style={{ color: '#9A6B00', fontWeight: 600 }}>{L('草稿', 'Draft')}</span> : '—'}</td>
                <td>
                  {course.published
                    ? <span style={{ color: course.liveStatus === 'ONLINE' ? '#1E7A3C' : '#5A6577', fontWeight: 600 }}>{course.liveStatus}</span>
                    : <span style={{ opacity: 0.7 }}>{L('未发布', 'Not published')}</span>}
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button className="button buttonGhost" onClick={() => openCourse(course.id)}>{L('打开', 'Open')}</button>
                    <button
                      className="button buttonGhost"
                      disabled={busy || exportingId !== null}
                      onClick={() => void exportCourse(course)}
                    >
                      {exportingId === course.id ? L('导出中…', 'Exporting…') : L('导出', 'Export')}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {list.courses.length === 0 && (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', padding: 24, opacity: 0.7 }}>
                  {L('还没有课程。可以新建课程或导入课程包。', 'No courses yet. Create a course or import a course package.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  )
}

function ImportPanel({
  job,
  busy,
  locale,
  codeExists,
  onConfirm,
}: {
  job: JobView
  busy: boolean
  locale: string
  codeExists: boolean
  onConfirm: (onConflict: string) => void
}) {
  const zh = locale.startsWith('zh')
  const errors = job.report?.errors ?? []
  const warnings = job.report?.warnings ?? []
  return (
    <div style={{ marginTop: 16, padding: 16, border: '1px solid #E8EDF5', borderRadius: 12 }}>
      <h3 style={{ margin: 0 }}>{zh ? '导入校验' : 'Import validation'}</h3>
      <p style={{ margin: '8px 0', fontSize: 13 }}>
        {zh ? '状态' : 'Status'}: <strong>{job.status}</strong>
        {job.package && (
          <>
            {' · '}{zh ? '课程' : 'Course'} {job.package.courseCode} · {job.package.lessons} {zh ? '课时' : 'lessons'} · {job.package.mediaFiles} {zh ? '媒体' : 'media'}
            {job.package.incomplete ? ' · incomplete' : ''}
          </>
        )}
      </p>
      {job.error && <div style={{ color: '#b42318', fontSize: 13, marginBottom: 8 }}>{job.error}</div>}
      {errors.length > 0 && (
        <div style={{ color: '#b42318', fontSize: 13 }}>
          {errors.map((e, i) => <div key={i}>ERROR {e.code}: {e.message}</div>)}
        </div>
      )}
      {warnings.length > 0 && (
        <details style={{ fontSize: 13, marginTop: 8 }}>
          <summary>{warnings.length} {zh ? '条警告' : 'warning(s)'}</summary>
          {warnings.map((w, i) => <div key={i} style={{ opacity: 0.8 }}>WARN {w.code}: {w.message}</div>)}
        </details>
      )}
      {job.status === 'AWAITING_CONFIRM' && (
        <div style={{ marginTop: 12 }}>
          {codeExists ? (
            <p style={{ fontSize: 13, color: '#9A6B00', background: '#FFF6E5', padding: '8px 12px', borderRadius: 8 }}>
              {zh
                ? `课程 ${job.package?.courseCode} 已存在，本后台拒绝重复导入。请进入该课程，使用「导入课程包」替换草稿。`
                : `Course ${job.package?.courseCode} already exists. This Admin refuses the import; open the existing course and use "Import package" instead.`}
            </p>
          ) : (
            <button className="button" disabled={busy} onClick={() => onConfirm('ABORT')}>
              {zh ? '导入课程' : 'Import course'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// 供 Sidebar 高亮使用
export const COURSE_MENU_SEGMENT = MENU_SEGMENT.course
