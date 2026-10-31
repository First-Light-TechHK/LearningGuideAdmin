import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import type {
  CourseDetail,
  CoursePlan,
  CourseVersion,
  HistoryPage,
  TrialSettings,
  TrialRow,
} from '../contracts/course';
import { providerItems, strings } from '../contracts/course';
import { boRequest } from '../lib/api';

const L = (locale: string, zh: string, en: string) => (locale.startsWith('zh') ? zh : en);

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: 10,
  border: '1px solid #d9e0ea',
  borderRadius: 8,
  boxSizing: 'border-box',
  fontSize: 14,
};
const labelStyle: React.CSSProperties = { display: 'block', fontWeight: 600, margin: '14px 0 6px', color: '#25314C', fontSize: 13 };
const buttonStyle: React.CSSProperties = { padding: '8px 14px', border: '1px solid #d9e0ea', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 };
const primaryBtn: React.CSSProperties = { ...buttonStyle, background: '#2B58C8', color: '#fff', border: '1px solid #2B58C8' };
const dangerBtn: React.CSSProperties = { ...buttonStyle, color: '#b42318', borderColor: '#f0c2be' };
const card: React.CSSProperties = { border: '1px solid #E8EDF5', borderRadius: 14, padding: 20, background: '#fff', marginTop: 18 };

type Tab = 'info' | 'content' | 'trial' | 'versions';

const Chip = ({ children, tone = 'grey' }: { children: React.ReactNode; tone?: 'grey' | 'green' | 'amber' | 'red' | 'blue' }) => (
  <span
    style={{
      fontSize: 12,
      padding: '2px 10px',
      borderRadius: 999,
      background: tone === 'green' ? '#E7F6EC' : tone === 'amber' ? '#FFF6E5' : tone === 'red' ? '#FDECEC' : tone === 'blue' ? '#EEF3FF' : '#EEF1F6',
      color: tone === 'green' ? '#1E7A3C' : tone === 'amber' ? '#9A6B00' : tone === 'red' ? '#b42318' : tone === 'blue' ? '#2B58C8' : '#5A6577',
    }}
  >
    {children}
  </span>
);

function fmtDuration(seconds: number | null | undefined): string {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function stepTone(complete: boolean) {
  return complete ? ('green' as const) : ('amber' as const);
}

export function CourseEditorPage() {
  const { courseId = '', locale = 'en-GB' } = useParams();
  const navigate = useNavigate();
  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [trial, setTrial] = useState<TrialSettings | null>(null);
  const [plans, setPlans] = useState<CoursePlan[]>([]);
  const [versions, setVersions] = useState<CourseVersion[]>([]);
  const [history, setHistory] = useState<HistoryPage | null>(null);
  const [historyPage, setHistoryPage] = useState(1);
  const [tab, setTab] = useState<Tab>('info');
  const [activeLessonId, setActiveLessonId] = useState('');
  const [contentLanguage, setContentLanguage] = useState('en-GB');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [statusReason, setStatusReason] = useState('');
  const [statusTarget, setStatusTarget] = useState<'ONLINE' | 'HIDDEN' | 'OFFLINE'>('ONLINE');
  const [exportJob, setExportJob] = useState<{ status: string; progress: number; fileName?: string; error?: string } | null>(null);
  const [exportVersion, setExportVersion] = useState('live');
  const [categories, setCategories] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState('');
  const nextTab = useRef<Tab | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [detail, trialResult, versionsResult, historyResult, categoriesResult] = await Promise.all([
      boRequest<CourseDetail>(`/api/backoffice/courses/${courseId}`),
      boRequest<TrialSettings>(`/api/backoffice/courses/${courseId}/trial`),
      boRequest<CourseVersion[]>(`/api/backoffice/courses/${courseId}/versions`),
      boRequest<HistoryPage>(`/api/backoffice/courses/${courseId}/history?page=${historyPage}&pageSize=20`),
      boRequest<Array<{ id: string; name: string }>>(`/api/backoffice/courses/categories`),
    ]);
    setLoading(false);
    if (!detail.success) {
      setNotice(`Could not load course: ${detail.error}`);
      return;
    }
    setCourse(detail.data);
    setContentLanguage(detail.data.defaultContentLanguage || detail.data.learningLanguages[0] || 'en-GB');
    setActiveLessonId((current) => current || detail.data.lessons[0]?.id || '');
    setSelectedCategoryId(detail.data.categoryId ?? '');
    if (trialResult.success) setTrial(trialResult.data);
    if (versionsResult.success) setVersions(versionsResult.data);
    if (historyResult.success) setHistory(historyResult.data);
    if (categoriesResult.success) setCategories(categoriesResult.data);
  }, [courseId, historyPage]);

  useEffect(() => {
    void load();
  }, [load]);

  const language = contentLanguage || course?.defaultContentLanguage || 'en-GB';
  const localization = course?.localizations.find((item) => item.language === language) ?? course?.localizations[0];
  const activeLesson = course?.lessons.find((lesson) => lesson.id === activeLessonId);
  const activeLessonLoc = activeLesson?.localizations.find((item) => item.language === language) ?? activeLesson?.localizations[0];
  const defaultPlans = useMemo(() => plans, [plans]);

  useEffect(() => {
    if (course) setPlans(course.plans ?? []);
  }, [course]);

  async function saveCourse(form: FormData) {
    if (!course) return;
    setBusy(true);
    const core = await boRequest(`/api/backoffice/courses/${course.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: String(form.get('slug') ?? '') || undefined,
        defaultContentLanguage: language,
        learningLanguages: course.learningLanguages,
        subtitle: String(form.get('subtitle') ?? '') || null,
        categoryId: selectedCategoryId || null,
      }),
    });
    const provides = String(form.get('provides') ?? '')
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((title) => ({ type: 'custom', title }));
    const loc = await boRequest(`/api/backoffice/courses/${course.id}/localizations/${encodeURIComponent(language)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: String(form.get('title') ?? ''),
        shortDescription: String(form.get('shortDescription') ?? '') || null,
        overview: String(form.get('overview') ?? '') || null,
        whatYouLearn: String(form.get('whatYouLearn') ?? '')
          .split('\n')
          .map((value) => value.trim())
          .filter(Boolean),
        provides,
      }),
    });
    setBusy(false);
    if (core.success && loc.success) {
      setNotice(L(locale, '课程信息已保存为草稿。', 'Course information saved to the draft.'));
      const target = nextTab.current;
      nextTab.current = null;
      if (target) setTab(target);
      await load();
    } else {
      setNotice(`Save failed: ${core.success ? loc.error : core.error}`);
    }
  }

  async function saveLesson(form: FormData) {
    if (!course || !activeLesson) return;
    setBusy(true);
    const result = await boRequest(`/api/backoffice/courses/${course.id}/lessons/${activeLesson.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        language,
        code: String(form.get('lessonCode') ?? ''),
        title: String(form.get('lessonTitle') ?? ''),
        description: String(form.get('lessonDescription') ?? '') || null,
        textHtml: String(form.get('lessonText') ?? '') || null,
      }),
    });
    setBusy(false);
    if (result.success) {
      setNotice(L(locale, '课时已保存为草稿。', 'Lesson saved to the draft.'));
      const target = nextTab.current;
      nextTab.current = null;
      if (target) setTab(target);
      await load();
    } else {
      setNotice(`Lesson save failed: ${result.error}`);
    }
  }

  async function uploadCover(file: File) {
    if (!course) return;
    setBusy(true);
    const form = new FormData();
    form.append('file', file);
    const result = await boRequest<{ id: string }>(`/api/backoffice/courses/${course.id}/cover`, { method: 'POST', body: form });
    setBusy(false);
    if (result.success) {
      setNotice(L(locale, '封面已上传。', 'Cover uploaded.'));
      await load();
    } else {
      setNotice(`Cover upload failed: ${result.error}`);
    }
  }

  async function uploadLessonVideo(file: File) {
    if (!course || !activeLesson) return;
    setBusy(true);
    const form = new FormData();
    form.append('file', file);
    const uploaded = await boRequest<{ id: string }>(`/api/backoffice/courses/${course.id}/media`, { method: 'POST', body: form });
    if (!uploaded.success) {
      setBusy(false);
      setNotice(`Video upload failed: ${uploaded.error}`);
      return;
    }
    const result = await boRequest(`/api/backoffice/courses/${course.id}/lessons/${activeLesson.id}/video`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language, assetId: uploaded.data.id }),
    });
    setBusy(false);
    if (result.success) {
      setNotice(L(locale, '视频已上传。', 'Video uploaded.'));
      await load();
    } else {
      setNotice(`Video assign failed: ${result.error}`);
    }
  }

  async function addLesson() {
    if (!course) return;
    const title = window.prompt(L(locale, '课时标题', 'Lesson title'))?.trim();
    if (!title) return;
    setBusy(true);
    const result = await boRequest<CourseDetail>(`/api/backoffice/courses/${course.id}/lessons`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, language }),
    });
    setBusy(false);
    if (result.success) {
      const newest = [...result.data.lessons].sort((a, b) => b.sortOrder - a.sortOrder)[0];
      setActiveLessonId(newest?.id ?? '');
      await load();
    } else {
      setNotice(`Could not add lesson: ${result.error}`);
    }
  }

  async function deleteLesson() {
    if (!course || !activeLesson) return;
    if (!window.confirm(L(locale, '确认移除该课时？下次 Publish 后才会从网站消失。', 'Remove this lesson? It disappears from the website after the next Publish.'))) return;
    setBusy(true);
    const result = await boRequest<CourseDetail>(`/api/backoffice/courses/${course.id}/lessons/${activeLesson.id}`, { method: 'DELETE' });
    setBusy(false);
    if (result.success) {
      setActiveLessonId(result.data.lessons[0]?.id ?? '');
      await load();
    } else {
      setNotice(`Delete failed: ${result.error}`);
    }
  }

  async function moveLesson(direction: -1 | 1) {
    if (!course || !activeLesson) return;
    const ordered = [...course.lessons].sort((a, b) => a.sortOrder - b.sortOrder);
    const index = ordered.findIndex((lesson) => lesson.id === activeLesson.id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= ordered.length) return;
    [ordered[index], ordered[nextIndex]] = [ordered[nextIndex], ordered[index]];
    setBusy(true);
    const result = await boRequest<CourseDetail>(`/api/backoffice/courses/${course.id}/lessons/reorder`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lessonIds: ordered.map((lesson) => lesson.id) }),
    });
    setBusy(false);
    if (result.success) await load();
    else setNotice(`Reorder failed: ${result.error}`);
  }

  async function publish() {
    if (!course) return;
    if (!course.completeness.canPublish) {
      window.alert(course.completeness.publishBlockers.join('\n'));
      return;
    }
    const gaps = [
      ...course.completeness.steps.courseInformation.missing,
      ...course.completeness.steps.content.missing,
      ...course.completeness.steps.trial.missing,
    ];
    const warning = gaps.length
      ? L(locale, `发布后以下内容仍不完整，前台将按规则隐藏：\n${gaps.slice(0, 8).join('\n')}\n\n继续发布？`, `Publish anyway? Incomplete content will be handled by the front-end rules:\n${gaps.slice(0, 8).join('\n')}`)
      : L(locale, '确认发布草稿并生成本环境的新版本？', 'Publish this draft as a new version in this environment?');
    if (!window.confirm(warning)) return;
    setBusy(true);
    const result = await boRequest<{ versionLabel: string }>(`/api/backoffice/courses/${course.id}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ notifyLearners: false }),
    });
    setBusy(false);
    if (result.success) {
      setNotice(L(locale, `已发布 ${result.data.versionLabel}。`, `Published ${result.data.versionLabel}.`));
      await load();
    } else {
      setNotice(`Publish failed: ${result.error}`);
    }
  }

  async function deleteDraft() {
    if (!course) return;
    if (!window.confirm(L(locale, 'Draft 将被删除（含导入的包），网站继续使用当前线上版本。此操作不可撤销。', 'The draft will be deleted (including any imported package). The website keeps the current live version. This cannot be undone.'))) return;
    setBusy(true);
    const result = await boRequest(`/api/backoffice/courses/${course.id}/delete-draft`, { method: 'POST' });
    setBusy(false);
    if (result.success) {
      setNotice(L(locale, '草稿已删除，已恢复为线上版本。', 'Draft deleted; the draft now matches the live version.'));
      await load();
    } else {
      setNotice(`Delete draft failed: ${result.error}`);
    }
  }

  async function restoreVersion(version: CourseVersion) {
    if (!course) return;
    if (!window.confirm(L(locale, `${version.versionLabel} 将被复制到草稿并替换当前草稿。发布前线上不变。`, `${version.versionLabel} will be copied into the draft and replace the current draft. What is live does not change until you publish.`))) return;
    setBusy(true);
    const result = await boRequest(`/api/backoffice/courses/${course.id}/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ versionId: version.id }),
    });
    setBusy(false);
    if (result.success) {
      setNotice(L(locale, `已从 ${version.versionLabel} 恢复草稿。`, `Draft restored from ${version.versionLabel}.`));
      await load();
    } else {
      setNotice(`Restore failed: ${result.error}`);
    }
  }

  async function changeStatus() {
    if (!course) return;
    if (!statusReason.trim()) {
      window.alert(L(locale, '请填写变更原因。', 'A reason is required.'));
      return;
    }
    setBusy(true);
    const result = await boRequest(`/api/backoffice/courses/${course.id}/live-status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: statusTarget, reason: statusReason }),
    });
    setBusy(false);
    if (result.success) {
      setStatusReason('');
      setNotice(L(locale, `状态已改为 ${statusTarget}。`, `Status changed to ${statusTarget}.`));
      await load();
    } else {
      setNotice(`Change status failed: ${result.error}`);
    }
  }

  async function exportPackage(target: string) {
    if (!course) return;
    setBusy(true);
    setExportJob({ status: 'EXPORTING', progress: 0 });
    // 'live' = 导出线上版本；'draft' = 导出当前草稿；其他值 = 导出该历史版本快照
    const body = target === 'live' ? {} : { version: target };
    const start = await boRequest<{ jobId: string; fileName?: string }>(`/api/backoffice/courses/${course.id}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!start.success) {
      setBusy(false);
      setExportJob(null);
      setNotice(`Export failed: ${start.error}`);
      return;
    }
    for (let attempt = 0; attempt < 120; attempt++) {
      await sleep(1500);
      const status = await boRequest<{ status: string; progress: number; fileLabel?: string; error?: string }>(
        `/api/backoffice/courses/export/${start.data.jobId}`,
      );
      if (status.success) {
        setExportJob({ status: status.data.status, progress: status.data.progress, fileName: status.data.fileLabel, error: status.data.error });
        if (status.data.status === 'READY') {
          window.location.href = `/api/backoffice/courses/export/${start.data.jobId}/download`;
          setBusy(false);
          await load();
          return;
        }
        if (status.data.status === 'FAILED') {
          setBusy(false);
          setNotice(`Export failed: ${status.data.error ?? start.error ?? 'Unknown error'}`);
          return;
        }
      }
    }
    setBusy(false);
    setNotice('Export did not finish in time.');
  }

  async function importPackage(file: File) {
    if (!course) return;
    setBusy(true);
    const form = new FormData();
    form.append('file', file);
    const uploaded = await boRequest<{ jobId: string; status: string }>(`/api/backoffice/courses/${course.id}/import`, {
      method: 'POST',
      body: form,
    });
    if (!uploaded.success) {
      setBusy(false);
      setNotice(`Import failed: ${uploaded.error}`);
      return;
    }
    const confirmed = await boRequest<{ courseId: string }>(`/api/backoffice/courses/import/${uploaded.data.jobId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ onConflict: 'ABORT', reassignCodes: false }),
    });
    setBusy(false);
    if (confirmed.success) {
      setNotice(L(locale, '课程包已导入，当前草稿已被替换；线上版本未变。', 'Package imported; the draft was replaced. The live version is unchanged.'));
      await load();
    } else {
      setNotice(`Import failed: ${confirmed.error}`);
    }
  }

  if (loading) return <section className="card cardGrow"><p>{L(locale, '加载课程中…', 'Loading course…')}</p></section>;
  if (!course) return <section className="card cardGrow"><p>{notice}</p></section>;

  const coverUrl = `/api/backoffice/courses/${courseId}/cover`;
  const liveVersion = versions.find((version) => version.isLive);
  const steps = [
    { key: 'courseInformation', label: L(locale, '课程信息', 'Course Information'), complete: course.completeness.steps.courseInformation.complete },
    { key: 'content', label: L(locale, '课程内容', 'Course Content'), complete: course.completeness.steps.content.complete },
    { key: 'trial', label: L(locale, '试看与价格', 'Trial & Pricing'), complete: course.completeness.steps.trial.complete },
  ];

  return (
    <section className="card cardGrow" style={{ overflow: 'auto' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, borderBottom: '1px solid #E8EDF5', paddingBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <button style={buttonStyle} onClick={() => navigate(`/${locale}/course`)}>←</button>
          {course.cover ? <img src={coverUrl} alt="cover" style={{ width: 76, height: 50, objectFit: 'cover', borderRadius: 8, border: '1px solid #E8EDF5' }} /> : <div style={{ width: 76, height: 50, borderRadius: 8, background: '#EEF1F6' }} />}
          <div>
            <h1 style={{ margin: 0, fontSize: 22 }}>{localization?.title ?? course.slug}</h1>
            <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button" style={{ ...buttonStyle, padding: '2px 10px', fontSize: 12 }} onClick={() => void navigator.clipboard?.writeText(course.code)}>{course.code} · {L(locale, '复制', 'copy')}</button>
              {course.category?.name && <Chip>{course.category.name}</Chip>}
              <Chip>{course.learningMode}</Chip>
              <Chip>{course.learningLanguages.join(', ')}</Chip>
              <Chip>{course.lessons.length} {L(locale, '课时', 'lessons')}</Chip>
              {course.hasDraft ? <Chip tone="amber">{L(locale, '草稿', 'Draft')}</Chip> : <Chip>{L(locale, '无草稿', 'No draft')}</Chip>}
              {course.liveVersionId ? <Chip tone={course.liveStatus === 'ONLINE' ? 'green' : 'grey'}>{liveVersion?.versionLabel ?? 'Live'} · {course.liveStatus}</Chip> : <Chip tone="grey">{L(locale, '未发布', 'Not published')}</Chip>}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button style={buttonStyle} onClick={() => void load()}>{L(locale, '重新加载', 'Reload')}</button>
          <button style={buttonStyle} onClick={() => window.open(`/${locale}/course/${courseId}/preview`, '_blank')}>{L(locale, '学员视角预览', 'Preview as learner')}</button>
          <button style={primaryBtn} onClick={() => setTab('versions')}>{L(locale, '版本与发布', 'Versions & publishing')}</button>
        </div>
      </header>

      <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
        {steps.map((step) => (
          <Chip key={step.key} tone={stepTone(step.complete)}>
            {step.complete ? '✓' : '!'} {step.label} · {step.complete ? 'Complete' : 'Incomplete'}
          </Chip>
        ))}
        <Chip tone={course.completeness.completedSteps === 3 ? 'green' : 'amber'}>
          {course.completeness.completedSteps} of 3 {L(locale, '步完成', 'steps complete')}
        </Chip>
      </div>

      {notice && <p role="status" style={{ padding: 10, background: /fail|error|invalid|不可/.test(notice) ? '#FDECEC' : '#F3F7FF', borderRadius: 8, marginTop: 14, whiteSpace: 'pre-wrap' }}>{notice}</p>}

      <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
        {([
          ['info', L(locale, '课程信息', 'Course Information')],
          ['content', L(locale, '课程内容', 'Course Content')],
          ['trial', L(locale, '试看与价格', 'Trial & Pricing')],
          ['versions', L(locale, '版本与历史', 'Versions & History')],
        ] as Array<[Tab, string]>).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{ ...buttonStyle, borderColor: tab === key ? '#2B58C8' : '#d9e0ea', color: tab === key ? '#2B58C8' : '#25314C', fontWeight: 600 }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'info' && (
        <form action={(form) => void saveCourse(form)}>
          <div style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>{L(locale, '课程信息', 'Course Information')}</h2>
              <label style={{ fontSize: 13 }}>
                {L(locale, '内容语言', 'Content language')}{' '}
                <select value={language} onChange={(event) => setContentLanguage(event.target.value)} style={{ padding: 6, borderRadius: 6 }}>
                  {course.learningLanguages.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
              </label>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
              <label style={labelStyle}>{L(locale, '课程标题', 'Course title')}<input name="title" required defaultValue={localization?.title ?? ''} style={inputStyle} /></label>
              <label style={labelStyle}>{L(locale, 'Course ID（不可修改）', 'Course ID (read-only)')}<input value={course.code} readOnly style={{ ...inputStyle, background: '#F5F7FA' }} /></label>
              <label style={labelStyle}>Slug<input name="slug" defaultValue={course.slug} style={inputStyle} /></label>
              <label style={labelStyle}>{L(locale, '学习模式（创建后锁定）', 'Learning mode (locked)')}<input value={course.learningMode} readOnly style={{ ...inputStyle, background: '#F5F7FA' }} /></label>
              <label style={labelStyle}>
                {L(locale, '分类', 'Category')}
                <select value={selectedCategoryId} onChange={(event) => setSelectedCategoryId(event.target.value)} style={inputStyle}>
                  <option value="">{L(locale, '未分类', 'Uncategorized')}</option>
                  {categories.map((cat) => <option key={cat.id} value={cat.id}>{cat.name}</option>)}
                </select>
              </label>
              <label style={labelStyle}>
                {L(locale, '封面图片', 'Cover image')}
                <input type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadCover(file); }} style={inputStyle} />
              </label>
            </div>
            <label style={labelStyle}>{L(locale, '课程概览', 'Overview')}<textarea name="overview" rows={4} defaultValue={localization?.overview ?? ''} style={inputStyle} /></label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <label style={labelStyle}>
                {L(locale, "You'll learn（每行一条，至少 4 条）", "What you'll learn (one per line, 4 minimum)")}
                <textarea name="whatYouLearn" rows={6} defaultValue={strings(localization?.whatYouLearn).join('\n')} style={inputStyle} />
              </label>
              <label style={labelStyle}>
                {L(locale, 'This course provides（每行一条，4–6 条）', 'This course provides (one per line, 4–6)')}
                <textarea name="provides" rows={6} defaultValue={providerItems(localization?.provides).map((item) => item.title).join('\n')} style={inputStyle} />
              </label>
            </div>
            <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
              <button type="submit" disabled={busy} style={primaryBtn}>{L(locale, '保存', 'Save')}</button>
              <button type="submit" disabled={busy} style={buttonStyle} onClick={() => { nextTab.current = 'content'; }}>{L(locale, '保存并下一步', 'Save & next')}</button>
            </div>
          </div>
        </form>
      )}

      {tab === 'content' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 300px) 1fr', gap: 20, marginTop: 18 }}>
          <aside style={{ ...card, marginTop: 0, padding: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <h3 style={{ margin: 0, fontSize: 15 }}>{L(locale, '课时', 'Lessons')}</h3>
              <button type="button" style={buttonStyle} disabled={busy} onClick={() => void addLesson()}>{L(locale, '+ 添加', '+ Add')}</button>
            </div>
            {course.lessons.length === 0 && <p style={{ opacity: 0.7 }}>{L(locale, '暂无课时。', 'No lessons yet.')}</p>}
            {[...course.lessons].sort((a, b) => a.sortOrder - b.sortOrder).map((lesson) => {
              const completeness = course.completeness.steps.content.lessons.find((item) => item.lessonId === lesson.id);
              return (
                <button
                  key={lesson.id}
                  type="button"
                  onClick={() => setActiveLessonId(lesson.id)}
                  style={{ ...buttonStyle, display: 'block', width: '100%', textAlign: 'left', marginBottom: 6, borderColor: activeLessonId === lesson.id ? '#2B58C8' : '#E8EDF5', background: activeLessonId === lesson.id ? '#F5F8FF' : '#fff' }}
                >
                  <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span>{lesson.sortOrder}. {lesson.localizations.find((item) => item.language === language)?.title ?? lesson.code}</span>
                    <span>{completeness?.studyComplete ? '✓' : '!'}{completeness?.understandingComplete ? '✓' : '!'}</span>
                  </span>
                </button>
              );
            })}
          </aside>

          {activeLesson ? (
            <form key={`${activeLesson.id}-${language}`} action={(form) => void saveLesson(form)} style={{ ...card, marginTop: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <h3 style={{ margin: 0, fontSize: 16 }}>{L(locale, '课时编辑', 'Lesson editor')} · Lesson {activeLesson.sortOrder}</h3>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" style={buttonStyle} disabled={busy} onClick={() => void moveLesson(-1)}>↑</button>
                  <button type="button" style={buttonStyle} disabled={busy} onClick={() => void moveLesson(1)}>↓</button>
                  <button type="button" style={dangerBtn} disabled={busy} onClick={() => void deleteLesson()}>{L(locale, '移除', 'Remove')}</button>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                <Chip tone={activeLessonLoc?.video ? 'green' : 'grey'}>{L(locale, '视频', 'Video')} {activeLessonLoc?.video ? '✓' : '—'}</Chip>
                <Chip>{fmtDuration(activeLessonLoc?.videoDurationSeconds)}</Chip>
                <Chip>{L(locale, '学习点', 'LPs')} {activeLesson.learningPoints.length}</Chip>
                <Chip>{L(locale, '展品', 'Exhibits')} {activeLesson.exhibits.length}</Chip>
                <Chip>{L(locale, '知识测试', 'Knowledge')} {activeLesson.questions.length}</Chip>
                <Chip>{L(locale, '阅读', 'Reading')} {activeLesson.readings.length}</Chip>
                <Chip tone={activeLesson.applicationTest ? 'green' : 'grey'}>{L(locale, '应用测试', 'Application')} {activeLesson.applicationTest ? '✓' : '—'}</Chip>
              </div>
              <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <label style={{ ...buttonStyle, display: 'inline-flex', alignItems: 'center', cursor: busy ? 'not-allowed' : 'pointer' }}>
                  {L(locale, '上传视频', 'Upload video')}
                  <input type="file" accept="video/*" disabled={busy} style={{ display: 'none' }} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadLessonVideo(file); event.currentTarget.value = ''; }} />
                </label>
                <span style={{ fontSize: 12, opacity: 0.65 }}>{L(locale, '上传后自动解析时长。', 'Duration is parsed after upload.')}</span>
              </div>
              <p style={{ fontSize: 12, opacity: 0.65, marginTop: 8 }}>
                {L(locale, '视频 / 展品 / 测试 / 阅读来自导入的课程包；此页可编辑标题、描述与文本正文。保存只改草稿。', 'Video / exhibits / tests / reading come from the imported package; title, description and text are editable here. Saving only changes the draft.')}
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
                <label style={labelStyle}>{L(locale, '课时 ID', 'Lesson ID')}<input name="lessonCode" defaultValue={activeLesson.code} style={inputStyle} /></label>
                <label style={labelStyle}>{L(locale, '课时标题', 'Lesson title')}<input name="lessonTitle" required defaultValue={activeLessonLoc?.title ?? ''} style={inputStyle} /></label>
              </div>
              <label style={labelStyle}>{L(locale, '描述', 'Description')}<textarea name="lessonDescription" rows={2} defaultValue={activeLessonLoc?.description ?? ''} style={inputStyle} /></label>
              <label style={labelStyle}>{L(locale, '学习与探索 · 文本（Markdown/HTML）', 'Study & Exploration · Text (Markdown/HTML)')}<textarea name="lessonText" rows={16} defaultValue={activeLessonLoc?.textHtml ?? ''} style={{ ...inputStyle, marginTop: 6, fontFamily: 'monospace' }} /></label>
              <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                <button type="submit" disabled={busy} style={primaryBtn}>{L(locale, '保存', 'Save')}</button>
                <button type="submit" disabled={busy} style={buttonStyle} onClick={() => { nextTab.current = 'trial'; }}>{L(locale, '保存并下一步', 'Save & next')}</button>
              </div>
            </form>
          ) : (
            <div style={card}><p style={{ margin: 0, opacity: 0.7 }}>{L(locale, '添加一个课时开始编辑。', 'Add a lesson to start editing.')}</p></div>
          )}
        </div>
      )}

      {tab === 'trial' && trial && (
        <TrialAndPricing
          locale={locale}
          courseId={courseId}
          trial={trial}
          plans={defaultPlans}
          busy={busy}
          onReload={load}
          onNotice={setNotice}
          onBusy={setBusy}
        />
      )}

      {tab === 'versions' && (
        <div>
          <div style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 18 }}>{L(locale, '当前草稿', 'Current draft')}</h2>
                <p style={{ margin: '8px 0 0', fontSize: 13, opacity: 0.75 }}>
                  {course.hasDraft ? L(locale, 'Draft · ', 'Draft · ') : L(locale, 'No draft · ', 'No draft · ')}
                  {course.completeness.completedSteps} of 3 {L(locale, '步完成', 'steps complete')}
                </p>
                {course.completeness.publishBlockers.length > 0 && (
                  <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: '#9A6B00', fontSize: 13 }}>
                    {course.completeness.publishBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
                  </ul>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <label style={{ ...buttonStyle, display: 'inline-flex', alignItems: 'center', cursor: busy ? 'not-allowed' : 'pointer' }}>
                  {L(locale, '导入课程包', 'Import package')}
                  <input
                    type="file"
                    accept=".zip,.lgcourse.zip"
                    disabled={busy}
                    style={{ display: 'none' }}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void importPackage(file);
                      event.currentTarget.value = '';
                    }}
                  />
                </label>
                <button type="button" style={buttonStyle} disabled={busy || !course.hasDraft || !course.liveVersionId} onClick={() => void deleteDraft()}>
                  {L(locale, '删除草稿', 'Delete draft')}
                </button>
                <button type="button" style={primaryBtn} disabled={busy || !course.hasDraft || !course.completeness.canPublish} onClick={() => void publish()} title={course.completeness.publishBlockers.join(' ')}>
                  {L(locale, 'Publish', 'Publish')}
                </button>
              </div>
            </div>
          </div>

          <div style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>{L(locale, '线上版本', 'Live version')}</h2>
              {liveVersion && <Chip tone={course.liveStatus === 'ONLINE' ? 'green' : 'grey'}>{liveVersion.versionLabel} · {course.liveStatus}</Chip>}
            </div>
            {liveVersion ? (
              <div style={{ marginTop: 12, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, opacity: 0.75 }}>{L(locale, '发布于', 'Live since')} {formatTime(liveVersion.wentLiveAt ?? liveVersion.createdAt)}</span>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <select value={statusTarget} onChange={(event) => setStatusTarget(event.target.value as 'ONLINE' | 'HIDDEN' | 'OFFLINE')} style={{ padding: 7, borderRadius: 8 }}>
                    {['ONLINE', 'HIDDEN', 'OFFLINE'].map((status) => <option key={status} value={status}>{status === course.liveStatus ? `${status} (current)` : status}</option>)}
                  </select>
                  <input value={statusReason} onChange={(event) => setStatusReason(event.target.value)} placeholder={L(locale, '变更原因（必填）', 'Reason (required)')} style={{ padding: 7, borderRadius: 8, border: '1px solid #d9e0ea', width: 220 }} />
                  <button type="button" style={buttonStyle} disabled={busy} onClick={() => void changeStatus()}>{L(locale, 'Change status', 'Change status')}</button>
                </div>
              </div>
            ) : (
              <p style={{ margin: '10px 0 0', opacity: 0.7 }}>{L(locale, '尚未发布。首次发布后会变为 Offline，再手动改为 Online 才上线。', 'Not published yet. The first publish becomes Offline; change it to Online to go live.')}</p>
            )}
            <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#25314C' }}>{L(locale, '导出课程包', 'Export package')}</span>
              <select
                value={liveVersion ? exportVersion : exportVersion === 'live' ? 'draft' : exportVersion}
                onChange={(event) => setExportVersion(event.target.value)}
                style={{ padding: 7, borderRadius: 8 }}
              >
                <option value="live" disabled={!liveVersion}>{L(locale, '线上版本', 'Live version')}</option>
                <option value="draft">{L(locale, '当前草稿', 'Current draft')}</option>
                {versions.filter((version) => !version.isLive).map((version) => (
                  <option key={version.id} value={version.versionLabel}>{version.versionLabel}{version.exportedAt ? L(locale, '（已导出）', ' (exported)') : ''}</option>
                ))}
              </select>
              <button
                type="button"
                style={buttonStyle}
                disabled={busy}
                onClick={() => void exportPackage(!liveVersion && exportVersion === 'live' ? 'draft' : exportVersion)}
              >
                {L(locale, '开始导出', 'Start export')}
              </button>
              {exportJob && <span style={{ fontSize: 12, opacity: 0.75 }}>{exportJob.status} {exportJob.progress}% {exportJob.fileName ?? ''}</span>}
              <span style={{ fontSize: 12, opacity: 0.6 }}>
                {L(locale, '导出草稿不会产生版本；导出线上/历史版本会标记为已导出。', 'Exporting the draft creates no version; exporting a live/historical version marks it as exported.')}
              </span>
            </div>
          </div>

          <div style={card}>
            <h2 style={{ margin: 0, fontSize: 18 }}>{L(locale, '版本', 'Versions')}</h2>
            <p style={{ fontSize: 12, opacity: 0.6, marginTop: 6 }}>
              {L(locale, 'Sandbox 编号 1.1、1.2…，导出后下一次发布进入下一整数系列；Production 为 Version 1、2、3…。版本不可删除。', 'Sandbox uses 1.1, 1.2… and starts the next series after export; Production uses Version 1, 2, 3… Versions cannot be deleted.')}
            </p>
            <table className="table" style={{ width: '100%', marginTop: 12 }}>
              <thead>
                <tr>
                  <th>{L(locale, '版本', 'Version')}</th>
                  <th>{L(locale, '来源', 'Source')}</th>
                  <th>{L(locale, '发布时间', 'Published')}</th>
                  <th>{L(locale, '导出', 'Exported')}</th>
                  <th>{L(locale, '操作', 'Actions')}</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((version) => (
                  <tr key={version.id}>
                    <td><strong>{version.versionLabel}</strong>{version.isLive ? <Chip tone="green">Live</Chip> : null}</td>
                    <td>{version.sourceVersionLabel ? `${version.sourceEnvironment ?? ''} ${version.sourceVersionLabel}`.trim() : '—'}</td>
                    <td>{formatTime(version.wentLiveAt ?? version.createdAt)}</td>
                    <td>{version.exportedAt ? formatTime(version.exportedAt) : '—'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button type="button" className="button buttonGhost" onClick={() => window.open(`/${locale}/course/${courseId}/preview?versionId=${version.id}`, '_blank')}>{L(locale, '查看', 'View')}</button>
                        {!version.isLive && <button type="button" className="button buttonGhost" disabled={busy} onClick={() => void restoreVersion(version)}>{L(locale, 'Restore', 'Restore')}</button>}
                      </div>
                    </td>
                  </tr>
                ))}
                {versions.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', padding: 18, opacity: 0.7 }}>{L(locale, '暂无版本。', 'No versions yet.')}</td></tr>}
              </tbody>
            </table>
          </div>

          <div style={card}>
            <h2 style={{ margin: 0, fontSize: 18 }}>{L(locale, 'History', 'History')}</h2>
            <table className="table" style={{ width: '100%', marginTop: 12 }}>
              <thead><tr><th>{L(locale, '时间', 'Time')}</th><th>{L(locale, '操作人', 'Operator')}</th><th>{L(locale, '操作', 'Action')}</th><th style={{ textAlign: 'left' }}>{L(locale, '详情', 'Detail')}</th></tr></thead>
              <tbody>
                {(history?.items ?? []).map((item) => (
                  <tr key={item.id}>
                    <td>{formatTime(item.time)}</td>
                    <td>{item.operator}</td>
                    <td>{item.action}</td>
                    <td className="cellWrap" style={{ fontSize: 12, opacity: 0.8 }} title={describeHistory(item.detail, item.versionNo)}>{describeHistory(item.detail, item.versionNo)}</td>
                  </tr>
                ))}
                {(history?.items.length ?? 0) === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', padding: 18, opacity: 0.7 }}>{L(locale, '暂无记录。', 'No history yet.')}</td></tr>}
              </tbody>
            </table>
            {history && history.pages > 1 && (
              <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'center' }}>
                <button type="button" style={buttonStyle} disabled={historyPage <= 1} onClick={() => setHistoryPage((p) => Math.max(1, p - 1))}>←</button>
                <span style={{ fontSize: 13, alignSelf: 'center' }}>{history.page} / {history.pages}</span>
                <button type="button" style={buttonStyle} disabled={historyPage >= history.pages} onClick={() => setHistoryPage((p) => Math.min(history.pages, p + 1))}>→</button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function TrialAndPricing({
  locale,
  courseId,
  trial,
  plans,
  busy,
  onReload,
  onNotice,
  onBusy,
}: {
  locale: string;
  courseId: string;
  trial: TrialSettings;
  plans: CoursePlan[];
  busy: boolean;
  onReload: () => Promise<void>;
  onNotice: (message: string) => void;
  onBusy: (value: boolean) => void;
}) {
  const [enabled, setEnabled] = useState(trial.enabled);
  const [rows, setRows] = useState<TrialRow[]>(trial.rows);
  const [localPlans, setLocalPlans] = useState<CoursePlan[]>(plans);

  useEffect(() => {
    setEnabled(trial.enabled);
    setRows(trial.rows);
  }, [trial]);

  useEffect(() => {
    setLocalPlans(plans);
  }, [plans]);

  async function saveTrial() {
    onBusy(true);
    const payload = rows
      .filter((row) => row.inTrial)
      .map((row) => ({
        lessonId: row.lessonId,
        videoCutoffSeconds: row.videoCutoffSeconds,
        textCutoffLearningPointId: row.textCutoffLearningPointId,
      }));
    const saved = await boRequest(`/api/backoffice/courses/${courseId}/trial`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled, rows: payload }),
    });
    onBusy(false);
    if (saved.success) {
      onNotice(locale.startsWith('zh') ? '试看设置已保存，立即在本环境网站生效（不生成版本）。' : 'Trial settings saved and effective immediately in this environment (no version created).');
      await onReload();
    } else {
      onNotice(`Trial save failed: ${saved.error}`);
    }
  }

  function toggleRow(lessonId: string) {
    setRows((current) => {
      const index = current.findIndex((row) => row.lessonId === lessonId);
      if (index < 0) return current;
      const next = current.map((row, rowIndex) => (rowIndex === index ? { ...row, inTrial: !row.inTrial } : row));
      // 试看 Lesson 必须从 Lesson 01 连续：勾选某项时自动勾选前面的课时，取消时取消后面的。
      const target = next[index];
      if (target.inTrial) {
        for (let i = 0; i < index; i++) next[i] = { ...next[i], inTrial: true };
      } else {
        for (let i = index; i < next.length; i++) next[i] = { ...next[i], inTrial: false };
      }
      return next;
    });
  }

  function updateRow(lessonId: string, patch: Partial<TrialRow>) {
    setRows((current) => current.map((row) => (row.lessonId === lessonId ? { ...row, ...patch } : row)));
  }

  function addPlan() {
    setLocalPlans((current) => [
      ...current,
      {
        id: `new-${Date.now()}`,
        name: '',
        termMonths: 1,
        amountMinor: 1000,
        currency: 'usd',
        stripeLookupKey: null,
        stripeProductId: null,
        stripePriceId: null,
        lastSyncedAt: null,
        syncError: null,
      },
    ]);
  }

  async function savePlans() {
    onBusy(true);
    const result = await boRequest<{ plans: CoursePlan[]; sync: Array<{ status: string; error?: string }> }>(
      `/api/backoffice/courses/${courseId}/plans`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          plans: localPlans.map((plan) => ({
            id: plan.id.startsWith('new-') ? undefined : plan.id,
            name: plan.name,
            termMonths: Number(plan.termMonths),
            amountMinor: Number(plan.amountMinor),
            currency: plan.currency,
          })),
        }),
      },
    );
    onBusy(false);
    if (result.success) {
      const failed = result.data.sync.filter((entry) => entry.status === 'FAILED' || entry.status === 'NOT_CONFIGURED');
      onNotice(
        failed.length
          ? `Plans saved. Stripe sync: ${failed.map((entry) => entry.error ?? entry.status).join('; ')}`
          : locale.startsWith('zh')
            ? '套餐已保存，Stripe 价格已同步。'
            : 'Plans saved and Stripe prices synced.',
      );
      await onReload();
    } else {
      onNotice(`Plans save failed: ${result.error}`);
    }
  }

  async function retrySync(planId: string) {
    onBusy(true);
    const result = await boRequest<{ status: string; error?: string }>(`/api/backoffice/courses/${courseId}/plans/${planId}/sync-stripe`, { method: 'POST' });
    onBusy(false);
    onNotice(result.success ? `Stripe sync: ${result.data.status}${result.data.error ? ` — ${result.data.error}` : ''}` : `Sync failed: ${result.error}`);
    await onReload();
  }

  return (
    <div>
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>{locale.startsWith('zh') ? '试看设置' : 'Trial'}</h2>
            <p style={{ margin: '6px 0 0', fontSize: 12, opacity: 0.65 }}>
              {locale.startsWith('zh') ? '试看直接引用正式学习内容；保存后立即生效，不生成版本。' : 'Trial references the real learning content; saving is effective immediately and creates no version.'}
            </p>
          </div>
          <label style={{ fontSize: 14 }}>
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> {locale.startsWith('zh') ? '启用试看' : 'Trial enabled'}
          </label>
        </div>

        {enabled && (
          <table className="table" style={{ width: '100%', marginTop: 12 }}>
            <thead>
              <tr>
                <th>{locale.startsWith('zh') ? '试看' : 'In trial'}</th>
                <th>{locale.startsWith('zh') ? '课时' : 'Lesson'}</th>
                <th>{locale.startsWith('zh') ? '视频时长' : 'Video'}</th>
                <th>{locale.startsWith('zh') ? '视频截止点（秒）' : 'Video cut-off (s)'}</th>
                <th>{locale.startsWith('zh') ? '文本截止学习点' : 'Text cut-off LP'}</th>
                <th>{locale.startsWith('zh') ? '状态' : 'Status'}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.lessonId}>
                  <td><input type="checkbox" checked={row.inTrial} onChange={() => toggleRow(row.lessonId)} /></td>
                  <td>{row.index}. {row.title}</td>
                  <td>{fmtDuration(row.videoDurationSeconds)}</td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      value={row.videoCutoffSeconds ?? ''}
                      disabled={!row.inTrial}
                      onChange={(event) => updateRow(row.lessonId, { videoCutoffSeconds: event.target.value === '' ? null : Number(event.target.value) })}
                      style={{ width: 100, padding: 6 }}
                    />
                  </td>
                  <td>
                    <select
                      value={row.textCutoffLearningPointId ?? ''}
                      disabled={!row.inTrial}
                      onChange={(event) => updateRow(row.lessonId, { textCutoffLearningPointId: event.target.value || null })}
                      style={{ padding: 6, maxWidth: 220 }}
                    >
                      <option value="">—</option>
                      {row.learningPoints.map((lp) => <option key={lp.id} value={lp.id}>{lp.code} · {lp.title}</option>)}
                    </select>
                  </td>
                  <td>
                    <Chip tone={row.status === 'READY' ? 'green' : row.status === 'RE_CONFIRM' ? 'amber' : 'grey'}>{row.inTrial ? row.status : 'LOCKED'}</Chip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ marginTop: 14 }}>
          <button type="button" style={primaryBtn} disabled={busy} onClick={() => void saveTrial()}>{locale.startsWith('zh') ? '保存试看' : 'Save trial'}</button>
        </div>
      </div>

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{locale.startsWith('zh') ? '价格（订阅 · USD）' : 'Pricing (subscription · USD)'}</h2>
          <button type="button" style={buttonStyle} disabled={busy} onClick={addPlan}>{locale.startsWith('zh') ? '+ 添加套餐' : '+ Add plan'}</button>
        </div>
        <table className="table" style={{ width: '100%', marginTop: 12 }}>
          <thead>
            <tr>
              <th>{locale.startsWith('zh') ? '名称' : 'Name'}</th>
              <th>{locale.startsWith('zh') ? '周期（月）' : 'Billing (months)'}</th>
              <th>{locale.startsWith('zh') ? '金额（美分）' : 'Amount (minor)'}</th>
              <th>{locale.startsWith('zh') ? 'Lookup key' : 'Lookup key'}</th>
              <th>Stripe</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {localPlans.map((plan) => (
              <tr key={plan.id}>
                <td><input value={plan.name} onChange={(event) => setLocalPlans((current) => current.map((item) => item.id === plan.id ? { ...item, name: event.target.value } : item))} style={{ padding: 6, width: '100%' }} /></td>
                <td><input type="number" min={1} value={plan.termMonths} onChange={(event) => setLocalPlans((current) => current.map((item) => item.id === plan.id ? { ...item, termMonths: Number(event.target.value) } : item))} style={{ padding: 6, width: 90 }} /></td>
                <td><input type="number" min={0} value={plan.amountMinor} onChange={(event) => setLocalPlans((current) => current.map((item) => item.id === plan.id ? { ...item, amountMinor: Number(event.target.value) } : item))} style={{ padding: 6, width: 120 }} /></td>
                <td style={{ fontSize: 12 }}>{plan.stripeLookupKey ?? '—'}</td>
                <td style={{ fontSize: 12 }}>
                  {plan.syncError ? <span style={{ color: '#b42318' }}>Failed</span> : plan.lastSyncedAt ? <span style={{ color: '#1E7A3C' }}>Synced</span> : '—'}
                  {plan.syncError && <div style={{ opacity: 0.75 }}>{plan.syncError}</div>}
                </td>
                <td>
                  {!plan.id.startsWith('new-') && (
                    <button type="button" className="button buttonGhost" disabled={busy} onClick={() => void retrySync(plan.id)}>{locale.startsWith('zh') ? '重试' : 'Retry'}</button>
                  )}
                </td>
              </tr>
            ))}
            {localPlans.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', padding: 18, opacity: 0.7 }}>{locale.startsWith('zh') ? '暂无套餐。' : 'No plans yet.'}</td></tr>}
          </tbody>
        </table>
        <div style={{ marginTop: 14 }}>
          <button type="button" style={primaryBtn} disabled={busy} onClick={() => void savePlans()}>{locale.startsWith('zh') ? '保存并同步 Stripe' : 'Save & sync Stripe'}</button>
        </div>
      </div>
    </div>
  );
}

function formatTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function describeHistory(detail: unknown, versionNo: number | null): string {
  if (detail && typeof detail === 'object') {
    const record = detail as Record<string, unknown>;
    const parts = Object.entries(record)
      .filter(([, value]) => value !== null && value !== undefined && typeof value !== 'object')
      .map(([key, value]) => `${key}: ${String(value)}`);
    if (parts.length) return parts.join(' · ');
  }
  return versionNo ? `Version ${versionNo}` : '—';
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
