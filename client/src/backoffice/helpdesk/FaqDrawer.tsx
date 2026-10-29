import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import { FAQ_CATEGORIES, type FaqCategory, type HelpdeskFaq } from '../contracts/helpdesk'
import { archiveFaq, createFaq, getFaq, getFaqEdges, newIdempotencyKey, updateFaq } from '../lib/helpdeskApi'
import {
  FAQ_LIMITS,
  applyBold,
  applyLink,
  applyList,
  draftFromFaq,
  emptyFaqDraft,
  faqKeyFor,
  faqSaveOutcome,
  isDraftDirty,
  toFaqBody,
  validateFaqDraft,
  type FaqDraft,
  type FaqDrawerResult,
  type FaqField,
  type FaqFieldError,
  type FaqKey,
  type TextEdit,
} from '../lib/helpdeskFaqs'
import { errorMessage, faqCategoryLabel } from '../lib/helpdeskFormat'
import { isImeComposing } from '../lib/helpdeskView'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import { FaqLinksEditor, FaqNodeFields } from './FaqGraphSection'
import { useModal } from './useModal'

/**
 * 新增 / 编辑 FAQ 抽屉（Tickets v2 §3b，Figma 1379:299）：盖在 Tab 下方的内容区上，右侧 620 宽。
 * 保存即发布（中英文都必填）；新建带 Idempotency-Key（同内容重试沿用），编辑带 version，
 * 版本冲突时载入最新版本、保留草稿。Delete（归档）与「未保存的修改」确认在 Figma 里没有画板，
 * 沿用同一套样式（待视觉验收）。抽屉是模态层（useModal）：Tab 不出抽屉（确认框打开时不出确认框），
 * Escape 在哪儿按都算、输入法组字时不算；保存失败或版本冲突的提示会拿到焦点，滚到哪儿都看得见。
 */

type AnswerField = 'answerEn' | 'answerZh'
type Confirm = 'delete' | 'discard' | null
type LinkTarget = { field: AnswerField; start: number; end: number } | null

type Props = {
  locale: Locale
  /** null = 新增。 */
  faq: HelpdeskFaq | null
  onClose: () => void
  onDone: (result: FaqDrawerResult) => void
}

function fieldErrorText(locale: Locale, field: FaqField, error: FaqFieldError): string {
  if (error === 'tooLong') {
    if (field === 'keywords') return t(locale, 'helpDesk.drawer.errors.keywordTooLong')
    const max = field === 'answerEn' || field === 'answerZh' ? FAQ_LIMITS.answerMax : FAQ_LIMITS.questionMax
    return t(locale, 'helpDesk.drawer.errors.tooLong', { max })
  }
  return t(locale, `helpDesk.drawer.errors.${error}`)
}

export function FaqDrawer({ locale, faq, onClose, onDone }: Props) {
  const uid = useId()
  const ids = {
    title: `${uid}-title`,
    category: `${uid}-category`,
    popular: `${uid}-popular`,
    questionEn: `${uid}-question-en`,
    answerEn: `${uid}-answer-en`,
    questionZh: `${uid}-question-zh`,
    answerZh: `${uid}-answer-zh`,
    keywords: `${uid}-keywords`,
    link: `${uid}-link`,
    confirm: `${uid}-confirm`,
    graph: `${uid}-graph`,
  }
  const [base, setBase] = useState<HelpdeskFaq | null>(faq)
  const [original, setOriginal] = useState<FaqDraft>(() => (faq ? draftFromFaq(faq) : emptyFaqDraft()))
  const [draft, setDraft] = useState<FaqDraft>(original)
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  // 删除被拒（FAQ_HAS_PARENTS）：列出还在用它的已发布父问题（graph design §2.3「拒绝，并列出父节点」；
  // 沿用提示框与 hdTreeWarnings 列表样式，没有 Figma 画板，待视觉验收）
  const [parentQuestions, setParentQuestions] = useState<string[]>([])
  const [conflict, setConflict] = useState(false)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [linkTarget, setLinkTarget] = useState<LinkTarget>(null)
  const [linkUrl, setLinkUrl] = useState('')
  const [linkInvalid, setLinkInvalid] = useState(false)
  const keyRef = useRef<FaqKey | null>(null)
  const answerEnRef = useRef<HTMLTextAreaElement>(null)
  const answerZhRef = useRef<HTMLTextAreaElement>(null)
  const answers = { answerEn: answerEnRef, answerZh: answerZhRef }
  const pendingSelection = useRef<{ field: AnswerField; start: number; end: number } | null>(null)
  const firstField = useRef<HTMLSelectElement>(null)
  const confirmFocus = useRef<HTMLButtonElement>(null)
  const drawerRef = useRef<HTMLElement>(null)
  const confirmRef = useRef<HTMLDivElement>(null)
  const alertRef = useRef<HTMLDivElement>(null)
  const statusRef = useRef<HTMLDivElement>(null)
  const [noticeShown, setNoticeShown] = useState(0)

  const errors = submitted ? validateFaqDraft(draft) : {}
  const editing = base !== null

  // 打开时把焦点放进抽屉，关闭时还给打开它的按钮
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    firstField.current?.focus()
    return () => opener?.focus?.()
  }, [])

  useEffect(() => {
    if (confirm) confirmFocus.current?.focus()
  }, [confirm])

  // 保存 / 删除失败、版本冲突：提示在可滚动区域的顶上，把焦点给它（浏览器随之滚到它）
  useEffect(() => {
    if (noticeShown) (alertRef.current ?? statusRef.current)?.focus()
  }, [noticeShown])

  useModal(
    () => confirmRef.current ?? drawerRef.current,
    () => {
      if (confirm) setConfirm(null)
      else if (linkTarget) setLinkTarget(null)
      else requestClose()
    },
  )

  // 工具栏改完文字后恢复选区（受控 textarea 重渲染会把光标挪到最后）
  useLayoutEffect(() => {
    const pending = pendingSelection.current
    if (!pending) return
    pendingSelection.current = null
    const area = answers[pending.field].current
    if (!area) return
    area.focus()
    area.setSelectionRange(pending.start, pending.end)
  })

  function set<K extends keyof FaqDraft>(key: K, value: FaqDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  function applyEdit(field: AnswerField, edit: TextEdit) {
    pendingSelection.current = { field, start: edit.selectionStart, end: edit.selectionEnd }
    set(field, edit.value)
  }

  function selection(field: AnswerField): { value: string; start: number; end: number } {
    const area = answers[field].current
    const value = draft[field]
    if (!area) return { value, start: value.length, end: value.length }
    return { value, start: area.selectionStart ?? value.length, end: area.selectionEnd ?? value.length }
  }

  function format(field: AnswerField, kind: 'bold' | 'ordered' | 'bullet' | 'link') {
    const { value, start, end } = selection(field)
    if (kind === 'bold') return applyEdit(field, applyBold(value, start, end))
    if (kind === 'link') {
      setLinkTarget({ field, start, end })
      setLinkUrl('')
      setLinkInvalid(false)
      return
    }
    applyEdit(field, applyList(value, start, end, kind))
  }

  function insertLink() {
    if (!linkTarget) return
    const edit = applyLink(draft[linkTarget.field], linkTarget.start, linkTarget.end, linkUrl)
    if (!edit) {
      setLinkInvalid(true)
      return
    }
    const field = linkTarget.field
    setLinkTarget(null)
    applyEdit(field, edit)
  }

  function requestClose() {
    if (saving) return
    if (isDraftDirty(draft, original)) setConfirm('discard')
    else onClose()
  }

  async function save() {
    if (saving) return
    setSubmitted(true)
    const found = validateFaqDraft(draft)
    const firstInvalid = (Object.keys(found) as FaqField[])[0]
    if (firstInvalid) {
      document.getElementById(ids[firstInvalid])?.focus()
      return
    }
    const body = toFaqBody(draft)
    setSaving(true)
    setErrorCode(null)
    let result
    if (base) {
      result = await updateFaq(base.id, { ...body, version: base.version })
    } else {
      keyRef.current = faqKeyFor(keyRef.current, body, newIdempotencyKey)
      result = await createFaq(body, keyRef.current.key)
    }
    const outcome = faqSaveOutcome(result)
    if (outcome === 'saved') return onDone('saved')
    if (outcome === 'gone') return onDone('gone')
    if (outcome === 'conflict' && base) {
      const latest = await getFaq(base.id)
      if (!latest.ok && latest.code === 'FAQ_NOT_FOUND') return onDone('gone')
      if (latest.ok) {
        // 保留员工的草稿，只换成最新的 version；再保存即覆盖
        setBase(latest.data)
        setOriginal(draftFromFaq(latest.data))
        setConflict(true)
      } else {
        setErrorCode(latest.code)
      }
      setNoticeShown((value) => value + 1)
    } else if (!result.ok) {
      setErrorCode(result.code)
      setNoticeShown((value) => value + 1)
    }
    setSaving(false)
  }

  async function remove() {
    if (!base || saving) return
    setSaving(true)
    setErrorCode(null)
    setParentQuestions([])
    const result = await archiveFaq(base.id, base.version)
    if (result.ok) return onDone('deleted')
    if (result.code === 'FAQ_NOT_FOUND') return onDone('gone')
    setConfirm(null)
    if (result.code === 'VERSION_CONFLICT') {
      const latest = await getFaq(base.id)
      if (latest.ok) {
        setBase(latest.data)
        setConflict(true)
      }
    } else {
      setErrorCode(result.code)
      if (result.code === 'FAQ_HAS_PARENTS') {
        const edges = await getFaqEdges(base.id)
        if (edges.ok)
          setParentQuestions(
            edges.data.parents
              .filter((view) => view.node?.status === 'published')
              .map((view) => (locale === 'zh-CN' ? view.node!.questionZh : view.node!.questionEn)),
          )
      }
    }
    setNoticeShown((value) => value + 1)
    setSaving(false)
  }

  function errorFor(field: FaqField): ReactNode {
    const error = errors[field]
    if (!error) return null
    return (
      <p className="hdFieldError" id={`${ids[field]}-error`}>
        {fieldErrorText(locale, field, error)}
      </p>
    )
  }

  function invalidProps(field: FaqField) {
    const invalid = Boolean(errors[field])
    return { 'aria-invalid': invalid, 'aria-describedby': invalid ? `${ids[field]}-error` : undefined }
  }

  function label(field: FaqField, key: string, required = true) {
    return (
      <label className="hdFieldLabel" htmlFor={ids[field]}>
        {t(locale, key)}
        {required ? (
          <span className="hdRequired" aria-hidden="true">
            {' '}
            *
          </span>
        ) : null}
      </label>
    )
  }

  function editor(field: AnswerField, key: string, size: 'Large' | 'Small') {
    const tool = (kind: 'bold' | 'ordered' | 'bullet' | 'link', text: string) => (
      <button
        type="button"
        className="hdEditorTool"
        aria-label={t(locale, `helpDesk.drawer.toolbar.${kind}`)}
        // 按下时不让 textarea 失焦，选区才留得住
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => format(field, kind)}
      >
        {text}
      </button>
    )
    return (
      <div className="hdField">
        {label(field, key)}
        <div className={`hdEditor hdEditor${size}${errors[field] ? ' hdEditorInvalid' : ''}`}>
          <div
            className="hdEditorToolbar"
            role="toolbar"
            aria-label={t(locale, 'helpDesk.drawer.toolbar.label')}
            aria-controls={ids[field]}
          >
            {tool('bold', 'B')}
            {tool('ordered', '1.')}
            {tool('bullet', '•')}
            {tool('link', t(locale, 'helpDesk.drawer.toolbar.link'))}
          </div>
          {linkTarget?.field === field ? (
            <div className="hdLinkRow">
              <input
                id={ids.link}
                className="hdLinkInput"
                type="url"
                inputMode="url"
                autoFocus
                value={linkUrl}
                aria-label={t(locale, 'helpDesk.drawer.link.url')}
                aria-invalid={linkInvalid}
                placeholder={t(locale, 'helpDesk.drawer.link.placeholder')}
                onChange={(event) => {
                  setLinkUrl(event.target.value)
                  setLinkInvalid(false)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !isImeComposing(event)) {
                    event.preventDefault()
                    insertLink()
                  }
                }}
              />
              <button type="button" className="hdDrawerButton hdDrawerPrimary" onClick={insertLink}>
                {t(locale, 'helpDesk.drawer.link.insert')}
              </button>
              <button type="button" className="hdDrawerButton" onClick={() => setLinkTarget(null)}>
                {t(locale, 'helpDesk.drawer.link.cancel')}
              </button>
              {linkInvalid ? <p className="hdFieldError hdLinkError">{t(locale, 'helpDesk.drawer.link.invalid')}</p> : null}
            </div>
          ) : null}
          <textarea
            id={ids[field]}
            ref={answers[field]}
            className="hdEditorArea"
            value={draft[field]}
            onChange={(event) => set(field, event.target.value)}
            {...invalidProps(field)}
          />
        </div>
        {errorFor(field)}
      </div>
    )
  }

  return (
    <div className="hdDrawerLayer">
      <div className="hdDrawerBackdrop" aria-hidden="true" onClick={requestClose} />
      <aside ref={drawerRef} className="hdDrawer" role="dialog" aria-modal="true" aria-labelledby={ids.title}>
        <header className="hdDrawerHead">
          <div className="hdDrawerHeading">
            <h2 className="hdDrawerTitle" id={ids.title}>
              {t(locale, editing ? 'helpDesk.drawer.editTitle' : 'helpDesk.drawer.addTitle')}
            </h2>
            <p className="hdDrawerSubtitle">{t(locale, 'helpDesk.drawer.subtitle')}</p>
          </div>
          <button type="button" className="hdDrawerClose" aria-label={t(locale, 'helpDesk.drawer.close')} onClick={requestClose}>
            ×
          </button>
        </header>

        <div className="hdDrawerBody">
          {conflict ? (
            <div ref={statusRef} className="hdNotice hdDrawerNotice" role="status" tabIndex={-1}>
              {t(locale, 'helpDesk.drawer.conflict')}
            </div>
          ) : null}
          {errorCode ? (
            <div ref={alertRef} className="hdNotice hdDrawerNotice hdDrawerAlert" role="alert" tabIndex={-1}>
              {errorMessage(locale, errorCode)}
              {errorCode === 'FAQ_HAS_PARENTS' && parentQuestions.length > 0 ? (
                <ul className="hdTreeWarnings">
                  {parentQuestions.map((question, at) => (
                    <li key={`${at}-${question}`}>{question}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <div className="hdDrawerRow">
            <div className="hdField hdFieldCategory">
              {label('category', 'helpDesk.drawer.category')}
              <select
                id={ids.category}
                ref={firstField}
                className="hdDrawerSelect"
                value={draft.category ?? ''}
                onChange={(event) => set('category', (event.target.value || null) as FaqCategory | null)}
                {...invalidProps('category')}
              >
                <option value="" disabled>
                  {t(locale, 'helpDesk.drawer.categoryPlaceholder')}
                </option>
                {FAQ_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {faqCategoryLabel(locale, category)}
                  </option>
                ))}
              </select>
              {errorFor('category')}
            </div>
            <label className="hdCheck" htmlFor={ids.popular}>
              <input
                id={ids.popular}
                type="checkbox"
                className="hdCheckInput"
                checked={draft.popular}
                onChange={(event) => set('popular', event.target.checked)}
              />
              <span>{t(locale, 'helpDesk.drawer.popular')}</span>
            </label>
          </div>

          <div className="hdField">
            {label('questionEn', 'helpDesk.drawer.questionEn')}
            <input
              id={ids.questionEn}
              className="hdDrawerInput"
              value={draft.questionEn}
              onChange={(event) => set('questionEn', event.target.value)}
              {...invalidProps('questionEn')}
            />
            {errorFor('questionEn')}
          </div>
          {editor('answerEn', 'helpDesk.drawer.answerEn', 'Large')}

          <div className="hdField">
            {label('questionZh', 'helpDesk.drawer.questionZh')}
            <input
              id={ids.questionZh}
              className="hdDrawerInput"
              lang="zh-CN"
              value={draft.questionZh}
              onChange={(event) => set('questionZh', event.target.value)}
              {...invalidProps('questionZh')}
            />
            {errorFor('questionZh')}
          </div>
          {editor('answerZh', 'helpDesk.drawer.answerZh', 'Small')}

          <div className="hdField">
            {label('keywords', 'helpDesk.drawer.keywords', false)}
            <input
              id={ids.keywords}
              className="hdDrawerInput hdDrawerInputSmall"
              value={draft.keywords}
              placeholder={t(locale, 'helpDesk.drawer.keywordsPlaceholder')}
              onChange={(event) => set('keywords', event.target.value)}
              {...invalidProps('keywords')}
            />
            {errorFor('keywords')}
          </div>

          {/* v5「追问与选项」（graph design §5.1）：没有 Figma 画板，沿用抽屉的样式，待视觉验收 */}
          <section className="hdGraphSection" aria-labelledby={ids.graph}>
            <h3 className="hdGraphTitle" id={ids.graph}>
              {t(locale, 'helpDesk.graph.title')}
            </h3>
            <p className="hdGraphHint">{t(locale, editing ? 'helpDesk.graph.hint' : 'helpDesk.graph.newHint')}</p>
            <FaqNodeFields locale={locale} draft={draft} onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))} />
            {base ? <FaqLinksEditor key={base.id} locale={locale} faq={base} /> : null}
          </section>
        </div>

        <footer className="hdDrawerFoot">
          {editing ? (
            <button
              type="button"
              className="hdLinkButton hdLinkDanger hdDrawerDelete"
              disabled={saving}
              onClick={() => setConfirm('delete')}
            >
              {t(locale, 'helpDesk.drawer.delete')}
            </button>
          ) : null}
          <span className="hdDrawerSpacer" />
          <button type="button" className="hdDrawerButton hdDrawerCancel" disabled={saving} onClick={requestClose}>
            {t(locale, 'helpDesk.drawer.cancel')}
          </button>
          <button type="button" className="hdDrawerButton hdDrawerPrimary hdDrawerSave" disabled={saving} onClick={() => void save()}>
            {t(locale, saving ? 'helpDesk.drawer.saving' : 'helpDesk.drawer.save')}
          </button>
        </footer>

        {confirm ? (
          <div className="hdConfirmLayer">
            <div ref={confirmRef} className="hdConfirm" role="alertdialog" aria-modal="true" aria-labelledby={ids.confirm}>
              <p className="hdConfirmText" id={ids.confirm}>
                {t(locale, confirm === 'delete' ? 'helpDesk.drawer.deleteConfirm' : 'helpDesk.drawer.discardTitle')}
              </p>
              <div className="hdConfirmActions">
                <button ref={confirmFocus} type="button" className="hdDrawerButton" onClick={() => setConfirm(null)}>
                  {t(locale, confirm === 'delete' ? 'helpDesk.drawer.deleteNo' : 'helpDesk.drawer.discardNo')}
                </button>
                {confirm === 'delete' ? (
                  <button type="button" className="hdDrawerButton hdDrawerDanger" disabled={saving} onClick={() => void remove()}>
                    {t(locale, 'helpDesk.drawer.deleteYes')}
                  </button>
                ) : (
                  <button type="button" className="hdDrawerButton hdDrawerDanger" onClick={onClose}>
                    {t(locale, 'helpDesk.drawer.discardYes')}
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </aside>
    </div>
  )
}
