import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import type {
  CourseDetail,
  CourseVersion,
  HistoryPage,
  TrialSettings,
} from '../contracts/course';
import { useEmployee } from '../employeeSession';
import { boRequest, type ApiFailure } from '../lib/api';
import { courseErrorText, courseFailureNotice, failureNeedsReload, isStale } from '../lib/courseErrors';
import { t } from '../lib/i18n/messages';
import type { Locale } from '../lib/i18n/config';
import { isActionAllowed } from '../rbac/permissions';
import { categoryLabel } from '../lib/categoryLabel';
import { FailureProvider } from './course-editor/feedback';

import { CourseInfoSection } from './course-editor/CourseInfoSection';
import { CourseContentSection } from './course-editor/CourseContentSection';
import { CourseTrialSection } from './course-editor/CourseTrialSection';
import { CourseVersionsSection } from './course-editor/CourseVersionsSection';
import { L, buttonStyle, fmtDate, inputStyle, languageLabel, learningModeLabel, liveStatusLabel, primaryBtn } from './course-editor/shared-utils';

type Tab = 'info' | 'content' | 'trial' | 'versions';

export function CourseEditorPage() {
  const { courseId = '', locale = 'en-GB' } = useParams();
  const navigate = useNavigate();
  // REQ-0236：Edit 级（Graphic Designer）只改已有课程内容；发布 / 导入导出 / 上下线 /
  // 恢复版本，以及试看和价格（商业配置）只给 Course=Full。后端是最终边界，这里只收起按钮。
  const employee = useEmployee();
  const canPublish = isActionAllowed(employee.role, 'course', 'PUBLISH');
  const canManageCommerce = isActionAllowed(employee.role, 'course', 'CREATE');
  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [trial, setTrial] = useState<TrialSettings | null>(null);
  const [versions, setVersions] = useState<CourseVersion[]>([]);
  const [history, setHistory] = useState<HistoryPage | null>(null);
  const [historyPage, setHistoryPage] = useState(1);
  const [tab, setTab] = useState<Tab>('info');
  const [activeLessonId, setActiveLessonId] = useState('');
  const [contentLanguage, setContentLanguage] = useState('en-GB');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  // 失败提示按服务器的错误码写成当前语言；stale = 别人在你打开后保存过（页面上已输入的内容保持不动，由用户决定是否重新载入）。
  const [failure, setFailure] = useState<{ text: string; stale: boolean } | null>(null);
  const [categories, setCategories] = useState<Array<{ id: string; name: string }>>([]);
  const languageInitFor = useRef('');

  const showNotice = useCallback((message: string) => {
    setFailure(null);
    setNotice(message);
  }, []);
  const reportFailure = useCallback(
    (action: string, result: ApiFailure) => {
      setNotice('');
      setFailure({
        text: isStale(result) ? courseErrorText(locale, result) : courseFailureNotice(locale, action, result),
        stale: isStale(result) || failureNeedsReload(result),
      });
    },
    [locale],
  );

  const fetchLoad = useCallback(() => {
    return Promise.all([
      boRequest<CourseDetail>(`/api/backoffice/courses/${courseId}`),
      boRequest<TrialSettings>(`/api/backoffice/courses/${courseId}/trial`),
      boRequest<CourseVersion[]>(`/api/backoffice/courses/${courseId}/versions`),
      boRequest<HistoryPage>(
        `/api/backoffice/courses/${courseId}/history?page=${historyPage}&pageSize=20`,
      ),
      boRequest<Array<{ id: string; name: string }>>(`/api/backoffice/courses/categories`),
    ]).then(([detail, trialResult, versionsResult, historyResult, categoriesResult]) => {
      setLoading(false);
      if (!detail.success) {
        reportFailure(L(locale, '课程加载失败', 'Could not load course'), detail);
        return;
      }
      setFailure(null);
      setCourse(detail.data);
      // 保存后会重新载入：正在编辑的内容语言保持不变，只有它已不在学习语言里才回到默认语言。
      const firstLoad = languageInitFor.current !== detail.data.id;
      languageInitFor.current = detail.data.id;
      setContentLanguage((current) =>
        !firstLoad && detail.data.learningLanguages.includes(current)
          ? current
          : detail.data.defaultContentLanguage || detail.data.learningLanguages[0] || 'en-GB',
      );
      setActiveLessonId((current) =>
        detail.data.lessons.some((lesson) => lesson.id === current)
          ? current
          : detail.data.lessons[0]?.id || '',
      );
      if (trialResult.success) setTrial(trialResult.data);
      if (versionsResult.success) setVersions(versionsResult.data);
      if (historyResult.success) setHistory(historyResult.data);
      if (categoriesResult.success) setCategories(categoriesResult.data);
    });
  }, [courseId, historyPage, locale, reportFailure]);

  const [loadSource, setLoadSource] = useState(() => ({ courseId, historyPage, locale }));
  if (
    loadSource.courseId !== courseId ||
    loadSource.historyPage !== historyPage ||
    loadSource.locale !== locale
  ) {
    setLoadSource({ courseId, historyPage, locale });
    setLoading(true);
  }
  const load = useCallback(() => {
    setLoading(true);
    return fetchLoad();
  }, [fetchLoad]);

  useEffect(() => {
    void fetchLoad();
  }, [fetchLoad]);

  const liveVersion = useMemo(() => versions.find((version) => version.isLive), [versions]);
  const localizedCategories = useMemo(
    () => categories.map((category) => ({ ...category, name: categoryLabel(locale, category.name) })),
    [categories, locale],
  );
  const stepLabel = (complete: boolean) => L(locale, complete ? '已完成' : '未完成', complete ? 'Complete' : 'Incomplete');

  if (loading || !course) {
    return <section className="card cardGrow"><p style={{ margin: 0, opacity: 0.7 }}>{L(locale, '加载中…', 'Loading…')}</p>{(failure || notice) && <p style={{ color: '#b42318' }}>{failure?.text ?? notice}</p>}</section>;
  }

  return (
    <FailureProvider value={reportFailure}>
    <section className="card cardGrow" style={{ overflow: 'auto' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" style={buttonStyle} onClick={() => navigate(`/${locale}/course`)}>← {L(locale, '课程列表', 'Course Overview')}</button>
          <div>
            <h1 style={{ margin: 0, fontSize: 24 }}>{course.localizations.find((item) => item.language === 'en-GB')?.title?.trim() || course.localizations.find((item) => item.title.trim())?.title || course.code}</h1>
            <div style={{ fontSize: 12, color: '#5A6577', marginTop: 4 }}>
              {course.code} · {course.category ? categoryLabel(locale, course.category.name) : L(locale, '未分类', 'Uncategorized')} · {learningModeLabel(locale, course.learningMode)} · {course.learningLanguages.map((language) => languageLabel(locale, language)).join(', ')} · {course.lessons.length} {L(locale, '个课时', 'lessons')}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" style={buttonStyle} onClick={() => void load()}>{L(locale, '重新加载', 'Reload')}</button>
          <button type="button" style={buttonStyle} onClick={() => navigate(`/${locale}/course/${course.id}/preview`)}>{L(locale, '学员视角预览', 'Preview as learner')}</button>
          <button type="button" style={primaryBtn} onClick={() => setTab('versions')}>{L(locale, '版本与发布', 'Versions & publishing')}</button>
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 16 }}>
        <div style={{ border: '1px solid #E8EDF5', borderRadius: 10, padding: 14, background: '#FFF9F2' }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>{L(locale, '草稿', 'DRAFT')}</div>
          <div style={{ fontSize: 13 }}>
            {course.hasDraft ? L(locale, '未发布', 'Not published') : L(locale, '无草稿', 'No draft')}
            {course.hasDraft ? ` · ${L(locale, `已完成 ${course.completeness.completedSteps}/3 步`, `${course.completeness.completedSteps} of 3 steps complete`)}` : ''}
          </div>
          <div style={{ marginTop: 8 }}><button type="button" style={buttonStyle} onClick={() => setTab('versions')}>{L(locale, '前往版本 →', 'Go to Versions →')}</button></div>
        </div>
        <div style={{ border: '1px solid #E8EDF5', borderRadius: 10, padding: 14, background: '#F5F8FF' }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>{L(locale, '线上', 'LIVE')}</div>
          <div style={{ fontSize: 13 }}>
            {liveVersion ? `${liveVersion.versionLabel} · ${liveStatusLabel(locale, course.liveStatus)} · ${fmtDate(liveVersion.wentLiveAt ?? liveVersion.createdAt, locale)}` : L(locale, '从未发布', 'Not published')}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16, borderBottom: '1px solid #E8EDF5', paddingBottom: 10 }}>
        {[
          { id: 'info', label: `1 ${L(locale, '课程信息', 'Course Information')}`, complete: course.completeness.steps.courseInformation.complete },
          { id: 'content', label: `2 ${L(locale, '课程内容', 'Course Content')}`, complete: course.completeness.steps.content.complete },
          { id: 'trial', label: `3 ${L(locale, '试看设置', 'Trial')}`, complete: course.completeness.steps.trial.complete },
          { id: 'versions', label: L(locale, '版本与发布', 'Versions & publishing'), complete: true },
        ].map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id as Tab)}
            style={{
              ...buttonStyle,
              borderColor: tab === item.id ? '#2B58C8' : '#d9e0ea',
              color: tab === item.id ? '#2B58C8' : '#25314C',
              fontWeight: tab === item.id ? 700 : 400,
            }}
          >
            {item.label} · {stepLabel(item.complete)}
          </button>
        ))}
        {course.learningLanguages.length > 1 && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#5A6577' }}>{L(locale, '内容语言', 'Content language')}</span>
            <select value={contentLanguage} onChange={(event) => setContentLanguage(event.target.value)} style={inputStyle}>
              {course.learningLanguages.map((language) => <option key={language} value={language}>{languageLabel(locale, language)}</option>)}
            </select>
          </div>
        )}
      </div>

      {failure && (
        <div role="alert" data-testid="course-failure" data-stale={failure.stale ? 'true' : 'false'} style={{ padding: 10, background: failure.stale ? '#FFF6E5' : '#FDECEC', border: failure.stale ? '1px solid #F2D49B' : undefined, borderRadius: 8, marginTop: 14, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 240 }}>{failure.text}</span>
          {failure.stale && (
            <>
              <button type="button" data-testid="course-failure-reload" style={primaryBtn} onClick={() => void load()}>{t(locale as Locale, 'course.ui.staleReload')}</button>
              <button type="button" style={buttonStyle} onClick={() => setFailure(null)}>{t(locale as Locale, 'course.ui.staleKeep')}</button>
            </>
          )}
        </div>
      )}
      {notice && <p role="status" style={{ padding: 10, background: '#F3F7FF', borderRadius: 8, marginTop: 14 }}>{notice}</p>}

      <div style={{ marginTop: 16 }}>
        {tab === 'info' && <CourseInfoSection locale={locale} course={course} categories={localizedCategories} busy={busy} setBusy={setBusy} onReload={load} onNotice={showNotice} onNext={() => setTab('content')} />}
        {tab === 'content' && <CourseContentSection locale={locale} course={course} activeLessonId={activeLessonId} setActiveLessonId={setActiveLessonId} contentLanguage={contentLanguage} busy={busy} setBusy={setBusy} onReload={load} onNotice={showNotice} />}
        {tab === 'trial' && trial && <CourseTrialSection canManage={canManageCommerce} locale={locale} courseId={course.id} trial={trial} course={course} busy={busy} setBusy={setBusy} onReload={load} onNotice={showNotice} contentLanguage={contentLanguage} />}
        {tab === 'versions' && <CourseVersionsSection canPublish={canPublish} locale={locale} course={course} versions={versions} history={history} historyPage={historyPage} setHistoryPage={setHistoryPage} busy={busy} setBusy={setBusy} onReload={load} onNotice={showNotice} />}
      </div>
    </section>
    </FailureProvider>
  );
}
