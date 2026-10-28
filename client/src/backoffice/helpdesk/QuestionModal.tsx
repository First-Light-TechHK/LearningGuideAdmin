import { useState } from 'react'

import { Button, Input, Modal, Select, Switch, TextArea } from '../../components/ui'
import {
  HELPDESK_CATEGORIES,
  HELPDESK_LOCALES,
  type HelpdeskCategory,
  type HelpdeskLocale,
  type HelpdeskQuestion,
} from '../contracts/helpdesk'
import { createQuestion, updateQuestion, type HelpdeskResult } from '../lib/helpdeskApi'
import { categoryLabel, contentLocaleLabel, errorMessage } from '../lib/helpdeskFormat'
import {
  QUESTION_LIMITS,
  draftFromQuestion,
  emptyDraft,
  toCreateBody,
  toUpdateBody,
  validateDraft,
  type DraftErrors,
  type QuestionDraft,
} from '../lib/helpdeskQuestions'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'

/**
 * 「+ Add Question」/ 编辑弹窗（Figma addendum §A）。没有 Figma 画板：沿用 Knowledge / AI Tutor 的
 * antd 弹窗与表单控件（待视觉验收）。字段：语言、类型、问题、答案、关键词、精选、立即发布（仅新建）。
 */

type Props = {
  locale: Locale
  /** null = 新建 */
  question: HelpdeskQuestion | null
  defaultLocale: HelpdeskLocale
  onClose: () => void
  /** 保存成功；conflict = 版本冲突，调用方需刷新列表。 */
  onSaved: (question: HelpdeskQuestion | null, outcome: 'saved' | 'conflict') => void
}

function Field({
  label,
  error,
  hint,
  children,
  htmlFor,
}: {
  label: string
  error?: string
  hint?: string
  children: React.ReactNode
  htmlFor?: string
}) {
  return (
    <div className="hdFormField">
      <label className="hdFormLabel" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? <p className="hdFieldError">{error}</p> : hint ? <p className="hdFormHint">{hint}</p> : null}
    </div>
  )
}

export function QuestionModal({ locale, question, defaultLocale, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState<QuestionDraft>(() =>
    question ? draftFromQuestion(question) : emptyDraft(defaultLocale),
  )
  const [errors, setErrors] = useState<DraftErrors>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // 点过一次保存后，改字段即时重新校验（错误提示随改随消）
  const [submitted, setSubmitted] = useState(false)

  function patch(next: Partial<QuestionDraft>) {
    const updated = { ...draft, ...next }
    setDraft(updated)
    if (submitted) setErrors(validateDraft(updated))
    setSubmitError(null)
  }

  const errorText = (field: keyof DraftErrors) =>
    errors[field] ? t(locale, `helpDesk.modal.${errors[field]}`) : undefined

  async function save() {
    const found = validateDraft(draft)
    setSubmitted(true)
    setErrors(found)
    if (Object.keys(found).length > 0 || saving) return
    setSaving(true)
    const result: HelpdeskResult<HelpdeskQuestion> = question
      ? await updateQuestion(question.id, toUpdateBody(draft, question.version))
      : await createQuestion(toCreateBody(draft))
    setSaving(false)
    if (result.ok) {
      onSaved(result.data, 'saved')
      return
    }
    if (result.code === 'VERSION_CONFLICT' || result.code === 'QUESTION_NOT_FOUND') {
      onSaved(null, 'conflict')
    }
    setSubmitError(errorMessage(locale, result.code))
  }

  return (
    <Modal
      open
      width={640}
      title={t(locale, question ? 'helpDesk.modal.editTitle' : 'helpDesk.modal.createTitle')}
      onCancel={onClose}
      destroyOnHidden
      maskClosable={!saving}
      footer={[
        <Button key="cancel" onClick={onClose} disabled={saving}>
          {t(locale, 'common.cancel')}
        </Button>,
        <Button key="save" type="primary" loading={saving} onClick={() => void save()}>
          {saving ? t(locale, 'helpDesk.modal.saving') : t(locale, 'helpDesk.modal.save')}
        </Button>,
      ]}
    >
      <p className="hdFormHint hdModalIntro">{t(locale, 'helpDesk.modal.subtitle')}</p>
      <div className="hdFormGrid">
        <Field label={t(locale, 'helpDesk.modal.locale')} htmlFor="hd-q-locale">
          <Select
            id="hd-q-locale"
            value={draft.locale}
            onChange={(value: HelpdeskLocale) => patch({ locale: value })}
            options={HELPDESK_LOCALES.map((value) => ({ value, label: contentLocaleLabel(locale, value) }))}
          />
        </Field>
        <Field label={t(locale, 'helpDesk.modal.category')} error={errorText('category')} htmlFor="hd-q-category">
          <Select
            id="hd-q-category"
            value={draft.category ?? undefined}
            placeholder={t(locale, 'helpDesk.modal.categoryPlaceholder')}
            status={errors.category ? 'error' : undefined}
            onChange={(value: HelpdeskCategory) => patch({ category: value })}
            options={HELPDESK_CATEGORIES.map((value) => ({ value, label: categoryLabel(locale, value) }))}
          />
        </Field>
      </div>
      <Field label={t(locale, 'helpDesk.modal.question')} error={errorText('question')} htmlFor="hd-q-question">
        <Input
          id="hd-q-question"
          value={draft.question}
          maxLength={QUESTION_LIMITS.questionMax}
          showCount
          status={errors.question ? 'error' : undefined}
          onChange={(event) => patch({ question: event.target.value })}
        />
      </Field>
      <Field
        label={t(locale, 'helpDesk.modal.answer')}
        error={errorText('answer')}
        hint={t(locale, 'helpDesk.modal.answerHint')}
        htmlFor="hd-q-answer"
      >
        <TextArea
          id="hd-q-answer"
          value={draft.answer}
          rows={6}
          maxLength={QUESTION_LIMITS.answerMax}
          showCount
          status={errors.answer ? 'error' : undefined}
          onChange={(event) => patch({ answer: event.target.value })}
        />
      </Field>
      <Field
        label={t(locale, 'helpDesk.modal.keywords')}
        error={errorText('keywords')}
        hint={t(locale, 'helpDesk.modal.keywordsHint')}
        htmlFor="hd-q-keywords"
      >
        <Select
          id="hd-q-keywords"
          mode="tags"
          value={draft.keywords}
          open={false}
          suffixIcon={null}
          tokenSeparators={[',', '，']}
          placeholder={t(locale, 'helpDesk.modal.keywordsPlaceholder')}
          status={errors.keywords ? 'error' : undefined}
          onChange={(value: string[]) => patch({ keywords: value })}
        />
      </Field>
      <div className="hdSwitchRow">
        <label className="hdSwitch">
          <Switch size="small" checked={draft.featured} onChange={(checked) => patch({ featured: checked })} />
          <span>{t(locale, 'helpDesk.modal.featured')}</span>
        </label>
        {question ? null : (
          <label className="hdSwitch">
            <Switch size="small" checked={draft.publish} onChange={(checked) => patch({ publish: checked })} />
            <span>{t(locale, 'helpDesk.modal.publish')}</span>
          </label>
        )}
      </div>
      {submitError ? (
        <div className="alert alertError hdModalError" role="alert">
          {submitError}
        </div>
      ) : null}
    </Modal>
  )
}
