import { useMemo, useRef, useState } from 'react';

import type { CourseDetail } from '../../contracts/course';
import { boRequest } from '../../lib/api';
import { issueLine } from '../../lib/courseIssues';
import { informationBody } from '../../lib/courseRequests';
import { t } from '../../lib/i18n/messages';
import type { Locale } from '../../lib/i18n/config';
import { formatBytes, uploadFileWithProgress } from '../../lib/upload';
import { useMediaLimits } from '../../lib/mediaLimits';
import { UploadProgress } from '../../components/UploadProgress';
import { useReportFailure } from './feedback';
import { Chip, Field, IssueText, Modal } from './shared';
import { L, buttonStyle, card, dangerBtn, inputStyle, labelStyle, languageLabel, learningModeLabel, primaryBtn, useNarrowLayout } from './shared-utils';
import { PRESETS, infoDraftOf, mergeInfoDraft, parseInfoDraft, type InfoDraft, type LearnRowDraft, type ProvidesRowDraft } from './drafts/infoDraft';
import { isDirty } from './drafts/merge';
import { restoreDraft, useDraftAutosave } from './useDraftPersistence';
import { removeDraft, type DraftIdentity } from '../../lib/editorDraftStore';

type Category = { id: string; name: string };

export function CourseInfoSection({
  locale,
  course,
  categories,
  busy,
  setBusy,
  onReload,
  onNotice,
  onNext,
  canEdit,
}: {
  locale: string;
  course: CourseDetail;
  categories: Category[];
  busy: boolean;
  setBusy: (value: boolean) => void;
  onReload: () => Promise<void>;
  onNotice: (message: string) => void;
  onNext: () => void;
  canEdit: boolean;
}) {
  const reportFailure = useReportFailure();
  const [categoryId, setCategoryId] = useState(course.categoryId ?? '');
  const [titleEn, setTitleEn] = useState('');
  const [titleZh, setTitleZh] = useState('');
  const [descEn, setDescEn] = useState('');
  const [descZh, setDescZh] = useState('');
  const [overviewEn, setOverviewEn] = useState('');
  const [overviewZh, setOverviewZh] = useState('');
  const [learnRows, setLearnRows] = useState<LearnRowDraft[]>([]);
  const [providesRows, setProvidesRows] = useState<ProvidesRowDraft[]>([]);
  const [addMenu, setAddMenu] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customEn, setCustomEn] = useState('');
  const [customZh, setCustomZh] = useState('');
  const [languageOpen, setLanguageOpen] = useState(false);
  const [newLanguage, setNewLanguage] = useState('zh-CN');
  const [coverBusy, setCoverBusy] = useState(false);
  const coverInFlight = useRef(false);
  const [coverPct, setCoverPct] = useState<number | null>(null);
  const [coverError, setCoverError] = useState('');
  const mediaLimits = useMediaLimits();
  const learnFocus = useRef<HTMLInputElement | null>(null);

  const applyInfoDraft = (draft: InfoDraft) => {
    setCategoryId(draft.categoryId);
    setTitleEn(draft.titleEn);
    setTitleZh(draft.titleZh);
    setDescEn(draft.descEn);
    setDescZh(draft.descZh);
    setOverviewEn(draft.overviewEn);
    setOverviewZh(draft.overviewZh);
    setLearnRows(draft.learnRows);
    setProvidesRows(draft.providesRows);
  };

  const serverDraft = infoDraftOf(course);
  // 课程信息按课程整体编辑（身份 = courseId）；只读账号不读不写不提示。
  const draftIdentity: DraftIdentity = { courseId: course.id, step: 'info' };
  const draftStorageIdentity = canEdit ? draftIdentity : null;
  const [draftSource, setDraftSource] = useState<{ courseId: string; course: CourseDetail; snapshot: InfoDraft } | null>(null);
  const [draftRestored, setDraftRestored] = useState(false);
  const [draftServerChanged, setDraftServerChanged] = useState(false);
  if (!draftSource || draftSource.courseId !== course.id) {
    // 挂载 / 换课程：本地有未保存草稿就先三路合并恢复，否则用服务器快照。
    const restored = restoreDraft(draftStorageIdentity, serverDraft, {
      parse: parseInfoDraft,
      merge: mergeInfoDraft,
      dirty: isDirty,
    });
    setDraftSource({ courseId: course.id, course, snapshot: serverDraft });
    applyInfoDraft(restored.value);
    setDraftRestored(restored.restored);
    setDraftServerChanged(restored.restored && restored.serverChanged);
  } else if (draftSource.course !== course) {
    // 同一课程被重新载入（保存、上传封面、添加语言等）：保留用户改过的字段，其余跟随服务器（P96）。
    const currentDraft: InfoDraft = {
      categoryId,
      titleEn,
      titleZh,
      descEn,
      descZh,
      overviewEn,
      overviewZh,
      learnRows,
      providesRows,
    };
    setDraftSource({ ...draftSource, course, snapshot: serverDraft });
    applyInfoDraft(mergeInfoDraft(currentDraft, draftSource.snapshot, serverDraft));
  }

  const currentDraft: InfoDraft = {
    categoryId,
    titleEn,
    titleZh,
    descEn,
    descZh,
    overviewEn,
    overviewZh,
    learnRows,
    providesRows,
  };
  const draftBase = draftSource?.snapshot ?? serverDraft;
  useDraftAutosave(draftStorageIdentity, currentDraft, draftBase, isDirty);
  // 草稿回到与服务器一致（保存后重载合并 / 用户改回原值 / 上传封面等非保存重载把已存字段变 clean）时提示消失。
  const draftDirty = isDirty(currentDraft, draftBase);
  if (draftRestored && !draftDirty) {
    setDraftRestored(false);
    setDraftServerChanged(false);
  }

  // 完整与否、缺什么都以服务器为准（detail.completeness.issues，保存后重新载入）。
  const issues = course.completeness.issues;
  const infoComplete = course.completeness.steps.courseInformation.complete;
  const at = (field: string, language?: string | null) => issueLine(locale, issues, { step: 'COURSE_INFORMATION', language, field });
  const listIssue = (list: 'learn' | 'provides') => [...new Set((['en-GB', 'zh-CN'] as const).map((language) => at(list, language)).filter(Boolean))].join(L(locale, '；', '; ')) || null;
  const listHasIssue = (list: 'learn' | 'provides') =>
    (issues ?? []).some((issue) => issue.step === 'COURSE_INFORMATION' && (issue.field === list || issue.field.startsWith(`${list}[`)));
  const canAddProvide = providesRows.length < 6;
  const existingLanguages = useMemo(() => new Set(course.learningLanguages), [course.learningLanguages]);
  const languageOptions = ['en-GB', 'zh-CN'].filter((language) => !existingLanguages.has(language));

  function addLearnRow() {
    setLearnRows((rows) => [...rows, { en: '', zh: '' }]);
    setTimeout(() => learnFocus.current?.focus(), 0);
  }

  function moveLearn(index: number, direction: -1 | 1) {
    setLearnRows((rows) => {
      const next = [...rows];
      const target = index + direction;
      if (target < 0 || target >= next.length) return rows;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function addPreset(key: string) {
    const preset = PRESETS.find((item) => item.key === key);
    if (!preset || providesRows.some((row) => row.key === key) || !canAddProvide) return;
    setProvidesRows((rows) => [...rows, { type: 'preset', key, en: preset.en, zh: preset.zh }]);
    setAddMenu(false);
  }

  function addCustom() {
    if (!customEn.trim() || !customZh.trim() || !canAddProvide) return;
    setProvidesRows((rows) => [
      ...rows,
      { type: 'custom', en: customEn.trim(), zh: customZh.trim() },
    ]);
    setCustomOpen(false);
    setAddMenu(false);
    setCustomEn('');
    setCustomZh('');
  }

  function moveProvide(index: number, direction: -1 | 1) {
    setProvidesRows((rows) => {
      const next = [...rows];
      const target = index + direction;
      if (target < 0 || target >= next.length) return rows;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function fitCover(file: File): Promise<File | null> {
    if (!['image/jpeg', 'image/png'].includes(file.type)) return null;
    try {
      const bitmap = await createImageBitmap(file);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 400;
        canvas.height = 185;
        const context = canvas.getContext('2d');
        if (!context) return null;
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
        const width = bitmap.width * scale;
        const height = bitmap.height * scale;
        context.drawImage(bitmap, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
        return blob ? new File([blob], 'course-cover.png', { type: 'image/png' }) : null;
      } finally {
        bitmap.close();
      }
    } catch {
      return null;
    }
  }

  async function uploadCover(file: File) {
    if (coverInFlight.current) return;
    if (mediaLimits && file.size > mediaLimits.imageBytes) {
      setCoverError(
        L(
          locale,
          `封面超过单文件上限 ${formatBytes(mediaLimits.imageBytes)}（当前 ${formatBytes(file.size)}）。`,
          `Cover exceeds the ${formatBytes(mediaLimits.imageBytes)} per-file limit (this file is ${formatBytes(file.size)}).`,
        ),
      );
      return;
    }
    coverInFlight.current = true;
    setCoverBusy(true);
    setCoverError('');
    setCoverPct(0);
    try {
      const fitted = await fitCover(file);
      if (!fitted) {
        setCoverError(L(locale, '请使用有效的 JPG 或 PNG 图片。', 'Use a valid JPG or PNG image.'));
        return;
      }
      if (mediaLimits && fitted.size > mediaLimits.imageBytes) {
        setCoverError(L(locale, '适配后的封面超过单文件上限，请使用较简单的图片。', 'The fitted cover exceeds the per-file limit. Please use a simpler image.'));
        return;
      }
      const result = await uploadFileWithProgress(`/api/backoffice/courses/${course.id}/cover`, fitted, setCoverPct);
      if (result.success) {
        onNotice(L(locale, '封面已上传。', 'Cover uploaded.'));
        await onReload();
      } else {
        setCoverError(result.errorMessage ?? L(locale, '封面上传失败。', 'Cover upload failed.'));
      }
    } finally {
      coverInFlight.current = false;
      setCoverPct(null);
      setCoverBusy(false);
    }
  }

  async function removeCover() {
    if (coverInFlight.current || !window.confirm(L(locale, '移除当前封面？', 'Remove the current cover?'))) return;
    coverInFlight.current = true;
    setCoverBusy(true);
    try {
      const result = await boRequest(`/api/backoffice/courses/${course.id}/cover`, { method: 'DELETE' });
      if (result.success) {
        onNotice(L(locale, '封面已移除。', 'Cover removed.'));
        await onReload();
      } else {
        setCoverError(result.message ?? L(locale, '移除封面失败。', 'Could not remove the cover.'));
      }
    } finally {
      coverInFlight.current = false;
      setCoverBusy(false);
    }
  }

  async function save(next: boolean) {
    // 保存的是点击这一刻的草稿；保存期间新打的字与这份不同，仍会对新基线保持 dirty，不会被清除。
    const sent: InfoDraft = { categoryId, titleEn, titleZh, descEn, descZh, overviewEn, overviewZh, learnRows, providesRows };
    setBusy(true);
    // 一个请求、一个事务：分类和两种语言的内容一起保存，要么全保存要么都不保存；
    // 失败时页面上输入的内容保持不动。
    const result = await boRequest(`/api/backoffice/courses/${course.id}/information`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(informationBody(sent)),
    });
    setBusy(false);
    if (result.success) {
      // 服务器已接受这份内容：把它作为新基线。草稿随之变 clean，由「只在脏时写」规则删除本地记录。
      setDraftSource((current) => (current ? { ...current, snapshot: sent } : current));
      onNotice(L(locale, '课程信息已保存。', 'Course information saved.'));
      await onReload();
      if (next) onNext();
    } else {
      reportFailure(L(locale, '保存失败', 'Save failed'), result);
    }
  }

  async function addLanguage() {
    if (!newLanguage) return;
    setBusy(true);
    // 学习语言只能追加；只发这一个追加项，不动页面上正在编辑的其它内容。
    const updated = await boRequest(`/api/backoffice/courses/${course.id}/information`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ addLearningLanguages: [newLanguage] }),
    });
    if (updated.success) {
      setLanguageOpen(false);
      onNotice(L(locale, `已添加学习语言 ${languageLabel(locale, newLanguage)}。`, `Learning language ${languageLabel(locale, newLanguage)} added.`));
      await onReload();
    } else {
      reportFailure(L(locale, '添加语言失败', 'Add language failed'), updated);
    }
    setBusy(false);
  }

  const narrow = useNarrowLayout();
  /** 丢弃本地草稿：删掉存储记录，把表单重置到最新服务器快照（不发任何服务器请求）。 */
  function discardDraft() {
    removeDraft(draftIdentity);
    applyInfoDraft(serverDraft);
    setDraftSource((current) => (current ? { ...current, snapshot: serverDraft } : current));
    setDraftRestored(false);
    setDraftServerChanged(false);
  }
  return (
    <>
      <div
        data-testid="info-root"
        style={{
          height: '100%',
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : 'minmax(0, 40%) minmax(0, 1fr)',
          gridTemplateRows: narrow ? 'minmax(0, 1fr) minmax(0, 1fr) auto' : 'minmax(0, 1fr) auto',
          gap: 16,
        }}
      >
        <div data-testid="info-left" data-panel="info-left" style={{ overflow: 'auto', minWidth: 0, minHeight: 0 }}>
      {draftRestored && (
        <div
          data-testid="draft-restored"
          role="status"
          aria-live="polite"
          style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', background: '#F3F7FF', border: '1px solid #D6E2F8', borderRadius: 8, padding: '8px 12px', fontSize: 13, marginBottom: 10 }}
        >
          <span>{t(locale as Locale, 'course.ui.draftRestored')}</span>
          {draftServerChanged && <span data-testid="draft-server-changed" style={{ color: '#5A6577' }}>{t(locale as Locale, 'course.ui.draftServerChanged')}</span>}
          <button type="button" data-testid="draft-discard" style={{ ...buttonStyle, padding: '4px 10px' }} onClick={discardDraft}>
            {t(locale as Locale, 'course.ui.draftDiscard')}
          </button>
        </div>
      )}
      <div style={{ ...card, marginTop: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 className="course-ui-blockTitle">{L(locale, '基础信息', 'Basics')}</h2>
            <p style={{ margin: '6px 0 0', fontSize: 12, opacity: 0.65 }}>
              {L(locale, '课程信息是学生端课程卡片和详情页的唯一数据源。所有中英文字段均为必填。', 'Course Information is the single source for learner cards and the course page. All EN and ZH fields are required.')}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span data-testid="info-complete"><Chip tone={infoComplete ? 'green' : 'amber'}>
              {infoComplete ? L(locale, '已完成', 'Complete') : L(locale, '未完成', 'Incomplete')}
            </Chip></span>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)', gap: 18, marginTop: 16 }}>
          <Field label={L(locale, '分类 *', 'Category *')}>
            <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} style={inputStyle}>
              <option value="">{L(locale, '未分类', 'Uncategorized')}</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>{category.name}</option>
              ))}
            </select>
            <IssueText>{at('category', null)}</IssueText>
          </Field>
          <Field
            label={L(locale, '课程封面 *', 'Course cover *')}
            hint={
              mediaLimits
                ? L(locale, `JPG 或 PNG，自动适配 400 × 185 px，单文件最大 ${formatBytes(mediaLimits.imageBytes)}。`, `JPG or PNG, fitted to 400 × 185 px, up to ${formatBytes(mediaLimits.imageBytes)}.`)
                : L(locale, 'JPG 或 PNG，自动适配 400 × 185 px。', 'JPG or PNG, fitted to 400 × 185 px.')
            }
          >
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              {course.cover ? (
                <img src={`/api/backoffice/courses/${course.id}/cover?asset=${encodeURIComponent(course.cover.id)}`} alt="" style={{ width: 120, maxWidth: '100%', height: 'auto', aspectRatio: '400 / 185', objectFit: 'contain', borderRadius: 8, border: '1px solid #E8EDF5' }} />
              ) : (
                <div style={{ width: 120, height: 56, borderRadius: 8, background: '#F3F5F9', display: 'grid', placeItems: 'center', fontSize: 12, color: '#5A6577' }}>
                  {L(locale, '未上传', 'No image')}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <label style={{ ...buttonStyle, display: 'inline-flex', alignItems: 'center', cursor: coverBusy ? 'not-allowed' : 'pointer' }}>
                  {course.cover ? L(locale, '替换图片', 'Replace image') : L(locale, '上传封面', 'Upload cover')}
                  <input
                    type="file"
                    accept="image/png,image/jpeg"
                    disabled={coverBusy}
                    style={{ display: 'none' }}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void uploadCover(file);
                      event.currentTarget.value = '';
                    }}
                  />
                </label>
                {course.cover && <button type="button" style={dangerBtn} disabled={coverBusy} onClick={() => void removeCover()}>{L(locale, '移除', 'Remove')}</button>}
              </div>
            </div>
            {coverBusy && (
              <UploadProgress
                tone="active"
                title={L(locale, '正在上传封面…', 'Uploading cover…')}
                pct={coverPct ?? 0}
              />
            )}
            {coverError && <div style={{ fontSize: 12, color: '#b42318', marginTop: 6 }}>{coverError}</div>}
            <IssueText>{at('cover', null)}</IssueText>
          </Field>
        </div>

        <div style={{ marginTop: 14, padding: 12, borderRadius: 10, background: '#F7F9FC', display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }}>
          <span><strong>{L(locale, '学习模式', 'Learning mode')}:</strong> {learningModeLabel(locale, course.learningMode)}</span>
          <span><strong>{L(locale, '学习语言', 'Learning languages')}:</strong> {course.learningLanguages.map((language) => languageLabel(locale, language)).join(', ')}</span>
          <span style={{ opacity: 0.65 }}>{L(locale, '— 创建后锁定', '— locked at creation')}</span>
          {languageOptions.length > 0 && (
            <button type="button" style={buttonStyle} onClick={() => { setNewLanguage(languageOptions[0]); setLanguageOpen(true); }}>
              + {L(locale, '添加学习语言', 'Add learning language')}
            </button>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 18 }}>
          <Field label={t(locale as Locale, 'course.ui.infoCourseId')} hint={t(locale as Locale, 'course.ui.systemAssigned')}>
            <input data-testid="info-course-id" readOnly aria-readonly="true" value={course.code} style={{ ...inputStyle, background: '#F5F7FA' }} />
          </Field>
          <Field label={t(locale as Locale, 'course.ui.infoSlug')} hint={t(locale as Locale, 'course.ui.systemAssigned')}>
            <input data-testid="info-slug" readOnly aria-readonly="true" value={course.slug} style={{ ...inputStyle, background: '#F5F7FA' }} />
          </Field>
        </div>
      </div>

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>{L(locale, '你将学到什么', "What you'll learn")}</h2>
            <p style={{ margin: '6px 0 0', fontSize: 12, opacity: 0.65 }}>{L(locale, '推荐 6 条 · 至少 4 条 · 可排序', '6 recommended · minimum 4 · drag to reorder')}</p>
          </div>
          <Chip tone={listHasIssue('learn') ? 'amber' : 'green'}>
            {learnRows.length} {L(locale, '条', 'items')} · {learnRows.length < 6 ? L(locale, '推荐 6 条', '6 recommended') : L(locale, '已足够', 'ready')}
          </Chip>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '46px minmax(0, 1fr) minmax(0, 1fr) 92px', gap: 8, marginTop: 12, fontSize: 12, fontWeight: 600, color: '#5A6577' }}>
          <span>#</span><span>{L(locale, '英文', 'English')}</span><span>{L(locale, '中文', 'Chinese')}</span><span />
        </div>
        {learnRows.map((row, index) => (
          <div key={index}>
            <div style={{ display: 'grid', gridTemplateColumns: '46px minmax(0, 1fr) minmax(0, 1fr) 92px', gap: 8, alignItems: 'center', marginTop: 8 }}>
              <span style={{ fontSize: 13 }}>{index + 1}</span>
              <input data-testid={`learn-en-${index}`} ref={index === learnRows.length - 1 ? learnFocus : undefined} value={row.en} onChange={(event) => setLearnRows((rows) => rows.map((item, i) => i === index ? { ...item, en: event.target.value } : item))} style={inputStyle} />
              <input data-testid={`learn-zh-${index}`} value={row.zh} onChange={(event) => setLearnRows((rows) => rows.map((item, i) => i === index ? { ...item, zh: event.target.value } : item))} style={inputStyle} />
              <div style={{ display: 'flex', gap: 4 }}>
                <button type="button" style={{ ...buttonStyle, padding: '6px 8px' }} onClick={() => moveLearn(index, -1)}>↑</button>
                <button type="button" style={{ ...buttonStyle, padding: '6px 8px' }} onClick={() => moveLearn(index, 1)}>↓</button>
                <button type="button" style={{ ...dangerBtn, padding: '6px 8px' }} onClick={() => setLearnRows((rows) => rows.filter((_, i) => i !== index))}>×</button>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '46px minmax(0, 1fr) minmax(0, 1fr) 92px', gap: 8 }}>
              <span /><div><IssueText>{at(`learn[${index}]`, 'en-GB')}</IssueText></div><div><IssueText>{at(`learn[${index}]`, 'zh-CN')}</IssueText></div><span />
            </div>
          </div>
        ))}
        <IssueText>{listIssue('learn')}</IssueText>
        <button type="button" style={{ ...buttonStyle, marginTop: 12 }} onClick={addLearnRow}>+ {L(locale, '添加一项', 'Add item')}</button>
      </div>

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>{L(locale, '本课程提供', 'This course provides')}</h2>
            <p style={{ margin: '6px 0 0', fontSize: 12, opacity: 0.65 }}>{L(locale, '最多 6 条 · 6 条推荐 · 可排序', 'Up to 6 · 6 recommended · drag to reorder')}</p>
          </div>
          <Chip tone={listHasIssue('provides') ? 'amber' : 'green'}>
            {providesRows.length} / 6 · {providesRows.length < 6 ? L(locale, '推荐 6 条', '6 recommended') : '6 / 6'}
          </Chip>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '46px minmax(0, 1fr) minmax(0, 1fr) 92px', gap: 8, marginTop: 12, fontSize: 12, fontWeight: 600, color: '#5A6577' }}>
          <span>#</span><span>{L(locale, '英文', 'English')}</span><span>{L(locale, '中文', 'Chinese')}</span><span />
        </div>
        {providesRows.map((row, index) => {
          const preset = row.key ? PRESETS.find((item) => item.key === row.key) : undefined;
          return (
            <div key={`${row.key ?? 'custom'}-${index}`}>
              <div style={{ display: 'grid', gridTemplateColumns: '46px minmax(0, 1fr) minmax(0, 1fr) 92px', gap: 8, alignItems: 'center', marginTop: 8 }}>
                <span style={{ fontSize: 13 }}>{index + 1}</span>
                <div>
                  <input data-testid={`provides-en-${index}`} value={row.en} readOnly={row.type === 'preset'} onChange={(event) => setProvidesRows((rows) => rows.map((item, i) => i === index ? { ...item, en: event.target.value } : item))} style={{ ...inputStyle, background: row.type === 'preset' ? '#F5F7FA' : '#fff' }} />
                  {preset && <div style={{ fontSize: 11, color: '#5A6577', marginTop: 2 }}>{L(locale, '预设', 'Preset')}</div>}
                </div>
                <input data-testid={`provides-zh-${index}`} value={row.zh} readOnly={row.type === 'preset'} onChange={(event) => setProvidesRows((rows) => rows.map((item, i) => i === index ? { ...item, zh: event.target.value } : item))} style={{ ...inputStyle, background: row.type === 'preset' ? '#F5F7FA' : '#fff' }} />
                <div style={{ display: 'flex', gap: 4 }}>
                  <button type="button" style={{ ...buttonStyle, padding: '6px 8px' }} onClick={() => moveProvide(index, -1)}>↑</button>
                  <button type="button" style={{ ...buttonStyle, padding: '6px 8px' }} onClick={() => moveProvide(index, 1)}>↓</button>
                  <button type="button" style={{ ...dangerBtn, padding: '6px 8px' }} onClick={() => setProvidesRows((rows) => rows.filter((_, i) => i !== index))}>×</button>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '46px minmax(0, 1fr) minmax(0, 1fr) 92px', gap: 8 }}>
                <span /><div><IssueText>{at(`provides[${index}]`, 'en-GB')}</IssueText></div><div><IssueText>{at(`provides[${index}]`, 'zh-CN')}</IssueText></div><span />
              </div>
            </div>
          );
        })}
        <IssueText>{listIssue('provides')}</IssueText>
        <div style={{ position: 'relative', marginTop: 12 }}>
          <button type="button" style={buttonStyle} disabled={!canAddProvide} onClick={() => setAddMenu((value) => !value)}>
            + {canAddProvide ? L(locale, '添加一项', 'Add item') : L(locale, '已满 6 项', 'Full · 6 / 6')}
          </button>
          {addMenu && canAddProvide && (
            <div style={{ position: 'absolute', zIndex: 5, marginTop: 6, width: 330, maxWidth: '100%', background: '#fff', border: '1px solid #E8EDF5', borderRadius: 10, boxShadow: '0 8px 20px rgba(15,23,42,0.1)', padding: 8 }}>
              {PRESETS.map((preset) => {
                const added = providesRows.some((row) => row.key === preset.key);
                return (
                  <button key={preset.key} type="button" disabled={added} onClick={() => addPreset(preset.key)} style={{ display: 'flex', justifyContent: 'space-between', width: '100%', border: 0, background: 'none', padding: '8px 10px', textAlign: 'left', cursor: added ? 'not-allowed' : 'pointer', opacity: added ? 0.45 : 1, borderRadius: 6 }}>
                    <span>{preset.en}<div style={{ fontSize: 11, opacity: 0.65 }}>{preset.zh}</div></span>
                    <span style={{ fontSize: 11 }}>{added ? L(locale, '已添加', 'Added') : ''}</span>
                  </button>
                );
              })}
              <button type="button" onClick={() => { setCustomOpen(true); setAddMenu(false); }} style={{ width: '100%', border: 0, borderTop: '1px solid #EEF1F6', background: 'none', padding: '9px 10px', textAlign: 'left', cursor: 'pointer', color: '#2B58C8', fontWeight: 600 }}>
                + {L(locale, '自定义项', 'Custom item')}
              </button>
            </div>
          )}
        </div>
      </div>

        </div>
        <div data-testid="info-right" data-panel="info-right" style={{ overflow: 'auto', minWidth: 0, minHeight: 0 }}>
      <div style={{ ...card, marginTop: 0 }}>
        <h2 className="course-ui-blockTitle">{L(locale, '标题与简介', 'Title and descriptions')}</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 18, marginTop: 12 }}>
          <div>
            <label style={labelStyle}>{L(locale, '英文', 'English')}</label>
            <Field label={L(locale, '课程名称 *', 'Course title *')} hint={`${titleEn.length} / 30`}>
              <input value={titleEn} onChange={(event) => setTitleEn(event.target.value)} style={inputStyle} data-testid="info-title-en" />
              <IssueText>{at('title', 'en-GB')}</IssueText>
            </Field>
            <Field label={L(locale, '简述 *', 'Short description *')} hint={`${descEn.length} / 225`}>
              <textarea rows={4} value={descEn} onChange={(event) => setDescEn(event.target.value)} style={inputStyle} data-testid="info-desc-en" />
              <IssueText>{at('shortDescription', 'en-GB')}</IssueText>
            </Field>
            <Field label={L(locale, '课程概览 *', 'Overview *')} hint={`${overviewEn.length} / 650`}>
              <textarea rows={7} value={overviewEn} onChange={(event) => setOverviewEn(event.target.value)} style={inputStyle} data-testid="info-overview-en" />
              <IssueText>{at('overview', 'en-GB')}</IssueText>
            </Field>
          </div>
          <div>
            <label style={labelStyle}>{L(locale, '中文', 'Chinese')}</label>
            <Field label={L(locale, '课程名称 *', 'Course title *')} hint={`${titleZh.length} / 14`}>
              <input value={titleZh} onChange={(event) => setTitleZh(event.target.value)} style={inputStyle} data-testid="info-title-zh" />
              <IssueText>{at('title', 'zh-CN')}</IssueText>
            </Field>
            <Field label={L(locale, '简述 *', 'Short description *')} hint={`${descZh.length} / 100`}>
              <textarea rows={4} value={descZh} onChange={(event) => setDescZh(event.target.value)} style={inputStyle} data-testid="info-desc-zh" />
              <IssueText>{at('shortDescription', 'zh-CN')}</IssueText>
            </Field>
            <Field label={L(locale, '课程概览 *', 'Overview *')} hint={`${overviewZh.length} / 380`}>
              <textarea rows={7} value={overviewZh} onChange={(event) => setOverviewZh(event.target.value)} style={inputStyle} data-testid="info-overview-zh" />
              <IssueText>{at('overview', 'zh-CN')}</IssueText>
            </Field>
          </div>
        </div>
      </div>
        </div>
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" style={primaryBtn} disabled={busy} onClick={() => void save(false)}>{L(locale, '保存', 'Save')}</button>
          <button type="button" style={buttonStyle} disabled={busy} onClick={() => void save(true)}>{L(locale, '保存并下一步', 'Save & next')}</button>
        </div>
      </div>

      {customOpen && (
        <Modal title={L(locale, '自定义项', 'Custom item')} onClose={() => setCustomOpen(false)}>
          <Field label={L(locale, '英文 *', 'English *')}><input data-testid="custom-en" value={customEn} onChange={(event) => setCustomEn(event.target.value)} style={inputStyle} /></Field>
          <Field label={L(locale, '中文 *', 'Chinese *')}><input data-testid="custom-zh" value={customZh} onChange={(event) => setCustomZh(event.target.value)} style={inputStyle} /></Field>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button type="button" style={primaryBtn} disabled={!customEn.trim() || !customZh.trim()} onClick={addCustom}>{L(locale, '添加', 'Add')}</button>
            <button type="button" style={buttonStyle} onClick={() => setCustomOpen(false)}>{L(locale, '取消', 'Cancel')}</button>
          </div>
        </Modal>
      )}

      {languageOpen && (
        <Modal title={L(locale, '添加学习语言', 'Add learning language')} onClose={() => setLanguageOpen(false)}>
          <p style={{ fontSize: 13, color: '#5A6577' }}>
            {L(locale, '添加后不能删除。所有课时需要补齐该语言的全套学习材料。', 'A language cannot be removed after it is added. Every lesson must then be completed in that language.')}
          </p>
          <Field label={L(locale, '要添加的语言', 'Language to add')}>
            <select value={newLanguage} onChange={(event) => setNewLanguage(event.target.value)} style={inputStyle}>
              {languageOptions.map((language) => <option key={language} value={language}>{languageLabel(locale, language)}</option>)}
            </select>
          </Field>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button type="button" style={primaryBtn} disabled={busy} onClick={() => void addLanguage()}>{L(locale, '添加', 'Add')}</button>
            <button type="button" style={buttonStyle} onClick={() => setLanguageOpen(false)}>{L(locale, '取消', 'Cancel')}</button>
          </div>
        </Modal>
      )}
    </>
  );
}
