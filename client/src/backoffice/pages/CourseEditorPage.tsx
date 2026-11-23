import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import type {
  CourseDetail,
  CourseIssue,
  CourseVersion,
  HistoryPage,
  PortalPreviewLink,
  TrialSettings,
} from '../contracts/course';
import { boRequest, type ApiFailure } from '../lib/api';
import { courseErrorText, courseFailureNotice, failureNeedsReload, isStale } from '../lib/courseErrors';
import { t } from '../lib/i18n/messages';
import type { Locale } from '../lib/i18n/config';
import { cachedPreviewEntry } from '../lib/capabilities';
import { useCoursePermissions } from '../lib/coursePermissions';
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
  // 账号级课程动作（旧服务端回退角色矩阵）：
  // 编辑内容 = course.edit；试看与价格（商业配置）= course.create；
  // 发布/导入导出/上下线/恢复在 Versions 区各自判定，不再用一个 canPublish 全收。
  const permissions = useCoursePermissions();
  const canEdit = permissions.edit;
  const canManageCommerce = permissions.create;
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
  // 就近反馈：保存/操作结果显示在右下角 toast，不再只显示在页面顶部（长页面在底部操作时看不到）。
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
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

  // 失败一直显示到手动关闭；成功 4 秒后自动消失。顶部条保留（stale 时需要“重新载入”按钮）。
  useEffect(() => {
    if (failure) setToast({ kind: 'error', text: failure.text });
  }, [failure]);
  useEffect(() => {
    if (!notice) return;
    setToast({ kind: 'success', text: notice });
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // 预览入口（PREVIEW_ENTRY）：learner = 上游学员视角预览页；portal = 生产投影渲染草稿（一次点击生成链接并打开）。
  const previewEntry = cachedPreviewEntry();
  const [previewOpening, setPreviewOpening] = useState(false);

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
  // 已经打开的课程重新载入时留在原页面（不闪"加载中"）：否则每次保存后，正在看的部分、视频/文字标签都会被重置。
  const load = useCallback(() => {
    if (!course) setLoading(true);
    return fetchLoad();
  }, [course, fetchLoad]);

  useEffect(() => {
    void fetchLoad();
  }, [fetchLoad]);

  async function openPreview() {
    if (previewEntry !== 'portal') {
      navigate(`/${locale}/course/${courseId}/preview`);
      return;
    }
    if (!course) return;
    // portal 模式：一次点击生成短时效预览链接并在新标签打开（草稿不带 versionId）。
    // popup 必须在 await 前同步打开，避免被浏览器当作弹窗拦截。
    setPreviewOpening(true);
    const popup = window.open('about:blank', '_blank');
    const query = new URLSearchParams({ locale });
    const result = await boRequest<PortalPreviewLink>(
      `/api/backoffice/courses/${course.id}/portal-preview?${query.toString()}`,
    );
    setPreviewOpening(false);
    if (!result.success) {
      popup?.close();
      setNotice(
        `${L(locale, '无法生成 Portal 预览链接。', 'Could not create Portal preview link.')} ${result.message ?? result.error}`,
      );
      return;
    }
    if (popup) {
      popup.opener = null;
      popup.location.href = result.data.url;
      return;
    }
    window.open(result.data.url, '_blank', 'noopener,noreferrer');
  }

  const liveVersion = useMemo(() => versions.find((version) => version.isLive), [versions]);
  const localizedCategories = useMemo(
    () => categories.map((category) => ({ ...category, name: categoryLabel(locale, category.name) })),
    [categories, locale],
  );
  const stepLabel = (complete: boolean) => L(locale, complete ? '已完成' : '未完成', complete ? 'Complete' : 'Incomplete');

  if (loading || !course) {
    return <section className="card cardGrow"><p style={{ margin: 0, opacity: 0.7 }}>{L(locale, '加载中…', 'Loading…')}</p>{(failure || notice) && <p style={{ color: '#b42318' }}>{failure?.text ?? notice}</p>}</section>;
  }

  // 页签只表达名称与完成标记；状态（草稿 / 线上）只在头部摘要出现一次。
  // 未完成时把服务器给的缺项挂到页签 title 上：保存成功 ≠ 内容完整，用户需要知道缺什么。
  const stepIssues = (step: CourseIssue['step']): string[] => {
    const lines = (course.completeness.issues ?? [])
      .filter((issue) => issue.step === step)
      .map((issue) => issue.message);
    return [...new Set(lines)];
  };
  const steps = [
    { id: 'info' as Tab, index: 1, label: L(locale, '课程信息', 'Course Information'), complete: course.completeness.steps.courseInformation.complete, missing: stepIssues('COURSE_INFORMATION') },
    { id: 'content' as Tab, index: 2, label: L(locale, '课程内容', 'Course Content'), complete: course.completeness.steps.content.complete, missing: stepIssues('COURSE_CONTENT') },
    { id: 'trial' as Tab, index: 3, label: L(locale, '试看设置', 'Trial'), complete: course.completeness.steps.trial.complete, missing: stepIssues('TRIAL') },
    { id: 'versions' as Tab, index: null, label: L(locale, '版本与发布', 'Versions & publishing'), complete: true, missing: [] as string[] },
  ];
  const liveDotClass = course.liveStatus === 'ONLINE' ? 'isOnline' : course.liveStatus === 'HIDDEN' ? 'isHidden' : course.liveStatus === 'OFFLINE' ? 'isOffline' : '';

  return (
    <FailureProvider value={reportFailure}>
    <section className="card cardGrow course-ui-page" data-testid="course-editor-page">
      <header className="course-ui-head">
        <div className="course-ui-headMain">
          <button type="button" className="course-ui-back" style={buttonStyle} onClick={() => navigate(`/${locale}/course`)}>← {L(locale, '课程列表', 'Course Overview')}</button>
          <div className="course-ui-headTitles">
            <h1 className="course-ui-title">{course.localizations.find((item) => item.language === 'en-GB')?.title?.trim() || course.localizations.find((item) => item.title.trim())?.title || course.code}</h1>
            <div className="course-ui-meta">
              <span>{course.code}</span>
              <span>·</span>
              <span>{course.category ? categoryLabel(locale, course.category.name) : L(locale, '未分类', 'Uncategorized')}</span>
              <span>·</span>
              <span>{learningModeLabel(locale, course.learningMode)}</span>
              <span>·</span>
              <span>{course.learningLanguages.map((language) => languageLabel(locale, language)).join(locale.startsWith('zh') ? '、' : ', ')}</span>
              <span>·</span>
              <span>{course.lessons.length} {L(locale, '个课时', 'lessons')}</span>
            </div>
          </div>
        </div>
        <div className="course-ui-headActions">
          <button type="button" style={buttonStyle} onClick={() => void load()}>{L(locale, '重新加载', 'Reload')}</button>
          <button type="button" style={buttonStyle} disabled={previewOpening} onClick={() => void openPreview()}>
            {previewOpening
              ? L(locale, '生成预览链接…', 'Creating preview link…')
              : previewEntry === 'portal'
                ? L(locale, '在 Portal 中预览', 'Preview in Portal')
                : L(locale, '学员视角预览', 'Preview as learner')}
          </button>
          <button type="button" style={primaryBtn} onClick={() => setTab('versions')}>{L(locale, '版本与发布', 'Versions & publishing')}</button>
        </div>
      </header>

      <div className="course-ui-summary" data-testid="course-status-summary">
        <span className="course-ui-summaryGroup" data-testid="course-summary-draft">
          <span className="course-ui-summaryLabel">{L(locale, '草稿', 'DRAFT')}</span>
          <span className="course-ui-summaryStrong">{course.hasDraft ? L(locale, '未发布', 'Not published') : L(locale, '无草稿', 'No draft')}</span>
          {course.hasDraft && (
            <>
              {course.draftSourceType === 'IMPORT' && (
                <>
                  <span className="course-ui-summarySep">·</span>
                  <span data-testid="course-summary-imported">{L(locale, '从课程包导入', 'Imported')}</span>
                </>
              )}
              <span className="course-ui-summarySep">·</span>
              <span>{L(locale, `已完成 ${course.completeness.completedSteps}/3 步`, `${course.completeness.completedSteps} of 3 steps complete`)}</span>
            </>
          )}
        </span>
        <span className="course-ui-summaryDivider" aria-hidden="true" />
        <span className="course-ui-summaryGroup" data-testid="course-summary-live">
          <span className="course-ui-summaryLabel">{L(locale, '线上', 'LIVE')}</span>
          {liveVersion ? (
            <>
              <span className={`course-ui-statusDot ${liveDotClass}`} aria-hidden="true" />
              <span className="course-ui-summaryStrong">{liveStatusLabel(locale, course.liveStatus)}</span>
              <span>{liveVersion.versionLabel}</span>
              <span className="course-ui-summarySep">·</span>
              <span>{fmtDate(liveVersion.wentLiveAt ?? liveVersion.createdAt, locale)}</span>
            </>
          ) : (
            <span>{L(locale, '从未发布', 'Not published')}</span>
          )}
        </span>
        <button type="button" className="course-ui-summaryLink" onClick={() => setTab('versions')}>{L(locale, '前往版本 →', 'Go to Versions →')}</button>
      </div>

      <div className="course-ui-tabs" data-testid="course-tabs">
        {steps.map((item) => (
          <button
            key={item.id}
            type="button"
            className="course-ui-tab"
            aria-pressed={tab === item.id}
            data-testid={`course-tab-${item.id}`}
            data-complete={item.complete ? 'true' : 'false'}
            data-missing-count={item.missing.length}
            title={item.missing.length ? item.missing.join(locale.startsWith('zh') ? '；' : '; ') : undefined}
            onClick={() => setTab(item.id)}
          >
            {item.index !== null && <span className="course-ui-tabIndex">{item.index}</span>}
            <span>{item.label}</span>
            {item.missing.length > 0 && (
              <span className="course-ui-tabMissing" data-testid={`course-tab-missing-${item.id}`} aria-label={L(locale, `缺 ${item.missing.length} 项`, `${item.missing.length} missing`)}>
                {item.missing.length}
              </span>
            )}
            <span
              className={item.complete ? 'course-ui-tabMark isComplete' : 'course-ui-tabMark'}
              role="img"
              aria-label={stepLabel(item.complete)}
              title={stepLabel(item.complete)}
            >
              {item.complete ? '✓' : '○'}
            </span>
          </button>
        ))}
        <span className="course-ui-tabSpacer" aria-hidden="true" />
        {course.learningLanguages.length > 1 && (
          <div className="course-ui-lang">
            <span>{L(locale, '内容语言', 'Content language')}</span>
            <select value={contentLanguage} onChange={(event) => setContentLanguage(event.target.value)} style={inputStyle}>
              {course.learningLanguages.map((language) => <option key={language} value={language}>{languageLabel(locale, language)}</option>)}
            </select>
          </div>
        )}
      </div>

      {failure && (
        <div role="alert" data-testid="course-failure" data-stale={failure.stale ? 'true' : 'false'} className={`course-ui-alert ${failure.stale ? 'isStale' : 'isFailure'}`}>
          <span style={{ flex: 1, minWidth: 240 }}>{failure.text}</span>
          {failure.stale && (
            <>
              <button type="button" data-testid="course-failure-reload" style={primaryBtn} onClick={() => void load()}>{t(locale as Locale, 'course.ui.staleReload')}</button>
              <button type="button" style={buttonStyle} onClick={() => setFailure(null)}>{t(locale as Locale, 'course.ui.staleKeep')}</button>
            </>
          )}
        </div>
      )}
      {notice && <p role="status" className="course-ui-alert" style={{ background: '#F3F7FF', marginTop: 10 }}>{notice}</p>}

      {(tab !== 'versions' && (tab === 'trial' ? !canManageCommerce : !canEdit)) && (
        <p role="status" className="course-ui-alert" data-testid="course-readonly" style={{ background: '#F3F7FF', marginTop: 10 }}>
          {L(locale, '只读：你的账号没有修改此内容的权限。', 'Read-only: your account is not allowed to change this content.')}
        </p>
      )}
      <div className="course-ui-panel" data-course-tab-panel data-testid={`course-tab-panel-${tab}`}>
        <div style={{ display: 'contents' }} inert={tab === 'trial' ? !canManageCommerce : tab === 'versions' ? false : !canEdit}>
          {tab === 'info' && <CourseInfoSection locale={locale} course={course} categories={localizedCategories} busy={busy} setBusy={setBusy} onReload={load} onNotice={showNotice} onNext={() => setTab('content')} />}
          {tab === 'content' && <CourseContentSection locale={locale} course={course} activeLessonId={activeLessonId} setActiveLessonId={setActiveLessonId} contentLanguage={contentLanguage} busy={busy} setBusy={setBusy} onReload={load} onNotice={showNotice} />}
          {tab === 'trial' && trial && <CourseTrialSection canManage={canManageCommerce} locale={locale} courseId={course.id} trial={trial} course={course} busy={busy} setBusy={setBusy} onReload={load} onNotice={showNotice} contentLanguage={contentLanguage} />}
          {tab === 'versions' && <CourseVersionsSection locale={locale} course={course} versions={versions} history={history} historyPage={historyPage} setHistoryPage={setHistoryPage} busy={busy} setBusy={setBusy} onReload={load} onNotice={showNotice} />}
        </div>
      </div>
      {toast && (
        <div
          className={`course-ui-toast ${toast.kind === 'error' ? 'isError' : 'isSuccess'}`}
          role={toast.kind === 'error' ? 'alert' : 'status'}
          data-testid="course-toast"
        >
          <span>{toast.text}</span>
          <button type="button" aria-label={L(locale, '关闭', 'Dismiss')} onClick={() => setToast(null)}>×</button>
        </div>
      )}
    </section>
    </FailureProvider>
  );
}
