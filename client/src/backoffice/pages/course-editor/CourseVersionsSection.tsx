import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CourseDetail, CourseVersion, HistoryPage, IncompleteLesson, PortalPreviewLink } from '../../contracts/course';
import { boRequest } from '../../lib/api';
import { cachedNumberingMode, cachedPreviewEntry } from '../../lib/capabilities';
import { latestVersion, nextVersionLabel, versionName } from './versionNumbering';
import { fadeIn, runPublishMotion } from './versionMotion';
import { useCoursePermissions } from '../../lib/coursePermissions';
import { uploadCoursePackage, waitForImportJob, type ImportJobStatus } from '../../lib/packageUpload';
import { failureCode } from '../../lib/courseErrors';
import { useReportFailure } from './feedback';
import { t } from '../../lib/i18n/messages';
import { serverText } from '../../lib/i18n/serverText';
import { useResizableColumns } from '../../components/resizableColumns';
import { Field, Modal } from './shared';
import { L, buttonStyle, dangerBtn, fmtDate, inputStyle, liveStatusLabel, primaryBtn } from './shared-utils';
import { historyActionLabel, historyDetailText } from './versionHistory';



/** 列表里只写日期（时分放在 tooltip 之外太挤；板上仍写完整时间）。 */
function fmtDay(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

const asLoc = (locale: string): 'zh-CN' | 'en-GB' => (locale.startsWith('zh') ? 'zh-CN' : 'en-GB');

/** PRD §15.5：来源显示为 `Sandbox X.Y` 或 `Restored from Version N`。 */
function versionSourceLabel(version: CourseVersion, locale: string): string {
  const zh = locale.startsWith('zh');
  const environment = version.sourceEnvironment?.trim();
  const label = version.sourceVersionLabel?.trim();
  if (environment && label) return `${environment} ${label}`;
  if (environment) return environment;
  if (label) return zh ? `从版本 ${label} 恢复` : `Restored from Version ${label}`;
  return '—';
}

export function CourseVersionsSection({
  locale,
  course,
  versions: versionsProp,
  history,
  historyPage,
  setHistoryPage,
  busy,
  setBusy,
  onReload,
  onNotice,
}: {
  locale: string;
  course: CourseDetail;
  versions: CourseVersion[];
  history: HistoryPage | null;
  historyPage: number;
  setHistoryPage: (value: number) => void;
  busy: boolean;
  setBusy: (value: boolean) => void;
  onReload: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const navigate = useNavigate();
  // 发布 / 删草稿 / 导入导出 / 上下线 / 恢复版本按账号级课程动作逐项判定（旧服务端回退角色矩阵）。
  const permissions = useCoursePermissions();
  const canPublish = permissions.publish;
  const canImport = permissions.import;
  const canExport = permissions.export;
  // 预览入口（PREVIEW_ENTRY）：learner = 上游学员视角预览；portal = 生产投影渲染草稿（带版本）。
  const previewEntry = cachedPreviewEntry();
  const [previewOpeningId, setPreviewOpeningId] = useState<string | null>(null);
  const reportFailure = useReportFailure();
  const [publishOpen, setPublishOpen] = useState(false);
  const [blocked, setBlocked] = useState<{ codes: string[]; lessons: IncompleteLesson[] } | null>(null);
  const [notifyLearners, setNotifyLearners] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [restoreVersion, setRestoreVersion] = useState<CourseVersion | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [statusTarget, setStatusTarget] = useState<'ONLINE' | 'HIDDEN' | 'OFFLINE'>('ONLINE');
  const [statusReason, setStatusReason] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importProgress, setImportProgress] = useState<number | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);

  // 导出完成后本地把线上版本标成已导出（服务端 worker 已写 exportedAt；不再多发一次请求）；props 一变就作废。
  const [exportedLocally, setExportedLocally] = useState<{ source: CourseVersion[]; id: string; at: string } | null>(null);
  const versions = useMemo(
    () =>
      exportedLocally && exportedLocally.source === versionsProp
        ? versionsProp.map((version) => (version.id === exportedLocally.id && !version.exportedAt ? { ...version, exportedAt: exportedLocally.at } : version))
        : versionsProp,
    [versionsProp, exportedLocally],
  );
  const mode = cachedNumberingMode();
  const liveVersion = versions.find((version) => version.isLive);
  const sortedVersions = useMemo(() => [...versions].sort((a, b) => b.versionNo - a.versionNo), [versions]);
  const newest = latestVersion(versions);
  const nextLabel = mode ? nextVersionLabel(mode, newest) : null;
  const nextName = nextLabel ? versionName(locale, nextLabel) : null;
  const [openFolds, setOpenFolds] = useState<Set<number>>(new Set());
  const hintId = useId();
  type Pending = { kind: 'publish'; previousLiveId: string | null; name: string } | { kind: 'draft' } | { kind: 'restore'; id: string };
  const motionPending = useRef<Pending | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [tethers, setTethers] = useState<{ draft: string | null; live: string | null }>({ draft: null, live: null });
  const tt = (key: string, vars?: Record<string, string>) => t(asLoc(locale), `course.ui.versions.${key}`, vars);
  /** 把句子里的 {v} 渲染成加粗的版本名。 */
  const withStrong = (key: string, v: string, vars: Record<string, string> = {}) => {
    const parts = tt(key, { ...vars, v: '\u0001' }).split('\u0001');
    return <>{parts[0]}<strong>{v}</strong>{parts[1] ?? ''}</>;
  };
  const versionsTable = useResizableColumns({ storageKey: 'course-editor-versions-v3', defaultWidths: [28, 140, 140, 150, 132] });
  const historyTable = useResizableColumns({ storageKey: 'course-editor-history', defaultWidths: [160, 140, 140, 578] });


  async function publish() {
    // 能不能发布由服务器说了算：点了就发请求，被拒时（PUBLISH_BLOCKED）按服务器给的原因列出来。
    setBusy(true);
    setBlocked(null);
    const result = await boRequest(`/api/backoffice/courses/${course.id}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ notifyLearners }),
    });
    setBusy(false);
    if (result.success) {
      setPublishOpen(false);
      // 动效只在重载后“线上版本变了”时播放（重载失败 / 被服务端拒绝都不播）
      motionPending.current = { kind: 'publish', previousLiveId: liveVersion?.id ?? null, name: nextName ?? '' };
      onNotice(L(locale, '发布成功。', 'Published successfully.'));
      await onReload();
    } else if (failureCode(result) === 'PUBLISH_BLOCKED') {
      const details = result.details ?? {};
      const codes = Array.isArray(details.blockerCodes) ? (details.blockerCodes as string[]) : (course.completeness.publishBlockerCodes ?? []);
      const lessons = Array.isArray(details.incompleteLessons) ? (details.incompleteLessons as IncompleteLesson[]) : (course.completeness.incompleteLessons ?? []);
      setBlocked({ codes, lessons });
    } else {
      setPublishOpen(false);
      reportFailure(L(locale, '发布失败', 'Publish failed'), result);
    }
  }

  async function deleteDraft() {
    setBusy(true);
    const result = await boRequest(`/api/backoffice/courses/${course.id}/delete-draft`, { method: 'POST' });
    setBusy(false);
    if (result.success) {
      setDeleteOpen(false);
      motionPending.current = { kind: 'draft' };
      onNotice(L(locale, '草稿已删除。', 'Draft deleted.'));
      await onReload();
    } else {
      setDeleteOpen(false);
      reportFailure(L(locale, '删除草稿失败', 'Delete draft failed'), result);
    }
  }

  async function restore() {
    if (!restoreVersion) return;
    setBusy(true);
    const result = await boRequest(`/api/backoffice/courses/${course.id}/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ versionId: restoreVersion.id }),
    });
    setBusy(false);
    if (result.success) {
      setRestoreVersion(null);
      motionPending.current = { kind: 'restore', id: restoreVersion.id };
      onNotice(L(locale, '版本已恢复到草稿。', 'Version restored to the draft.'));
      await onReload();
    } else {
      setRestoreVersion(null);
      reportFailure(L(locale, '恢复失败', 'Restore failed'), result);
    }
  }

  async function changeStatus() {
    if (!statusReason.trim()) {
      onNotice(L(locale, '请填写原因。', 'Reason is required.'));
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
      setStatusOpen(false);
      setStatusReason('');
      onNotice(L(locale, '状态已更新。', 'Status updated.'));
      await onReload();
    } else {
      setStatusOpen(false);
      reportFailure(L(locale, '状态更新失败', 'Status update failed'), result);
    }
  }

  async function importPackage() {
    if (!importFile) return;
    setImportBusy(true);
    setImportProgress(null);
    // 大包自动走分块会话；小包仍是单次 POST，两条路径都落到同一个导入作业。
    const uploaded = await uploadCoursePackage<ImportJobStatus>(importFile, undefined, course.id);
    if (!uploaded.success) {
      setImportBusy(false);
      setImportOpen(false);
      reportFailure(L(locale, '导入失败', 'Import failed'), {
        success: false,
        data: null,
        error: 'INTERNAL_ERROR',
        code: uploaded.error,
        message: uploaded.errorMessage,
      });
      return;
    }
    // 分块通道（> 200 MB）complete 只返回 PACKAGE_QUEUED/VALIDATING，后台才拼包校验；
    // 直接 confirm 会被服务端按 PACKAGE_CONFLICT(409) 拒绝，必须先轮询到 AWAITING_CONFIRM。
    const outcome = await waitForImportJob(uploaded.data, (job) => {
      setImportProgress(job.status === 'VALIDATING' ? job.progress ?? 0 : null);
    });
    setImportProgress(null);
    const failImport = (message: string) => {
      setImportBusy(false);
      setImportOpen(false);
      reportFailure(L(locale, '导入失败', 'Import failed'), {
        success: false,
        data: null,
        error: 'INTERNAL_ERROR',
        message,
      });
    };
    if (!outcome.ok) {
      failImport(
        outcome.reason === 'timeout'
          ? L(locale, '课程包校验超时，请稍后重试。', 'Package validation timed out. Try again later.')
          : outcome.message ?? L(locale, '无法读取课程包校验进度，请稍后重试。', 'Could not read the package validation status. Try again later.'),
      );
      return;
    }
    if (outcome.job.status === 'FAILED') {
      failImport(
        outcome.job.error
          ? serverText(outcome.job.error, asLoc(locale))
          : L(locale, '课程包校验失败，请修正后重新上传。', 'Package validation failed. Fix it and upload again.'),
      );
      return;
    }
    if (outcome.job.status !== 'AWAITING_CONFIRM') {
      failImport(L(locale, '导入已取消，请重新上传课程包。', 'The import was cancelled. Upload the package again.'));
      return;
    }
    const confirm = await boRequest(`/api/backoffice/courses/import/${uploaded.data.jobId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ onConflict: 'ABORT', overwriteDraft: true }),
    });
    setImportBusy(false);
    if (confirm.success) {
      setImportOpen(false);
      setImportFile(null);
      motionPending.current = { kind: 'draft' };
      onNotice(L(locale, '课程包已导入草稿。', 'Package imported into the draft.'));
      await onReload();
    } else {
      setImportOpen(false);
      reportFailure(L(locale, '导入失败', 'Import failed'), confirm);
    }
  }

  async function exportPackage() {
    // PRD §16.2：只导出当前线上版本；导出前由服务端再次校验 3 步完整。
    setExportBusy(true);
    const start = await boRequest<{ jobId: string }>(`/api/backoffice/courses/${course.id}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 'live' }),
    });
    if (!start.success) {
      setExportBusy(false);
      setExportOpen(false);
      reportFailure(L(locale, '导出失败', 'Export failed'), start);
      return;
    }
    for (let attempt = 0; attempt < 120; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const status = await boRequest<{ status: string; progress: number; error?: string }>(`/api/backoffice/courses/export/${start.data.jobId}`);
      if (!status.success) continue;
      if (status.data.status === 'READY') {
        if (liveVersion) setExportedLocally({ source: versionsProp, id: liveVersion.id, at: new Date().toISOString() });
        window.location.href = `/api/backoffice/courses/export/${start.data.jobId}/download`;
        setExportBusy(false);
        setExportOpen(false);
        onNotice(L(locale, '课程包正在下载。', 'Course package is downloading.'));
        return;
      }
      if (status.data.status === 'FAILED') {
        setExportBusy(false);
        setExportOpen(false);
        reportFailure(L(locale, '导出失败', 'Export failed'), { success: false, data: null, error: 'INTERNAL_ERROR', message: status.data.error ? serverText(status.data.error, locale.startsWith('zh') ? 'zh-CN' : 'en-GB') : undefined, status: 500 });
        return;
      }
    }
    setExportBusy(false);
    setExportOpen(false);
    onNotice(L(locale, '导出超时。', 'Export timed out.'));
  }

  // 能不能发布服务器已经在课程详情里说了：打开对话框就列出原因（不自己判断）；被拒时（竞争）用 PUBLISH_BLOCKED 的内容。
  const serverBlocked = course.completeness.canPublish
    ? null
    : { codes: course.completeness.publishBlockerCodes ?? [], lessons: course.completeness.incompleteLessons ?? [] };
  const shownBlocked = blocked ?? serverBlocked;
  const gaps = [
    !course.completeness.steps.courseInformation.complete ? L(locale, '课程信息', 'Course Information') : null,
    ...(course.completeness.incompleteLessons ?? []).map(
      (lesson) => `${L(locale, '课程内容', 'Course Content')}: ${t(asLoc(locale), 'course.ui.blockedLesson', {
        position: String(lesson.position),
        code: lesson.code,
        parts: lesson.parts.map((part) => t(asLoc(locale), `course.ui.part${part}`)).join(locale.startsWith('zh') ? '、' : ', '),
      })}`,
    ),
    !course.completeness.steps.trial.complete ? L(locale, '试看设置', 'Trial') : null,
  ].filter(Boolean) as string[];

  async function openVersionPreview(version: CourseVersion) {
    if (previewEntry !== 'portal') {
      navigate(`/${locale}/course/${course.id}/preview?versionId=${version.id}`);
      return;
    }
    // portal 模式：带 versionId 生成短时效预览链接并在新标签打开（与编辑器顶部预览同一套逻辑）。
    setPreviewOpeningId(version.id);
    const popup = window.open('about:blank', '_blank');
    const query = new URLSearchParams({ locale, versionId: version.id });
    const result = await boRequest<PortalPreviewLink>(
      `/api/backoffice/courses/${course.id}/portal-preview?${query.toString()}`,
    );
    setPreviewOpeningId(null);
    if (!result.success) {
      popup?.close();
      onNotice(
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

  /** 因“无草稿 / 尚未发布”等状态而不可点的按钮：保持可聚焦，悬停与聚焦时说明原因（忙碌时仍是原生 disabled）。 */
  const actionButton = (
    key: string,
    label: string,
    options: { style: React.CSSProperties; reason: string | null; onClick: () => void; testId?: string; disabled?: boolean },
  ) => {
    const id = `${hintId}-${key}`;
    return (
      <span className="course-ui-hintHost">
        <button
          type="button"
          style={options.style}
          data-testid={options.testId}
          className={options.reason ? 'isDisabled' : undefined}
          aria-disabled={options.reason ? 'true' : undefined}
          aria-describedby={options.reason ? id : undefined}
          disabled={options.disabled}
          onClick={() => {
            if (options.reason) return;
            options.onClick();
          }}
        >
          {label}
        </button>
        {options.reason && <span id={id} role="tooltip" className="course-ui-hint">{options.reason}</span>}
      </span>
    );
  };

  const hasDraft = course.hasDraft;
  const live = liveVersion;
  const lampLit = course.liveStatus === 'ONLINE';
  const statusDotClass = course.liveStatus === 'ONLINE' ? 'isOnline' : course.liveStatus === 'HIDDEN' ? 'isHidden' : 'isOffline';
  const incomplete = course.completeness.incompleteLessons ?? [];
  const stepItems = [
    { id: 'info', label: L(locale, '课程信息', 'Course Information'), complete: course.completeness.steps.courseInformation.complete },
    { id: 'content', label: L(locale, '课程内容', 'Course Content'), complete: course.completeness.steps.content.complete },
    { id: 'trial', label: L(locale, '试看设置', 'Trial'), complete: course.completeness.steps.trial.complete },
  ];
  const draftOrigin = (() => {
    if (!hasDraft) return null;
    if (course.draftSourceType === 'IMPORT') {
      const from = [course.draftSourceEnvironment?.trim(), course.draftSourceVersionLabel?.trim()].filter(Boolean).join(' ');
      return from ? tt('draftFrom', { source: from }) : null;
    }
    if (course.draftSourceType === 'RESTORE' && course.draftSourceVersionLabel) {
      return tt('draftCopyOf', { v: versionName(locale, course.draftSourceVersionLabel) });
    }
    return null;
  })();

  /** 列表行：下一次发布（虚线）→ 各版本；沙盒里已导出系列的较早版本折叠成一行。 */
  type Row = { kind: 'version'; version: CourseVersion } | { kind: 'fold'; series: number; labels: string[] };
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const newestSeries = newest?.versionSeries;
    const exportedSeries = new Set(sortedVersions.filter((v) => v.exportedAt).map((v) => v.versionSeries));
    const folded = (v: CourseVersion) => mode === 'sandbox' && v.versionSeries !== newestSeries && exportedSeries.has(v.versionSeries) && !v.exportedAt && !v.isLive;
    const seenFold = new Set<number>();
    for (const version of sortedVersions) {
      if (!folded(version)) { out.push({ kind: 'version', version }); continue; }
      if (!seenFold.has(version.versionSeries)) {
        seenFold.add(version.versionSeries);
        out.push({ kind: 'fold', series: version.versionSeries, labels: sortedVersions.filter((x) => x.versionSeries === version.versionSeries && folded(x)).map((x) => x.versionLabel) });
      }
      if (openFolds.has(version.versionSeries)) out.push({ kind: 'version', version });
    }
    return out;
  }, [sortedVersions, openFolds, mode, newest]);
  const anyExported = versions.some((version) => version.exportedAt);

  // 拴线：虚线从草稿板到“下次发布”节点，实线从线上板到灯；只在两栏布局画。
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () => {
      const g = grid.getBoundingClientRect();
      const list = grid.querySelector('.course-ui-vList')?.getBoundingClientRect();
      // The draft line turns at one third of the gutter and the live line at two thirds, so the dashed and the solid never share a stretch.
      const build = (plateSel: string, nodeSel: string, at: number) => {
        const plate = grid.querySelector(plateSel)?.getBoundingClientRect();
        const node = grid.querySelector(nodeSel)?.getBoundingClientRect();
        if (!plate || !node || !list || plate.right >= list.left - 4) return null;
        const sx = plate.right - g.left;
        const sy = plate.top + plate.height / 2 - g.top;
        const ex = node.left + node.width / 2 - g.left;
        const ey = node.top + node.height / 2 - g.top;
        const gx = plate.right + (list.left - plate.right) * at - g.left;
        if (Math.abs(ey - sy) < 14) return `M${sx} ${sy}H${ex}`;
        const d = ey > sy ? 1 : -1;
        return `M${sx} ${sy}H${gx - 6}Q${gx} ${sy} ${gx} ${sy + 6 * d}V${ey - 6 * d}Q${gx} ${ey} ${gx + 6} ${ey}H${ex}`;
      };
      const next = { draft: build('.course-ui-plate.isDraft', '.course-ui-vTable .course-ui-node.isGhost', 1 / 3), live: build('.course-ui-plate.isLive', '.course-ui-vTable .course-ui-node.isLamp', 2 / 3) };
      setTethers((previous) => (previous.draft === next.draft && previous.live === next.live ? previous : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [versions, hasDraft, openFolds, locale, rows.length]);

  // 动效：每个序列都从重载后的最终 DOM 反推；没有对应的待播事件就什么都不做。
  useLayoutEffect(() => {
    const grid = gridRef.current;
    const pending = motionPending.current;
    if (!grid || !pending) return;
    const draftPlate = grid.querySelector('.course-ui-plate.isDraft');
    if (pending.kind === 'publish') {
      if (!liveVersion || liveVersion.id === pending.previousLiveId) return;
      motionPending.current = null;
      void runPublishMotion(grid, pending.name || versionName(locale, liveVersion.versionLabel));
    } else if (pending.kind === 'restore') {
      motionPending.current = null;
      fadeIn(...Array.from(draftPlate?.children ?? []).slice(1));
      const row = grid.querySelector(`[data-testid="version-row-${pending.id}"]`);
      row?.classList.add('course-ui-flash');
      window.setTimeout(() => row?.classList.remove('course-ui-flash'), 600);
    } else {
      motionPending.current = null;
      fadeIn(...Array.from(draftPlate?.children ?? []).slice(1), grid.querySelector('[data-testid="version-next"]'));
    }
  }, [versionsProp, hasDraft]);

  // 导出完成：线上行的节点实心化、Exported 日期从左向右显出
  useLayoutEffect(() => {
    if (!exportedLocally || !liveVersion) return;
    const row = gridRef.current?.querySelector(`[data-testid="version-row-${liveVersion.id}"]`);
    row?.classList.add('course-ui-sealed');
    const timer = window.setTimeout(() => row?.classList.remove('course-ui-sealed'), 400);
    return () => window.clearTimeout(timer);
  }, [exportedLocally]);

  const versionCells = (version: CourseVersion) => {
    const origin = versionSourceLabel(version, locale);
    const exported = version.exportedAt ? tt('exportedOn', { date: fmtDay(version.exportedAt, locale) }) : null;
    const hasOrigin = origin !== '—';
    const full = [hasOrigin ? origin : null, exported].filter(Boolean).join(' · ');
    return (
      <td title={full || undefined}>
        {hasOrigin && <span>{origin}</span>}
        {hasOrigin && exported && ' · '}
        {exported && <span data-testid={`version-exported-${version.id}`}>{exported}</span>}
        {!hasOrigin && !exported && <span data-testid={`version-exported-${version.id}`}>—</span>}
      </td>
    );
  };

  return (
    <div className="course-ui-versions" data-testid="versions-section">
      <div className="course-ui-vScroll" data-testid="versions-scroll">
        <div className="course-ui-vGrid" ref={gridRef}>
          <svg className="course-ui-tethers" aria-hidden="true">
            {tethers.draft && <path className="isDraft" d={tethers.draft} />}
            {tethers.live && <path className="isLive" d={tethers.live} />}
          </svg>

          <section className="course-ui-vCurrent" id="versions-block-current" data-testid="versions-current">
            <header className="course-ui-bHead">
              <h2 className="course-ui-blockTitle" tabIndex={-1}>{tt('currentTitle')}</h2>
              <span className="course-ui-bNote">{tt('currentNote')}</span>
            </header>

            <article className="course-ui-plate isDraft" data-testid="versions-current-draft">
              <div className="course-ui-plateTop"><span className="course-ui-capLabel">{L(locale, '草稿', 'DRAFT')}</span></div>
              <div className="course-ui-plateState">
                <strong>{hasDraft ? (course.draftSourceType === 'IMPORT' ? L(locale, '从课程包导入', 'Imported') : L(locale, '未发布', 'Not published')) : L(locale, '无草稿', 'No draft')}</strong>
              </div>
              {hasDraft && (
                <div className="course-ui-steps" data-testid="versions-draft-steps">
                  {stepItems.map((step) => (
                    <span key={step.id} className="course-ui-step" data-complete={step.complete ? 'true' : 'false'}>
                      {step.complete ? <span className="course-ui-stepOk" aria-hidden="true">✓</span> : <span className="course-ui-stepRing" aria-hidden="true" />}
                      {step.label}
                      {step.id === 'content' && !step.complete && incomplete.length > 0 && (
                        <span className="course-ui-stepWhere">
                          : {tt('stepLesson', { n: String(incomplete[0].position) })}
                          {incomplete.length > 1 && ` ${tt('stepMore', { n: String(incomplete.length - 1) })}`}
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              )}
              {hasDraft && nextName && (
                <div className="course-ui-plateLine" data-testid="versions-publishes-as">
                  {withStrong('publishesAs', nextName)}
                  {draftOrigin && ` · ${draftOrigin}`}
                </div>
              )}
              {!hasDraft && (
                <div className="course-ui-plateLine">
                  {tt('nothingWaiting')}
                  {nextName && <> {withStrong('nextWillBe', nextName)}</>}
                </div>
              )}
              {(canPublish || canImport) && (
                <div className="course-ui-plateActions">
                  {canPublish && actionButton('publish', L(locale, '发布', 'Publish'), {
                    style: primaryBtn, testId: 'publish-open', disabled: busy, reason: hasDraft ? null : tt('hintNoDraft'),
                    onClick: () => { setBlocked(null); setPublishOpen(true); },
                  })}
                  {canPublish && actionButton('delete', L(locale, '删除草稿', 'Delete draft'), {
                    style: dangerBtn, disabled: busy, reason: !hasDraft ? tt('hintNothingToDelete') : !live ? tt('hintPublishFirst') : null,
                    onClick: () => setDeleteOpen(true),
                  })}
                  {canImport && (
                    <button type="button" style={{ ...buttonStyle, marginLeft: 'auto' }} disabled={busy} onClick={() => setImportOpen(true)}>
                      {L(locale, '导入课程包', 'Import package')}
                    </button>
                  )}
                </div>
              )}
            </article>

            <article className="course-ui-plate isLive" data-testid="versions-current-live">
              <div className="course-ui-plateTop">
                <span className="course-ui-capLabel">{L(locale, '线上', 'LIVE')}</span>
                {live && <span>{live.publishedBy ? tt('publishedBy', { date: fmtDate(live.wentLiveAt ?? live.createdAt, locale), name: live.publishedBy }) : tt('publishedOn', { date: fmtDate(live.wentLiveAt ?? live.createdAt, locale) })}</span>}
              </div>
              <div className="course-ui-plateState" data-testid="versions-live-state">
                {live ? (
                  <>
                    <span className={`course-ui-statusDot ${statusDotClass}`} aria-hidden="true" />
                    <strong>{liveStatusLabel(locale, course.liveStatus)}</strong>
                    <span>{versionName(locale, live.versionLabel)}</span>
                  </>
                ) : (
                  <strong>{L(locale, '从未发布', 'Not published')}</strong>
                )}
              </div>
              {live && (
                <div className="course-ui-plateSub">
                  {live.sourceEnvironment && <span>{tt('sourceLine', { source: versionSourceLabel(live, locale) })}</span>}
                  {live.sourceEnvironment && (live.exportedAt || mode === 'sandbox') && ' · '}
                  {live.exportedAt ? <span>{tt('exportedOn', { date: fmtDate(live.exportedAt, locale) })}</span> : mode === 'sandbox' ? <span>{tt('notExported')}</span> : null}
                </div>
              )}
              {live && !lampLit && (
                <div className="course-ui-dNote" data-testid="versions-not-visible" role="note">{tt('notVisibleNote')}</div>
              )}
              {(canPublish || canExport) && (
                <div className="course-ui-plateActions">
                  {canPublish && actionButton('status', L(locale, '更改状态', 'Change status'), {
                    style: buttonStyle, disabled: busy, reason: live ? null : tt('hintPublishFirst'),
                    onClick: () => { setStatusTarget(course.liveStatus === 'ONLINE' ? 'HIDDEN' : 'ONLINE'); setStatusOpen(true); },
                  })}
                  {canExport && actionButton('export', exportBusy ? L(locale, '导出中…', 'Exporting…') : L(locale, '导出课程包', 'Export package'), {
                    style: buttonStyle, testId: 'export-open', disabled: busy || exportBusy, reason: live ? null : tt('hintPublishFirst'),
                    onClick: () => setExportOpen(true),
                  })}
                </div>
              )}
            </article>
          </section>

          <div className="course-ui-vGutter" aria-hidden="true" />

          <section className="course-ui-vList" id="versions-block-versions" data-testid="versions-list">
            <header className="course-ui-bHead">
              <h2 className="course-ui-blockTitle" tabIndex={-1}>{tt('versionsTitle')}</h2>
              <span className="course-ui-bNote">{tt('listNote')}</span>
              <ul className="course-ui-legend">
                <li><span className="course-ui-node isGhost" aria-hidden="true" />{tt('legendDraft')}</li>
                <li><span className="course-ui-node" aria-hidden="true" />{tt('legendPublished')}</li>
                <li><span className={`course-ui-node isLamp${live && !lampLit ? ' isUnlit' : ''}`} aria-hidden="true" />{live && !lampLit ? tt('legendLiveOff') : tt('legendLive')}</li>
                {anyExported && <li><span className="course-ui-node isSealed" aria-hidden="true" />{tt('legendExported')}</li>}
              </ul>
            </header>
            <div className="course-ui-vTableWrap" data-testid="versions-list-scroll">
              <table className="table course-ui-vTable" style={versionsTable.tableStyle}>
                {versionsTable.colGroup}
                <thead>
                  <tr>
                    <th aria-label={tt('legendPublished')} />
                    <th>{L(locale, '版本', 'Version')}{versionsTable.resizeHandle(1)}</th>
                    <th>{L(locale, '发布时间', 'Published')}{versionsTable.resizeHandle(2)}</th>
                    <th>{L(locale, '来源', 'Source')}{versionsTable.resizeHandle(3)}</th>
                    <th>{L(locale, '操作', 'Actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {hasDraft && nextName && (
                    <tr className="isGhost" data-testid="version-next">
                      <td className="course-ui-railCell"><span className="course-ui-node isGhost" aria-hidden="true" /></td>
                      <td>{nextName}</td>
                      <td>{tt('nextPublish')}</td>
                      <td>{newest?.exportedAt && mode === 'sandbox' ? tt('newSeries') : '—'}</td>
                      <td />
                    </tr>
                  )}
                  {rows.map((row) => row.kind === 'fold' ? (
                    <tr key={`fold-${row.series}`} className="isFold" data-testid={`version-fold-${row.series}`}>
                      <td className="course-ui-railCell"><span className="course-ui-node isFoldNode" aria-hidden="true" /></td>
                      <td colSpan={3}>{tt('foldEarlier', { labels: row.labels.join(' · ') })}</td>
                      <td>
                        <button
                          type="button"
                          className="course-ui-linkBtn"
                          aria-expanded={openFolds.has(row.series)}
                          onClick={() => setOpenFolds((previous) => {
                            const next = new Set(previous);
                            if (next.has(row.series)) next.delete(row.series); else next.add(row.series);
                            return next;
                          })}
                        >
                          {openFolds.has(row.series) ? tt('foldHide') : tt('foldShow')}
                        </button>
                      </td>
                    </tr>
                  ) : (
                    <tr key={row.version.id} data-testid={`version-row-${row.version.id}`}>
                      <td className="course-ui-railCell">
                        <span className={row.version.isLive ? `course-ui-node isLamp${lampLit ? '' : ' isUnlit'}` : row.version.exportedAt ? 'course-ui-node isSealed' : 'course-ui-node'} aria-hidden="true" />
                      </td>
                      <td>
                        <div className="course-ui-vName">
                          <span className="course-ui-vNameText">{versionName(locale, row.version.versionLabel)}</span>
                          {row.version.isLive && <span className="course-ui-liveTag">{tt('legendLive')}</span>}
                        </div>
                      </td>
                      <td>
                        {fmtDay(row.version.wentLiveAt ?? row.version.createdAt, locale)}
                        {row.version.publishedBy && <> · <span className="course-ui-by">{row.version.publishedBy}</span></>}
                      </td>
                      {versionCells(row.version)}
                      <td>
                        <div className="course-ui-rowActions">
                          <button type="button" className="course-ui-linkBtn" disabled={previewOpeningId === row.version.id} onClick={() => void openVersionPreview(row.version)}>
                            {previewOpeningId === row.version.id ? L(locale, '打开中…', 'Opening…') : L(locale, '查看', 'View')}
                          </button>
                          {canPublish && !row.version.isLive
                            ? <button type="button" className="course-ui-linkBtn" disabled={busy} onClick={() => setRestoreVersion(row.version)}>{L(locale, '恢复', 'Restore')}</button>
                            : <span className="course-ui-linkBtn" aria-hidden="true" />}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && !hasDraft && <tr><td colSpan={5} style={{ textAlign: 'center', padding: 18, opacity: 0.7 }}>{L(locale, '暂无版本。', 'No versions yet.')}</td></tr>}
                </tbody>
              </table>
            </div>
            {mode && (
              <p className="course-ui-numbering" data-testid="versions-numbering">
                <strong>{tt('numberingAuto')}</strong>{' '}
                {mode === 'production'
                  ? tt('numberingProduction')
                  : <>
                      {withStrong('numberingNext', nextName ?? '')}
                      {live && newest && !newest.exportedAt && <> {withStrong('numberingAfterExport', versionName(locale, nextVersionLabel('sandbox', { ...newest, exportedAt: 'x' })))}</>}
                    </>}
              </p>
            )}
          </section>
        </div>

        <section className="course-ui-vHistory" id="versions-block-history" data-testid="versions-history">
          <header className="course-ui-bHead">
            <h2 className="course-ui-blockTitle" tabIndex={-1}>{tt('historyTitle')}</h2>
            <span className="course-ui-bNote">{L(locale, '只读 —— 每次发布、导入、导出、恢复与状态变更。', 'Read-only — every publish, import, export, restore and status change.')}</span>
          </header>
          <div className="course-ui-vTableWrap" data-testid="versions-history-scroll">
            <table className="table course-ui-vTable" style={historyTable.tableStyle}>
              {historyTable.colGroup}
              <thead>
                <tr>
                  <th>{L(locale, '时间', 'Time')}{historyTable.resizeHandle(0)}</th>
                  <th>{L(locale, '操作人', 'Operator')}{historyTable.resizeHandle(1)}</th>
                  <th>{L(locale, '操作', 'Action')}{historyTable.resizeHandle(2)}</th>
                  <th style={{ textAlign: 'left' }}>{L(locale, '详情', 'Detail')}{historyTable.resizeHandle(3)}</th>
                </tr>
              </thead>
              <tbody>
                {(history?.items ?? []).map((item) => (
                  <tr key={item.id}>
                    <td>{fmtDate(item.time, locale)}</td>
                    <td>{item.operator}</td>
                    <td>{historyActionLabel(item.action, locale)}</td>
                    <td className="cellWrap" style={{ color: 'var(--cl-text-2)' }}>{historyDetailText(item, locale)}</td>
                  </tr>
                ))}
                {(history?.items.length ?? 0) === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', padding: 18, opacity: 0.7 }}>{L(locale, '暂无记录。', 'No history yet.')}</td></tr>}
              </tbody>
            </table>
          </div>
          {history && history.pages > 1 && (
            <div className="course-ui-historyPager" data-testid="versions-history-pagination">
              <button type="button" style={buttonStyle} disabled={historyPage <= 1} onClick={() => setHistoryPage(Math.max(1, historyPage - 1))}>←</button>
              <span className="course-ui-pagerLabel">{history.page} / {history.pages}</span>
              <button type="button" style={buttonStyle} disabled={historyPage >= history.pages} onClick={() => setHistoryPage(Math.min(history.pages, historyPage + 1))}>→</button>
            </div>
          )}
        </section>
      </div>

      {publishOpen && (
        <Modal
          title={nextName ? t(asLoc(locale), 'course.ui.confirm.publishTitle', { v: nextName }) : t(asLoc(locale), 'course.ui.confirm.publishTitleUnknown')}
          onClose={() => setPublishOpen(false)}
          width={476}
        >
          {nextName && (
            <div className="course-ui-dFlow" aria-hidden="true">
              <span className="course-ui-dChip isDraft">{t(asLoc(locale), 'course.ui.confirm.flowDraft')}</span>
              <span>⇢</span>
              <span className="course-ui-dChip isVersion">{nextName}</span>
            </div>
          )}
          <p style={{ margin: 0 }}>
            {nextName
              ? liveVersion
                ? t(asLoc(locale), 'course.ui.confirm.publishBody', { v: nextName, status: liveStatusLabel(locale, course.liveStatus) })
                : t(asLoc(locale), 'course.ui.confirm.publishBodyFirst', { v: nextName })
              : t(asLoc(locale), 'course.ui.confirm.publishBodyUnknown')}
          </p>
          <dl className="course-ui-dl">
            {liveVersion && <><dt>{t(asLoc(locale), 'course.ui.confirm.replaces')}</dt><dd>{versionName(locale, liveVersion.versionLabel)}</dd></>}
            <dt>{t(asLoc(locale), 'course.ui.confirm.content')}</dt>
            <dd>{L(locale, `已完成 ${course.completeness.completedSteps}/3 步`, `${course.completeness.completedSteps} of 3 steps complete`)}</dd>
          </dl>
          {!shownBlocked && gaps.length > 0 && (
            <div className="course-ui-dNote">
              <strong>{L(locale, '部分字段为空', 'Some fields are empty')}</strong>
              {gaps.map((gap) => <div key={gap}>{gap}</div>)}
              <div style={{ marginTop: 4 }}>{L(locale, '仍可发布。', 'You can still publish.')}</div>
            </div>
          )}
          {shownBlocked && (
            <div data-testid="publish-blocked" className="course-ui-dNote isDanger">
              <strong>{t(asLoc(locale), 'course.ui.publishBlockedTitle')}</strong>
              {shownBlocked.codes.map((code) => {
                const key = `course.ui.blocker${code}`;
                return <div key={code} data-testid="publish-blocker">{t(asLoc(locale), key) === key ? code : t(asLoc(locale), key)}</div>;
              })}
              {shownBlocked.lessons.length > 0 && <div style={{ marginTop: 6, fontWeight: 600 }}>{t(asLoc(locale), 'course.ui.blockedLessonsTitle')}</div>}
              {shownBlocked.lessons.map((lesson) => (
                <div key={lesson.lessonId} data-testid="publish-blocked-lesson">
                  {t(asLoc(locale), 'course.ui.blockedLesson', {
                    position: String(lesson.position),
                    code: lesson.code,
                    parts: lesson.parts.map((part) => t(asLoc(locale), `course.ui.part${part}`)).join(locale.startsWith('zh') ? '、' : ', '),
                  })}
                </div>
              ))}
            </div>
          )}
          <label style={{ display: 'block', fontSize: 13 }}>
            <input type="checkbox" checked={notifyLearners} onChange={(event) => setNotifyLearners(event.target.checked)} /> {t(asLoc(locale), 'course.ui.confirm.notify')}
          </label>
          <div className="course-ui-dFoot">
            <button type="button" style={buttonStyle} onClick={() => setPublishOpen(false)}>{L(locale, '取消', 'Cancel')}</button>
            <button type="button" style={primaryBtn} disabled={busy} onClick={() => void publish()}>{L(locale, '发布', 'Publish')}</button>
          </div>
        </Modal>
      )}

      {deleteOpen && (
        <Modal title={L(locale, '删除草稿', 'Delete draft')} onClose={() => setDeleteOpen(false)} width={476}>
          <p style={{ fontSize: 13 }}>{L(locale, '草稿被删除，包括导入的课程包。网站继续使用当前线上版本。此操作不可撤销。', 'The draft is deleted, including any imported package. The website keeps the live version. This cannot be undone.')}</p>
          <div className="course-ui-dFoot">
            <button type="button" style={buttonStyle} onClick={() => setDeleteOpen(false)}>{L(locale, '取消', 'Cancel')}</button>
            <button type="button" style={dangerBtn} disabled={busy} onClick={() => void deleteDraft()}>{L(locale, '删除草稿', 'Delete draft')}</button>
          </div>
        </Modal>
      )}

      {restoreVersion && (
        <Modal title={L(locale, '恢复版本', 'Restore version')} onClose={() => setRestoreVersion(null)} width={476}>
          <p style={{ fontSize: 13 }}>{L(locale, '旧版本内容复制到草稿，替换当前草稿。发布后才会生效。', 'The old version is copied into the draft and replaces the current draft. It goes live only after publish.')}</p>
          <div style={{ fontSize: 12, color: '#5A6577', marginTop: 8 }}>
            <div>{L(locale, '恢复版本', 'Restore')}: {restoreVersion.versionLabel}</div>
            <div>{L(locale, '发布为', 'Goes live as')}: {L(locale, '新版本', 'a new version')}</div>
          </div>
          <div className="course-ui-dFoot">
            <button type="button" style={buttonStyle} onClick={() => setRestoreVersion(null)}>{L(locale, '取消', 'Cancel')}</button>
            <button type="button" style={primaryBtn} disabled={busy} onClick={() => void restore()}>{L(locale, '恢复', 'Restore')}</button>
          </div>
        </Modal>
      )}

      {statusOpen && (
        <Modal title={L(locale, '更改状态', 'Change status')} onClose={() => setStatusOpen(false)} width={476}>
          <p style={{ fontSize: 13 }}>{L(locale, '更改状态不生成版本。', 'Changing the status does not create a version.')}</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            {(['ONLINE', 'HIDDEN', 'OFFLINE'] as const).map((status) => (
              <button key={status} type="button" onClick={() => setStatusTarget(status)} style={{ ...buttonStyle, borderColor: statusTarget === status ? '#2B58C8' : '#d9e0ea', color: statusTarget === status ? '#2B58C8' : '#25314C', fontWeight: statusTarget === status ? 700 : 400 }}>
                {liveStatusLabel(locale, status)}
              </button>
            ))}
          </div>
          <Field label={L(locale, '原因 *', 'Reason *')}>
            <textarea rows={3} value={statusReason} onChange={(event) => setStatusReason(event.target.value)} style={inputStyle} />
          </Field>
          <div className="course-ui-dFoot">
            <button type="button" style={buttonStyle} onClick={() => setStatusOpen(false)}>{L(locale, '取消', 'Cancel')}</button>
            <button type="button" style={primaryBtn} disabled={busy || !statusReason.trim()} onClick={() => void changeStatus()}>{L(locale, '更改状态', 'Change status')}</button>
          </div>
        </Modal>
      )}

      {exportOpen && (
        <Modal title={t(asLoc(locale), 'course.ui.confirm.exportTitle', { v: versionName(locale, liveVersion?.versionLabel ?? '') })} onClose={() => setExportOpen(false)} width={476}>
          <p style={{ margin: 0 }}>
            {L(
              locale,
              '只导出当前线上版本，不会导出草稿。',
              'Only the current live version is exported; drafts are never exported.',
            )}
          </p>
          <dl className="course-ui-dl">
            <dt>{t(asLoc(locale), 'course.ui.confirm.rowVersion')}</dt>
            <dd>{versionName(locale, liveVersion?.versionLabel ?? '')}</dd>
            <dt>{t(asLoc(locale), 'course.ui.confirm.rowFile')}</dt>
            <dd className="course-ui-mono">{course.code}_{liveVersion?.versionLabel ?? 'live'}.zip</dd>
          </dl>
          {mode && liveVersion && (
            <p className="course-ui-dHint">
              {mode === 'production'
                ? t(asLoc(locale), 'course.ui.confirm.exportHintProduction', { v: nextName ?? '' })
                : liveVersion.exportedAt
                  ? t(asLoc(locale), 'course.ui.confirm.exportHintAlready', { date: fmtDate(liveVersion.exportedAt, locale) })
                  : t(asLoc(locale), 'course.ui.confirm.exportHintSandbox', { v: versionName(locale, nextVersionLabel('sandbox', { ...liveVersion, exportedAt: 'x' })) })}
            </p>
          )}
          <div className="course-ui-dFoot">
            <button type="button" style={buttonStyle} disabled={exportBusy} onClick={() => setExportOpen(false)}>{L(locale, '取消', 'Cancel')}</button>
            <button type="button" style={primaryBtn} data-testid="export-confirm" disabled={exportBusy} onClick={() => void exportPackage()}>{exportBusy ? L(locale, '导出中…', 'Exporting…') : L(locale, '导出', 'Export')}</button>
          </div>
        </Modal>
      )}

      {importOpen && (
        <Modal title={L(locale, '导入课程包', 'Import package')} onClose={() => setImportOpen(false)} width={476}>
          <p style={{ fontSize: 13 }}>{L(locale, '课程包替换当前课程的草稿。线上版本不变，直到发布。', 'The package replaces the draft of this course. What is live does not change until you publish.')}</p>
          <Field label={L(locale, '上传 .zip', 'Upload .zip')}>
            <input
              ref={importFileRef}
              type="file"
              accept=".zip,.lgcourse.zip"
              onChange={(event) => setImportFile(event.target.files?.[0] ?? null)}
            />
          </Field>
          {importFile && (
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }} data-testid="import-file-info">
              {importFile.name} · {(importFile.size / (1024 * 1024)).toFixed(2)} MB
              {importBusy && ` · ${L(locale, '上传中…', 'Uploading…')}`}
              <button type="button" className="button buttonGhost" style={{ marginLeft: 8 }} disabled={importBusy} onClick={() => importFileRef.current?.click()}>
                {L(locale, '更换文件', 'Replace file')}
              </button>
            </div>
          )}
          {importBusy && importProgress !== null && (
            <div data-testid="import-validation-progress" style={{ fontSize: 12, color: '#5A6577', marginTop: 6 }}>
              {L(locale, `正在校验课程包…（${importProgress}%）`, `Validating the package… (${importProgress}%)`)}
            </div>
          )}
          <div className="course-ui-dFoot">
            <button type="button" style={buttonStyle} onClick={() => setImportOpen(false)}>{L(locale, '取消', 'Cancel')}</button>
            <button type="button" style={primaryBtn} disabled={!importFile || importBusy} onClick={() => void importPackage()}>{importBusy ? L(locale, '导入中…', 'Importing…') : L(locale, '导入', 'Import')}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}