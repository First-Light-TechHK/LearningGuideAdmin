import { useState } from 'react';

import type { Lesson } from '../../contracts/course';
import { boRequest } from '../../lib/api';
import { courseErrorText } from '../../lib/courseErrors';
import { understandingImportForm } from '../../lib/courseRequests';
import { useReportFailure } from './feedback';
import { Field, Modal } from './shared';
import { L, buttonStyle, card, inputStyle, languageLabel, primaryBtn } from './shared-utils';
import type { Locale } from '../../lib/i18n/config';
import { t } from '../../lib/i18n/messages';
import { serverText } from '../../lib/i18n/serverText';
import { mergeUnderstandingDraft, parseUnderstandingDraft, understandingDraftOf, type UnderstandingDraft, type UnderstandingQuestionDraft } from './drafts/understandingDraft';
import { isDirty } from './drafts/merge';
import { restoreDraft, useDraftAutosave } from './useDraftPersistence';
import { removeDraft, type DraftIdentity } from '../../lib/editorDraftStore';

type Question = UnderstandingQuestionDraft;

export function UnderstandingPanel({
  locale,
  courseId,
  lesson,
  language,
  busy,
  setBusy,
  onSaved,
  onNotice,
  canEdit,
}: {
  locale: string;
  courseId: string;
  lesson: Lesson;
  language: string;
  busy: boolean;
  setBusy: (value: boolean) => void;
  onSaved: () => Promise<void>;
  onNotice: (message: string) => void;
  canEdit: boolean;
}) {
  const [knowledgeEnabled, setKnowledgeEnabled] = useState(true);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [applicationEnabled, setApplicationEnabled] = useState(Boolean(lesson.applicationTest));
  const [applicationScenario, setApplicationScenario] = useState(lesson.applicationTest?.scenario ?? '');
  const [applicationAnswer, setApplicationAnswer] = useState(lesson.applicationTest?.referenceAnswer ?? '');
  const [singleImportOpen, setSingleImportOpen] = useState(false);
  const [singleFile, setSingleFile] = useState<File | null>(null);
  const [singleResult, setSingleResult] = useState<{ added: number; errors: Array<{ row: number; message: string }> } | null>(null);
  const [singleBusy, setSingleBusy] = useState(false);
  const reportFailure = useReportFailure();

  const applyDraft = (draft: UnderstandingDraft) => {
    setKnowledgeEnabled(draft.knowledgeEnabled);
    setQuestions(draft.questions);
    setApplicationEnabled(draft.applicationEnabled);
    setApplicationScenario(draft.applicationScenario);
    setApplicationAnswer(draft.applicationAnswer);
  };

  const serverDraft = understandingDraftOf(lesson);
  // 身份与 Study 一致：课程 + 课时 + 内容语言。
  const draftIdentity: DraftIdentity = { courseId, step: 'understanding', lessonId: lesson.id, language };
  const draftStorageIdentity = canEdit ? draftIdentity : null;
  const [draftSource, setDraftSource] = useState<{ lessonId: string; language: string; lesson: Lesson; snapshot: UnderstandingDraft } | null>(null);
  const [draftRestored, setDraftRestored] = useState(false);
  const [draftServerChanged, setDraftServerChanged] = useState(false);
  if (!draftSource || draftSource.lessonId !== lesson.id || draftSource.language !== language) {
    // 挂载 / 换课时 / 换语言：本地有该身份的未保存草稿就先三路合并恢复。
    const restored = restoreDraft(draftStorageIdentity, serverDraft, {
      parse: parseUnderstandingDraft,
      merge: mergeUnderstandingDraft,
      dirty: isDirty,
    });
    setDraftSource({ lessonId: lesson.id, language, lesson, snapshot: serverDraft });
    applyDraft(restored.value);
    setDraftRestored(restored.restored);
    setDraftServerChanged(restored.restored && restored.serverChanged);
  } else if (draftSource.lesson !== lesson) {
    // 同身份重载（保存、导入等）：用户改过的字段保留，没改过的跟随服务器（P96）。
    const currentDraft: UnderstandingDraft = { knowledgeEnabled, questions, applicationEnabled, applicationScenario, applicationAnswer };
    setDraftSource({ ...draftSource, lesson, snapshot: serverDraft });
    applyDraft(mergeUnderstandingDraft(currentDraft, draftSource.snapshot, serverDraft));
  }

  const currentDraft: UnderstandingDraft = { knowledgeEnabled, questions, applicationEnabled, applicationScenario, applicationAnswer };
  const draftBase = draftSource?.snapshot ?? serverDraft;
  useDraftAutosave(draftStorageIdentity, currentDraft, draftBase, isDirty);
  // 草稿回到与服务器一致（保存后重载合并 / 用户改回原值）时视为无草稿，恢复提示随之消失。
  const draftDirty = isDirty(currentDraft, draftBase);
  if (draftRestored && !draftDirty) {
    setDraftRestored(false);
    setDraftServerChanged(false);
  }

  async function saveKnowledge() {
    // 保存的是点击这一刻的知识测试草稿；应用测试的未保存修改不受影响。
    const sentEnabled = knowledgeEnabled;
    const sentQuestions = knowledgeEnabled
      ? questions.map((question, index) => ({
          code: question.code || `K-${String(index + 1).padStart(4, '0')}`,
          question: question.question,
          referenceAnswer: question.referenceAnswer,
        }))
      : [];
    setBusy(true);
    const result = await boRequest(`/api/backoffice/courses/${courseId}/lessons/${lesson.id}/knowledge-test`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: sentEnabled, questions: sentQuestions }),
    });
    setBusy(false);
    if (result.success) {
      // 服务器已接受知识测试：更新基线，这部分变 clean（应用测试的脏字段仍保留）。
      setDraftSource((current) => (current ? { ...current, snapshot: { ...current.snapshot, knowledgeEnabled: sentEnabled, questions: sentQuestions } } : current));
      onNotice(L(locale, '知识测试已保存。', 'Knowledge Test saved.'));
      await onSaved();
    } else {
      reportFailure(L(locale, '保存失败', 'Save failed'), result);
    }
  }

  async function saveApplication() {
    const sentEnabled = applicationEnabled;
    const sentScenario = applicationScenario;
    const sentAnswer = applicationAnswer;
    setBusy(true);
    const result = await boRequest(`/api/backoffice/courses/${courseId}/lessons/${lesson.id}/application-test`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: sentEnabled, scenario: sentScenario, referenceAnswer: sentAnswer }),
    });
    setBusy(false);
    if (result.success) {
      // 服务器已接受应用测试：更新基线，这部分变 clean（知识测试的脏字段仍保留）。
      setDraftSource((current) =>
        current ? { ...current, snapshot: { ...current.snapshot, applicationEnabled: sentEnabled, applicationScenario: sentScenario, applicationAnswer: sentAnswer } } : current,
      );
      onNotice(L(locale, '应用测试已保存。', 'Application Test saved.'));
      await onSaved();
    } else {
      reportFailure(L(locale, '保存失败', 'Save failed'), result);
    }
  }

  function addQuestion() {
    setQuestions((current) => [
      ...current,
      {
        code: `K-${String(current.length + 1).padStart(4, '0')}`,
        question: '',
        referenceAnswer: '',
      },
    ]);
    setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>('input[data-new-question="true"]');
      input?.focus();
    }, 0);
  }

  async function runSingleImport() {
    if (!singleFile) return;
    setSingleBusy(true);
    const result = await boRequest<{ added: number; byLesson: Record<string, number>; errors: Array<{ row: number; message: string }> }>(
      `/api/backoffice/courses/${courseId}/understanding/import`,
      { method: 'POST', body: understandingImportForm(singleFile, language, lesson.id) },
    );
    setSingleBusy(false);
    if (result.success) {
      setSingleResult({ added: result.data.added, errors: result.data.errors ?? [] });
      if (result.data.added > 0) await onSaved();
    } else {
      setSingleResult({ added: 0, errors: [{ row: 0, message: courseErrorText(locale, result) }] });
    }
  }

  function downloadTemplate() {
    window.open(`/api/backoffice/courses/${courseId}/understanding/template`, '_blank');
  }

  /** 丢弃本地草稿：删掉存储记录，把面板重置到最新服务器快照（不发任何服务器请求）。 */
  function discardDraft() {
    removeDraft(draftIdentity);
    applyDraft(serverDraft);
    setDraftSource((current) => (current ? { ...current, snapshot: serverDraft } : current));
    setDraftRestored(false);
    setDraftServerChanged(false);
  }

  return (
    <div>
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
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>{L(locale, '知识测试', 'Knowledge Test')}</h2>
            <p style={{ margin: '6px 0 0', fontSize: 12, opacity: 0.65 }}>{L(locale, '按添加顺序排列；新题加在末尾；不支持调整顺序。', 'Questions stay in add order; new questions go to the end; order cannot be changed.')}</p>
          </div>
          <label style={{ fontSize: 14 }}>
            <input type="checkbox" checked={knowledgeEnabled} onChange={(event) => setKnowledgeEnabled(event.target.checked)} /> {L(locale, '启用', 'Enabled')}
          </label>
        </div>

        {knowledgeEnabled && (
          <>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
              <button type="button" style={primaryBtn} onClick={addQuestion}>+ {L(locale, '添加题目', 'Add question')}</button>
              <button type="button" style={buttonStyle} onClick={() => setSingleImportOpen(true)}>{L(locale, '从表格导入', 'Import from sheet')}</button>
              <button type="button" style={buttonStyle} onClick={downloadTemplate}>{L(locale, '下载模板', 'Download template')}</button>
            </div>

            <div style={{ marginTop: 12 }}>
              {questions.map((question, index) => (
                <div key={`${question.code}-${index}`} style={{ border: '1px solid #E8EDF5', borderRadius: 10, padding: 12, marginTop: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 12, color: '#5A6577', fontWeight: 600 }}>Q{index + 1} · {question.code}</span>
                    <button type="button" style={{ ...buttonStyle, padding: '4px 8px', color: '#b42318' }} onClick={() => setQuestions((current) => current.filter((_, i) => i !== index))}>
                      {L(locale, '删除', 'Delete question')}
                    </button>
                  </div>
                  <Field label={L(locale, '题目 *', 'Question *')} hint={`${question.question.length} / 200`}>
                    <input data-new-question={index === questions.length - 1 ? 'true' : 'false'} value={question.question} onChange={(event) => setQuestions((current) => current.map((item, i) => i === index ? { ...item, question: event.target.value } : item))} style={inputStyle} />
                  </Field>
                  <Field label={L(locale, '参考答案 *', 'Reference answer *')} hint={`${question.referenceAnswer.length} / 600`}>
                    <textarea rows={4} value={question.referenceAnswer} onChange={(event) => setQuestions((current) => current.map((item, i) => i === index ? { ...item, referenceAnswer: event.target.value } : item))} style={inputStyle} />
                  </Field>
                </div>
              ))}
              {questions.length === 0 && <p style={{ opacity: 0.7, marginTop: 10 }}>{L(locale, '暂无题目。', 'No questions yet.')}</p>}
            </div>
            <button type="button" style={{ ...primaryBtn, marginTop: 12 }} disabled={busy} onClick={() => void saveKnowledge()}>{L(locale, '保存知识测试', 'Save Knowledge Test')}</button>
          </>
        )}
      </div>

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{L(locale, '应用测试', 'Application Test')}</h2>
          <label style={{ fontSize: 14 }}>
            <input type="checkbox" checked={applicationEnabled} onChange={(event) => setApplicationEnabled(event.target.checked)} /> {L(locale, '启用', 'Enabled')}
          </label>
        </div>
        {applicationEnabled && (
          <>
            <Field label={L(locale, '题目 *', 'Question *')}>
              <textarea rows={7} value={applicationScenario} onChange={(event) => setApplicationScenario(event.target.value)} style={inputStyle} />
            </Field>
            <Field label={L(locale, '参考答案 *', 'Reference answer *')} hint={L(locale, '学员提交且 AI 评估完成后展示给学员。', 'Shown to learners after AI review.')}>
              <textarea rows={7} value={applicationAnswer} onChange={(event) => setApplicationAnswer(event.target.value)} style={inputStyle} />
            </Field>
            <button type="button" style={{ ...primaryBtn, marginTop: 12 }} disabled={busy} onClick={() => void saveApplication()}>{L(locale, '保存应用测试', 'Save Application Test')}</button>
          </>
        )}
      </div>

      {singleImportOpen && (
        <Modal title={L(locale, '导入题目', 'Import questions')} onClose={() => { setSingleImportOpen(false); setSingleFile(null); setSingleResult(null); }}>
          <p style={{ fontSize: 13, color: '#5A6577' }}>{L(locale, '课时', 'Lesson')} {lesson.sortOrder} · {lesson.localizations[0]?.title ?? lesson.code} · {languageLabel(locale, language)}</p>
          <Field label={L(locale, '上传 .xlsx 或 .csv', 'Upload .xlsx or .csv')}>
            <input type="file" accept=".xlsx,.csv" onChange={(event) => { setSingleFile(event.target.files?.[0] ?? null); setSingleResult(null); }} />
          </Field>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" style={primaryBtn} disabled={!singleFile || singleBusy} onClick={() => void runSingleImport()}>{singleBusy ? L(locale, '导入中…', 'Importing…') : L(locale, '导入', 'Import')}</button>
            <button type="button" style={buttonStyle} onClick={() => window.open(`/api/backoffice/courses/${courseId}/understanding/template`, '_blank')}>{L(locale, '下载模板', 'Download template')}</button>
          </div>
          {singleResult && (
            <div style={{ marginTop: 12, fontSize: 13 }}>
              <p style={{ fontWeight: 600 }}>{L(locale, '已导入', 'Imported')} {singleResult.added} {L(locale, '题', 'questions')}</p>
              {singleResult.errors.map((error, index) => (
                <p key={index} style={{ color: '#b42318' }}>{error.row ? `${L(locale, '第', 'Row')} ${error.row} · ` : ''}{serverText(error.message, locale as Locale)}</p>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
