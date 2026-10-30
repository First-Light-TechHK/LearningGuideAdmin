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
  progress: number
  error: string | null
  courseId: string | null
  package: { courseCode: string; lessons: number; mediaFiles: number; incomplete: boolean } | null
  report: { errors: Array<{ code: string; message: string }>; warnings: Array<{ code: string; message: string }> }
}

type UploadResult<T> = { success: true; data: T } | { success: false; error: string }

/**
 * 带上传进度的文件上传（fetch 无法获取上传进度，改用 XHR 的 upload.onprogress）。
 * error 为稳定码：NETWORK_ERROR / ABORTED / 或后端信封里的错误码。
 */
function uploadFileWithProgress<T>(url: string, file: File, onProgress: (pct: number) => void): Promise<UploadResult<T>> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.withCredentials = true
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText) as { success?: boolean; data?: T; error?: { code?: string } | null }
        if (body?.success === true) resolve({ success: true, data: body.data as T })
        else resolve({ success: false, error: body?.error?.code ?? 'INTERNAL_ERROR' })
      } catch {
        resolve({ success: false, error: 'INTERNAL_ERROR' })
      }
    }
    xhr.onerror = () => resolve({ success: false, error: 'NETWORK_ERROR' })
    xhr.onabort = () => resolve({ success: false, error: 'ABORTED' })
    const form = new FormData()
    form.append('file', file)
    xhr.send(form)
  })
}

function uploadErrorText(code: string): string {
  if (code === 'NETWORK_ERROR' || code === 'ABORTED') {
    return '上传中断（文件较大或服务被重启/网络中断）。请确认本地服务稳定后重试。'
  }
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
  const canPublish = employee.role === 'ADMIN' || employee.role === 'OPERATION_ADMIN'
  const [list, setList] = useState<CourseList | null>(null)
  const [loading, setLoading] = useState(false)
  const [importJob, setImportJob] = useState<JobView | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [uploadPct, setUploadPct] = useState<number | null>(null)
  const [categoryId, setCategoryId] = useState('')
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
        language: locale,
        defaultContentLanguage: locale,
        learningLanguages: [locale],
      }),
    })
    setBusy(false)
    if (result.success) {
      setShowCreate(false)
      await load()
      openCourse(result.data.id)
    } else setMessage(`Create failed: ${result.error}`)
  }

  async function onPickRawFile(file: File) {
    setBusy(true)
    setMessage(null)
    setUploadPct(0)
    const result = await uploadFileWithProgress<JobView & { rawWarnings?: string[] }>(
      `/api/backoffice/courses/import/raw`,
      file,
      setUploadPct,
    )
    setUploadPct(null)
    setBusy(false)
    if (result.success) {
      setImportJob(result.data)
      const rawWarnings = result.data.rawWarnings ?? []
      setMessage(rawWarnings.length ? `Raw materials converted with ${rawWarnings.length} warning(s). Review validation before confirming.` : 'Raw materials converted. Review validation before confirming.')
    } else setMessage(uploadErrorText(result.error))
  }

  async function importFromServerFolder() {
    const dir = window.prompt('仓库内素材目录（相对仓库根）', 'docs/modeling-life')
    if (dir === null) return
    setBusy(true)
    setMessage(null)
    const result = await boRequest<JobView & { rawWarnings?: string[] }>(`/api/backoffice/courses/import/local`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir }),
    })
    setBusy(false)
    if (result.success) {
      setImportJob(result.data)
      setMessage('已从本地目录解析素材，请在校验信息中确认后导入。')
    } else setMessage(uploadErrorText(result.error))
  }

  async function onPickFile(file: File) {
    const lower = file.name.toLowerCase()
    if (!lower.endsWith('.zip') && !lower.endsWith('.lgcourse.zip')) {
      setMessage('Only .lgcourse.zip course packages can be imported.')
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
      if (result.data.status === 'FAILED') setMessage(result.data.error ?? 'Import validation failed.')
    } else setMessage(uploadErrorText(result.error))
  }

  async function confirmImport(onConflict: string) {
    if (!importJob) return
    setBusy(true)
    const result = await boRequest<{ courseId: string }>(`/api/backoffice/courses/import/${importJob.jobId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ onConflict, reassignCodes: true }),
    })
    setBusy(false)
    if (result.success) {
      setImportJob(null)
      if (fileRef.current) fileRef.current.value = ''
      await load()
      openCourse(result.data.courseId)
    } else {
      setMessage(`Confirm failed: ${result.error}`)
    }
  }

  return (
    <section className="card cardGrow">
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 className="cardTitle">{t(locale, 'course.title')}</h1>
          <p className="cardBody">
            {list ? `${list.counts.total} courses · ${list.counts.draft} with draft · ${list.counts.online} online · ${list.counts.notPublished} not published` : t(locale, 'course.description')}
          </p>
        </div>
        {canPublish && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="button buttonGhost" disabled={busy} onClick={() => navigate(`/${locale}/operations`)}>
              Operations
            </button>
            <button type="button" className="button buttonGhost" disabled={busy} onClick={() => setShowCreate(true)}>Create course</button>
            <button type="button" className="button buttonGhost" disabled={busy} onClick={() => rawFileRef.current?.click()}>
              Import raw materials (.zip)
            </button>
            <button type="button" className="button buttonGhost" disabled={busy} onClick={() => void importFromServerFolder()}>
              本地目录导入
            </button>
            <button type="button" className="button" disabled={busy} onClick={() => fileRef.current?.click()}>
              Import course package
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
          Category{' '}
          <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} style={{ padding: 7, borderRadius: 8 }}>
            <option value="">All categories</option>
            {categories.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <button type="button" className="button buttonGhost" disabled={loading} onClick={() => void load()}>Refresh</button>
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
            <span>正在上传文件…</span>
            <span>{uploadPct}%</span>
          </div>
          <div style={{ height: 8, background: '#E8EDF5', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ width: `${uploadPct}%`, height: '100%', background: '#1D6BFF', transition: 'width 0.2s ease' }} />
          </div>
          {uploadPct >= 100 && <div style={{ fontSize: 12, marginTop: 4, opacity: 0.7 }}>上传完成，正在解析与校验，请稍候…</div>}
        </div>
      )}

      {showCreate && (
        <form action={(form) => void createCourse(form)} style={{ marginTop: 12, padding: 16, border: '1px solid #E8EDF5', borderRadius: 12, display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
          <label>Course title<input name="title" required style={{ display: 'block', padding: 8 }} /></label>
          <label>Course ID<input name="code" required style={{ display: 'block', padding: 8 }} /></label>
          <label>Slug<input name="slug" style={{ display: 'block', padding: 8 }} /></label>
          <button className="button" disabled={busy}>Create and edit</button>
          <button type="button" className="button buttonGhost" onClick={() => setShowCreate(false)}>Cancel</button>
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
              <th>Course ID</th>
              <th>Course</th>
              <th>Category</th>
              <th>Lessons</th>
              <th>Draft</th>
              <th>Live</th>
              <th>Actions</th>
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
                <td>{course.hasDraft ? <span style={{ color: '#9A6B00', fontWeight: 600 }}>Draft</span> : '—'}</td>
                <td>
                  {course.published
                    ? <span style={{ color: course.liveStatus === 'ONLINE' ? '#1E7A3C' : '#5A6577', fontWeight: 600 }}>{course.liveStatus}</span>
                    : <span style={{ opacity: 0.7 }}>Not published</span>}
                </td>
                <td>
                  <button className="button buttonGhost" onClick={() => openCourse(course.id)}>Open</button>
                </td>
              </tr>
            ))}
            {list.courses.length === 0 && (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', padding: 24, opacity: 0.7 }}>
                  No courses yet. Create a course or import a course package.
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
          {codeExists && (
            <p style={{ fontSize: 13, color: '#9A6B00', background: '#FFF6E5', padding: '8px 12px', borderRadius: 8 }}>
              {zh
                ? `课程 ${job.package?.courseCode} 已存在。请点击「导入为新课程」，会生成一门新课程（Course ID 自动顺延）。`
                : `Course ${job.package?.courseCode} already exists. Click "Import as new course" to create a new course with a new Course ID.`}
            </p>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="button" disabled={busy} onClick={() => onConfirm('CREATE_NEW_COURSE')}>
              {zh ? '导入为新课程' : 'Import as new course'}
            </button>
            {!codeExists && (
              <button className="button buttonGhost" disabled={busy} onClick={() => onConfirm('ABORT')}>
                {zh ? '导入（冲突则中止）' : 'Import (abort on conflict)'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// 供 Sidebar 高亮使用
export const COURSE_MENU_SEGMENT = MENU_SEGMENT.course
