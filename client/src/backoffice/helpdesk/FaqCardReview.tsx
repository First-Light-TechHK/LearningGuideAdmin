import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useSearchParams } from 'react-router-dom'

import {
  FAQ_CATEGORIES,
  FAQ_REVIEW_FILTERS,
  type FaqCategory,
  type FaqHistoryEntry,
  type FaqReviewFilter,
  type FaqReviewList,
  type FaqReviewState,
  type HelpdeskFaq,
} from '../contracts/helpdesk'
import { archiveFaq, getFaq, getFaqHistory, listFaqReviews, newIdempotencyKey, reviewFaq, rewriteFaq, updateFaq } from '../lib/helpdeskApi'
import {
  FAQ_CATEGORY_SWATCH,
  FAQ_LIMITS,
  draftFromFaq,
  isDraftDirty,
  toFaqBody,
  validateFaqDraft,
  type FaqDraft,
  type FaqField,
} from '../lib/helpdeskFaqs'
import { errorMessage, faqCategoryLabel, rewriteWarningText } from '../lib/helpdeskFormat'
import {
  aiHistory,
  cleanSelection,
  currentVersion,
  editHistory,
  goTo,
  rebase,
  startHistory,
  type CardHistory,
  type TextSelection,
} from '../lib/helpdeskVersions'
import { longDate } from '../lib/helpdeskView'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import { AiComposer, VersionBar } from './CardAssist'

/**
 * 卡片全表「逐张审核」（常见问题 Tab，?view=review&rstate=&card=）：和候选审核页同一套一屏界面。
 * 左边队列按审核状态筛（未审核 / 需要改 / 已审核 / 全部，带张数，热门在前）；中间就是这张卡，像 Claude Artifact：
 * 直接改，或者跟 AI 说怎么改，每次改动一个版本；右边是这张卡的审核状态和改动记录（谁、什么时候、改了什么）。
 * 按钮：「没问题」（有改动时是「保存修改并标为已审」）、「需要改」（要写为什么）、「下线」（两步确认，= 归档）。
 * J / K 切换，Ctrl / ⌘ + Enter 按主按钮。只读角色只能看。没有 Figma，待视觉验收。
 */

const NOTE_MAX = 500
/** 队列一页（服务端一页至多 50）。 */
const QUEUE_SIZE = 50

type Mode = 'decide' | 'needsChange' | 'confirmArchive'
type Lang = 'zh' | 'en'
type Alert = { tone: 'alert' | 'status'; text: string } | null
type StateFilter = FaqReviewFilter
/** 一张卡和它的审核状态（列表里的卡 + reviews[卡 id]）。 */
type Item = { faq: HelpdeskFaq; review: FaqReviewState }

const STATE_FILTERS: readonly StateFilter[] = FAQ_REVIEW_FILTERS
const NO_REVIEW: FaqReviewState = { status: 'unreviewed', faqVersion: null, note: null, by: null, at: null }

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

function readStateFilter(raw: string | null): StateFilter {
  return (STATE_FILTERS as (string | null)[]).includes(raw) ? (raw as StateFilter) : 'unreviewed'
}

type Props = {
  locale: Locale
  canWrite: boolean
  q: string
  category: FaqCategory | 'all'
  refreshKey: number
  onChanged: () => void
  onPreview: (faq: HelpdeskFaq) => void
}

export function FaqCardReview({ locale, canWrite, q, category, refreshKey, onChanged, onPreview }: Props) {
  const [searchParams, setSearchParams] = useSearchParams()
  const state = readStateFilter(searchParams.get('rstate'))
  const selectedId = searchParams.get('card')
  const pageNo = Math.max(1, Number(searchParams.get('rpage')) || 1)
  const [page, setPage] = useState<FaqReviewList | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  // 最近一次回来的请求属于哪组参数：和当前不同就是「加载中」
  const requestKey = JSON.stringify([state, q, category, pageNo, refreshKey, reload])
  const [settledFor, setSettledFor] = useState<string | null>(null)
  const loading = settledFor !== requestKey
  const [flash, setFlash] = useState<{ text: string; at: number } | null>(null)
  const queueRef = useRef<HTMLElement>(null)
  const request = useRef(0)

  useEffect(() => {
    const id = ++request.current
    const key = JSON.stringify([state, q, category, pageNo, refreshKey, reload])
    void listFaqReviews({ status: state, q, category, page: pageNo, pageSize: QUEUE_SIZE }).then((result) => {
      if (id !== request.current) return
      setSettledFor(key)
      if (result.ok) {
        setPage(result.data)
        setErrorCode(null)
      } else setErrorCode(result.code)
    })
  }, [state, q, category, pageNo, refreshKey, reload])

  useEffect(() => {
    if (!flash) return
    const timer = setTimeout(() => setFlash(null), 5000)
    return () => clearTimeout(timer)
  }, [flash])

  const rows: Item[] = (page?.faqs ?? []).map((faq) => ({ faq, review: page?.reviews[faq.id] ?? NO_REVIEW }))
  const counts = page ? { ...page.counts, all: page.counts.unreviewed + page.counts.needs_change + page.counts.ok } : null
  const totalPages = page ? Math.max(1, Math.ceil(page.total / QUEUE_SIZE)) : 1
  const ids = rows.map((row) => row.faq.id)
  const current = selectedId && ids.includes(selectedId) ? selectedId : (ids[0] ?? null)
  const item = rows.find((row) => row.faq.id === current) ?? null

  const select = useCallback(
    (id: string | null, replace = false) => {
      const params = new URLSearchParams(searchParams)
      if (id) params.set('card', id)
      else params.delete('card')
      setSearchParams(params, { replace })
    },
    [searchParams, setSearchParams],
  )

  function setState(next: StateFilter) {
    const params = new URLSearchParams(searchParams)
    params.set('rstate', next)
    params.delete('card')
    params.delete('rpage')
    setSearchParams(params)
  }

  function setPageNo(next: number) {
    const params = new URLSearchParams(searchParams)
    if (next > 1) params.set('rpage', String(next))
    else params.delete('rpage')
    params.delete('card')
    setSearchParams(params)
  }

  // J / K 切换（不在输入框里、没有弹层时）
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      if (event.key !== 'j' && event.key !== 'k') return
      const at = current ? ids.indexOf(current) : -1
      const next = ids[event.key === 'j' ? at + 1 : at - 1]
      if (next) select(next, true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, ids, select])

  function onQueueKey(event: ReactKeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const at = current ? ids.indexOf(current) : -1
    const next = ids[event.key === 'ArrowDown' ? at + 1 : at - 1]
    if (!next) return
    select(next, true)
    requestAnimationFrame(() => queueRef.current?.querySelector<HTMLButtonElement>(`[data-id="${next}"]`)?.focus())
  }

  const zh = locale === 'zh-CN'

  return (
    <div className="hdReviewLayout">
      {flash ? (
        <div className="hdReviewToast" role="status" key={flash.at}>
          {flash.text}
        </div>
      ) : null}
      <nav ref={queueRef} className="hdReviewQueue" aria-label={t(locale, 'helpDesk.faqReview.queue')} aria-busy={loading}>
        <div className="hdFaqReviewStates" role="group" aria-label={t(locale, 'helpDesk.faqReview.stateLabel')}>
          {STATE_FILTERS.map((key) => (
            <button
              key={key}
              type="button"
              className={`hdFaqReviewStateBtn${state === key ? ' hdFaqReviewStateOn' : ''}`}
              aria-pressed={state === key}
              onClick={() => setState(key)}
            >
              <span>{t(locale, `helpDesk.faqReview.filter.${key}`)}</span>
              <span className="hdFaqReviewStateCount">{counts ? counts[key] : '–'}</span>
            </button>
          ))}
        </div>
        <p className="hdReviewQueueHead">
          <span>
            {page && totalPages > 1
              ? t(locale, 'helpDesk.faqReview.pageOf', { page: pageNo, pages: totalPages, total: page.total })
              : t(locale, 'helpDesk.faqReview.count', { count: page?.total ?? 0 })}
          </span>
          <span className="hdReviewKeys">{t(locale, 'helpDesk.review.keys')}</span>
        </p>
        <ul className="hdReviewQueueList" onKeyDown={onQueueKey}>
          {rows.map((row) => {
            const on = row.faq.id === current
            const swatch = FAQ_CATEGORY_SWATCH[row.faq.category] ?? FAQ_CATEGORY_SWATCH.other
            return (
              <li key={row.faq.id}>
                <button
                  type="button"
                  data-id={row.faq.id}
                  className={`hdReviewQueueCard${on ? ' hdReviewQueueCardOn' : ''}`}
                  aria-current={on ? 'true' : undefined}
                  onClick={() => select(row.faq.id)}
                >
                  <span className="hdReviewQueueQuestion">{zh ? row.faq.questionZh : row.faq.questionEn}</span>
                  <span className="hdReviewQueueMeta">
                    <span className="hdReviewQueueTag" style={{ background: swatch.bg, color: swatch.fg }}>
                      {faqCategoryLabel(locale, row.faq.category)}
                    </span>
                    <span className={`hdReviewQueueTag hdFaqReviewTag-${row.review.status}`}>{stateLabel(locale, row)}</span>
                    {row.faq.popular ? <span>{t(locale, 'helpDesk.faqReview.popular')}</span> : null}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        {totalPages > 1 ? (
          <div className="hdFaqReviewPager">
            <button
              type="button"
              className="hdVersionStep"
              aria-label={t(locale, 'helpDesk.faqs.previous')}
              disabled={pageNo <= 1}
              onClick={() => setPageNo(pageNo - 1)}
            >
              ‹
            </button>
            <span>{t(locale, 'helpDesk.faqs.page', { page: pageNo })}</span>
            <button
              type="button"
              className="hdVersionStep"
              aria-label={t(locale, 'helpDesk.faqs.next')}
              disabled={pageNo >= totalPages}
              onClick={() => setPageNo(pageNo + 1)}
            >
              ›
            </button>
          </div>
        ) : null}
      </nav>

      {errorCode ? (
        <div className="hdReviewEmpty" role="alert">
          {errorMessage(locale, errorCode)}
        </div>
      ) : item ? (
        <CardWorkspace
          key={`${item.faq.id}:${item.faq.version}`}
          locale={locale}
          item={item}
          canWrite={canWrite}
          onPreview={onPreview}
          onDone={(message) => {
            setFlash({ text: message, at: Date.now() })
            const at = ids.indexOf(item.faq.id)
            const next = ids[at + 1] ?? ids[at - 1] ?? null
            onChanged()
            setReload((value) => value + 1)
            select(next, true)
          }}
          onReload={() => setReload((value) => value + 1)}
        />
      ) : (
        <div className="hdReviewEmpty">
          {loading ? t(locale, 'helpDesk.candidates.loading') : t(locale, `helpDesk.faqReview.empty.${state}`)}
        </div>
      )}
    </div>
  )
}

/** 审过、但卡后来改了：「改过，待复核」。 */
const changedSince = (item: Item) =>
  item.review.status === 'unreviewed' && item.review.faqVersion !== null && item.review.faqVersion < item.faq.version

function stateLabel(locale: Locale, item: Item): string {
  if (changedSince(item)) return t(locale, 'helpDesk.faqReview.state.changedSince')
  return t(locale, `helpDesk.faqReview.state.${item.review.status}`)
}

/** 改动记录里的一条：谁做了什么。 */
function historyLine(locale: Locale, entry: FaqHistoryEntry): string {
  if (entry.kind === 'review') return t(locale, `helpDesk.faqReview.action.review_${entry.action}`, { version: entry.version })
  if (entry.kind === 'placement') return t(locale, `helpDesk.faqReview.action.place_${entry.action}`, { place: entry.nodeKey ?? '—' })
  const action = ['create', 'update', 'archive'].includes(entry.action) ? entry.action : 'update'
  return t(locale, `helpDesk.faqReview.action.${action}`, { version: entry.version })
}

/* ---------------------------------- 一张卡 ---------------------------------- */

type WorkspaceProps = {
  locale: Locale
  item: Item
  canWrite: boolean
  onPreview: (faq: HelpdeskFaq) => void
  onDone: (message: string) => void
  onReload: () => void
}

const TEXT_FIELDS = ['questionZh', 'answerZh', 'questionEn', 'answerEn'] as const

function CardWorkspace({ locale, item, canWrite, onPreview, onDone, onReload }: WorkspaceProps) {
  const uid = useId()
  const zh = locale === 'zh-CN'
  const [base, setBase] = useState<HelpdeskFaq>(item.faq)
  const [original, setOriginal] = useState<FaqDraft>(() => draftFromFaq(item.faq))
  const [history, setHistory] = useState<CardHistory>(() => startHistory(draftFromFaq(item.faq)))
  const historyRef = useRef(history)
  useLayoutEffect(() => {
    historyRef.current = history
  }, [history])
  const draft = currentVersion(history).draft
  const [lang, setLang] = useState<Lang>(zh ? 'zh' : 'en')
  const [mode, setMode] = useState<Mode>('decide')
  const [note, setNote] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [alert, setAlert] = useState<Alert>(null)
  const [selection, setSelection] = useState<TextSelection | null>(null)
  const [assistBusy, setAssistBusy] = useState(false)
  const [assistError, setAssistError] = useState<string | null>(null)
  const [assistWarnings, setAssistWarnings] = useState<string[]>([])
  const [entries, setEntries] = useState<FaqHistoryEntry[] | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const keyRef = useRef<{ key: string; body: string } | null>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    let live = true
    void getFaqHistory(item.faq.id).then((result) => {
      if (!live) return
      if (result.ok) setEntries(result.data.history)
      else setHistoryError(result.code)
    })
    return () => {
      live = false
    }
  }, [item.faq.id])

  const dirty = isDraftDirty(draft, original)
  const errors = validateFaqDraft(draft)
  const cleanNote = note.trim()
  const noteTooLong = [...cleanNote].length > NOTE_MAX

  function patchDraft(patch: Partial<FaqDraft>) {
    const next = editHistory(historyRef.current, patch)
    historyRef.current = next
    setHistory(next)
    setAlert(null)
  }

  async function rewrite(instruction: string): Promise<boolean> {
    if (assistBusy) return false
    const scope = cleanSelection(draft, selection)
    setAssistBusy(true)
    setAssistError(null)
    setAssistWarnings([])
    const result = await rewriteFaq({
      questionZh: draft.questionZh,
      answerZh: draft.answerZh,
      questionEn: draft.questionEn,
      answerEn: draft.answerEn,
      category: draft.category,
      instruction,
      lang,
      ...(scope ? { selection: scope } : {}),
    })
    if (!mounted.current) return false
    setAssistBusy(false)
    if (!result.ok) {
      setAssistError(errorMessage(locale, result.code))
      return false
    }
    const { category, ...texts } = result.data.draft
    const latest = historyRef.current
    const known = (FAQ_CATEGORIES as readonly string[]).includes(category ?? '')
      ? (category as FaqCategory)
      : currentVersion(latest).draft.category
    const next = aiHistory(latest, { ...texts, category: known }, instruction)
    if (!next) {
      setAssistError(t(locale, 'helpDesk.review.assist.noChange'))
      return true
    }
    setHistory(next)
    setSelection(null)
    setAssistWarnings((result.data.warnings ?? []).map((warning) => rewriteWarningText(locale, warning)))
    const changed = currentVersion(next).changed
    if (!changed.some((field) => field.endsWith(lang === 'zh' ? 'Zh' : 'En')) && changed.some((field) => field !== 'category'))
      setLang(lang === 'zh' ? 'en' : 'zh')
    return true
  }

  /** 同样的内容重试沿用同一个 key（网络断了再点不会记两次）。 */
  function keyFor(body: unknown): string {
    const text = JSON.stringify(body)
    if (!keyRef.current || keyRef.current.body !== text) keyRef.current = { key: newIdempotencyKey(), body: text }
    return keyRef.current.key
  }

  /** 别人先改了：载入最新的卡，你的版本都还在（第一版换成最新的）。 */
  async function refreshBase() {
    const latest = await getFaq(base.id)
    if (!latest.ok || !mounted.current) return
    setBase(latest.data)
    setOriginal(draftFromFaq(latest.data))
    setHistory((all) => rebase(all, draftFromFaq(latest.data)))
  }

  async function markOk() {
    setSubmitted(true)
    if (dirty && Object.keys(errors).length > 0) return
    setBusy(true)
    setAlert(null)
    let version = base.version
    if (dirty) {
      const saved = await updateFaq(base.id, { ...toFaqBody(draft), version: base.version })
      if (!mounted.current) return
      if (!saved.ok) {
        setBusy(false)
        if (saved.status === 409) await refreshBase()
        if (saved.status === 404) onReload()
        return setAlert({ tone: 'alert', text: errorMessage(locale, saved.code) })
      }
      setBase(saved.data)
      setOriginal(draft)
      version = saved.data.version
    }
    const body = { status: 'ok' as const, version }
    const result = await reviewFaq(base.id, body, keyFor({ id: base.id, ...body }))
    if (!mounted.current) return
    setBusy(false)
    if (!result.ok) {
      if (result.status === 409) await refreshBase()
      return setAlert({
        tone: 'alert',
        text: dirty ? t(locale, 'helpDesk.faqReview.savedNotReviewed') : errorMessage(locale, result.code),
      })
    }
    onDone(t(locale, dirty ? 'helpDesk.faqReview.done.saved' : 'helpDesk.faqReview.done.ok'))
  }

  async function markNeedsChange() {
    setSubmitted(true)
    if (!cleanNote || noteTooLong) return
    setBusy(true)
    setAlert(null)
    const body = { status: 'needs_change' as const, version: base.version, note: cleanNote }
    const result = await reviewFaq(base.id, body, keyFor({ id: base.id, ...body }))
    if (!mounted.current) return
    setBusy(false)
    if (!result.ok) {
      if (result.status === 409) await refreshBase()
      return setAlert({ tone: 'alert', text: errorMessage(locale, result.code) })
    }
    onDone(t(locale, 'helpDesk.faqReview.done.needsChange'))
  }

  async function archive() {
    setBusy(true)
    setAlert(null)
    const result = await archiveFaq(base.id, base.version)
    if (!mounted.current) return
    setBusy(false)
    if (!result.ok) {
      if (result.status === 409 && result.code === 'VERSION_CONFLICT') await refreshBase()
      setMode('decide')
      return setAlert({ tone: 'alert', text: errorMessage(locale, result.code) })
    }
    onDone(t(locale, 'helpDesk.faqReview.done.archived'))
  }

  const version = currentVersion(history)
  const aiChanged = (field: string) => version.origin === 'ai' && (version.changed as string[]).includes(field)
  const langChanged = (value: Lang) =>
    value === 'zh' ? aiChanged('questionZh') || aiChanged('answerZh') : aiChanged('questionEn') || aiChanged('answerEn')
  const langHasError = (value: Lang) =>
    submitted && dirty && (value === 'zh' ? errors.questionZh || errors.answerZh : errors.questionEn || errors.answerEn)

  const selectionText = (() => {
    const scope = cleanSelection(draft, selection)
    if (!scope) return null
    const text = (draft[scope.field] ?? '').slice(scope.start, scope.end)
    return text.length > 40 ? `${text.slice(0, 40)}…` : text
  })()

  function textField(field: (typeof TEXT_FIELDS)[number], labelKey: string, rows: number) {
    const invalid = submitted && dirty && Boolean(errors[field])
    return (
      <div className="hdReviewField">
        <label className="hdReviewLabel" htmlFor={`${uid}-${field}`}>
          {t(locale, labelKey)}
        </label>
        <textarea
          id={`${uid}-${field}`}
          className={`hdTextarea hdReviewText${rows > 2 ? ' hdReviewTextAnswer' : ''}${aiChanged(field) ? ' hdReviewTextChanged' : ''}`}
          rows={rows}
          value={draft[field]}
          readOnly={!canWrite}
          disabled={busy}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${uid}-${field}-error` : undefined}
          onChange={(event) => patchDraft({ [field]: event.target.value })}
          onSelect={(event) => {
            const { selectionStart, selectionEnd } = event.currentTarget
            setSelection(selectionEnd - selectionStart >= 2 ? { field, start: selectionStart, end: selectionEnd } : null)
          }}
        />
        {aiChanged(field) ? <p className="hdReviewChangedNote">{t(locale, 'helpDesk.review.assist.changedHere')}</p> : null}
        {invalid ? (
          <p className="hdFieldError" id={`${uid}-${field}-error`}>
            {t(locale, `helpDesk.drawer.errors.${errors[field as FaqField]}`, {
              max: field.startsWith('question') ? FAQ_LIMITS.questionMax : FAQ_LIMITS.answerMax,
            })}
          </p>
        ) : null}
      </div>
    )
  }

  const review = item.review

  const shortcutHint = (
    <kbd className="hdReviewKbd" aria-hidden="true">
      {t(locale, 'helpDesk.review.shortcut')}
    </kbd>
  )

  const footerNote = (() => {
    if (alert)
      return (
        <p className={alert.tone === 'alert' ? 'hdReviewFootAlert' : 'hdReviewFootNote'} role={alert.tone}>
          {alert.text}
        </p>
      )
    if (!canWrite) return <p className="hdReviewFootNote">{t(locale, 'helpDesk.faqReview.readOnly')}</p>
    if (mode === 'confirmArchive')
      return (
        <p className="hdReviewFootAlert" role="alert">
          {t(locale, 'helpDesk.faqReview.confirmArchive')}
        </p>
      )
    if (mode === 'needsChange' && dirty) return <p className="hdReviewFootNote">{t(locale, 'helpDesk.faqReview.editsNotSaved')}</p>
    return <p className="hdReviewFootNote">{t(locale, dirty ? 'helpDesk.faqReview.afterSave' : 'helpDesk.faqReview.afterOk')}</p>
  })()

  return (
    <section
      className="hdReviewPanel hdFaqReviewPanel"
      aria-label={zh ? base.questionZh : base.questionEn}
      aria-busy={busy}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.altKey) return
        if (!primaryRef.current || primaryRef.current.disabled) return
        event.preventDefault()
        primaryRef.current.click()
      }}
    >
      <div className="hdReviewBody">
        <div className="hdReviewEvidence">
          <section className="hdReviewEditor hdFaqReviewEditor" aria-label={t(locale, 'helpDesk.faqReview.card')}>
            <div className="hdReviewEditorHead">
              <p className="hdReviewLabel">{t(locale, 'helpDesk.faqReview.card')}</p>
              <VersionBar
                locale={locale}
                history={history}
                startKey="helpDesk.review.assist.startCard"
                onGoTo={(index) => (setHistory(goTo(history, index)), setSelection(null))}
                disabled={busy || assistBusy}
              />
              <div className="hdReviewSeg" role="group" aria-label={t(locale, 'helpDesk.review.editor.language')}>
                {(['zh', 'en'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={`hdReviewSegItem${lang === value ? ' hdReviewSegOn' : ''}`}
                    aria-pressed={lang === value}
                    onClick={() => setLang(value)}
                  >
                    {t(locale, `helpDesk.review.editor.${value}`)}
                    {langHasError(value) ? (
                      <span className="hdReviewErrDot" aria-label={t(locale, 'helpDesk.review.editor.hasError')} />
                    ) : langChanged(value) && lang !== value ? (
                      <span className="hdReviewChangedDot" aria-label={t(locale, 'helpDesk.review.assist.changedOther')} />
                    ) : null}
                  </button>
                ))}
              </div>
              <button type="button" className="hdFaqPreview" onClick={() => onPreview(base)}>
                {t(locale, 'helpDesk.faqs.preview')}
              </button>
            </div>
            <div className="hdReviewScroll">
              {lang === 'zh' ? (
                <>
                  {textField('questionZh', 'helpDesk.drawer.questionZh', 2)}
                  {textField('answerZh', 'helpDesk.drawer.answerZh', 9)}
                </>
              ) : (
                <>
                  {textField('questionEn', 'helpDesk.drawer.questionEn', 2)}
                  {textField('answerEn', 'helpDesk.drawer.answerEn', 9)}
                </>
              )}
              <div className="hdReviewField hdReviewFieldRow">
                <label className="hdReviewLabel" htmlFor={`${uid}-category`}>
                  {t(locale, 'helpDesk.drawer.category')}
                </label>
                <select
                  id={`${uid}-category`}
                  className="hdReviewSelect"
                  value={draft.category ?? ''}
                  disabled={!canWrite || busy}
                  onChange={(event) => patchDraft({ category: event.target.value as FaqCategory })}
                >
                  {FAQ_CATEGORIES.map((value) => (
                    <option key={value} value={value}>
                      {faqCategoryLabel(locale, value)}
                    </option>
                  ))}
                </select>
                <label className="hdFaqReviewPopular">
                  <input
                    type="checkbox"
                    checked={draft.popular}
                    disabled={!canWrite || busy}
                    onChange={(event) => patchDraft({ popular: event.target.checked })}
                  />
                  {t(locale, 'helpDesk.faqReview.popular')}
                </label>
              </div>
            </div>
          </section>
          {canWrite && mode === 'decide' ? (
            <div className="hdReviewAssistDock">
              <AiComposer
                locale={locale}
                busy={assistBusy}
                disabled={busy}
                selection={selectionText}
                onClearSelection={() => setSelection(null)}
                onSend={rewrite}
                error={assistError}
                warnings={assistWarnings}
              />
            </div>
          ) : null}
        </div>

        <div className="hdReviewDecide">
          <h4 className="hdReviewDecideTitle">{t(locale, 'helpDesk.faqReview.status')}</h4>
          <div className="hdReviewScroll hdReviewDecideBody">
            <div className={`hdFaqReviewNow hdFaqReviewNow-${review.status}`}>
              <span className={`hdReviewQueueTag hdFaqReviewTag-${review.status}`}>{stateLabel(locale, item)}</span>
              <span className="hdFaqReviewNowText">
                {review.status !== 'unreviewed'
                  ? t(locale, `helpDesk.faqReview.last.${review.status}`, {
                      by: review.by?.name ?? t(locale, 'helpDesk.faqReview.someone'),
                      when: review.at ? longDate(review.at, locale) : '—',
                      version: review.faqVersion ?? base.version,
                    })
                  : changedSince(item)
                    ? t(locale, 'helpDesk.faqReview.changedAfter', { version: review.faqVersion ?? 1, now: item.faq.version })
                    : t(locale, 'helpDesk.faqReview.never')}
              </span>
              {review.note ? <q className="hdFaqReviewQuote">{review.note}</q> : null}
            </div>

            {mode === 'needsChange' ? (
              <div className="hdReviewField">
                <label className="hdReviewLabel" htmlFor={`${uid}-note`}>
                  {t(locale, 'helpDesk.faqReview.noteLabel')}
                  <span className="hdReviewStar"> *</span>
                </label>
                <textarea
                  id={`${uid}-note`}
                  className="hdTextarea hdReviewText"
                  rows={3}
                  value={note}
                  autoFocus
                  placeholder={t(locale, 'helpDesk.faqReview.notePlaceholder')}
                  aria-invalid={submitted && (!cleanNote || noteTooLong)}
                  onChange={(event) => setNote(event.target.value)}
                />
                {submitted && !cleanNote ? <p className="hdFieldError">{t(locale, 'helpDesk.faqReview.needNote')}</p> : null}
                {noteTooLong ? <p className="hdFieldError">{t(locale, 'helpDesk.review.assist.tooLong', { max: NOTE_MAX })}</p> : null}
              </div>
            ) : null}

            <h5 className="hdFaqReviewHistoryTitle">{t(locale, 'helpDesk.faqReview.history')}</h5>
            {historyError ? (
              <p className="hdFieldError">{errorMessage(locale, historyError)}</p>
            ) : entries === null ? (
              <p className="hdGraphHint">{t(locale, 'helpDesk.candidates.loading')}</p>
            ) : entries.length === 0 ? (
              <p className="hdGraphHint">{t(locale, 'helpDesk.faqReview.historyEmpty')}</p>
            ) : (
              <ol className="hdFaqHistory">
                {entries.map((entry, index) => {
                  const tone = entry.kind === 'review' ? `review_${entry.action}` : entry.kind === 'placement' ? 'place' : entry.action
                  const fields = entry.kind === 'card' && entry.action === 'update' ? entry.changes.map((change) => change.field) : []
                  return (
                    <li key={`${entry.at}-${index}`} className={`hdFaqHistoryItem hdFaqHistory-${tone}`}>
                      <span className="hdFaqHistoryDot" aria-hidden="true" />
                      <span className="hdFaqHistoryLine">
                        <strong>{entry.by?.name ?? t(locale, 'helpDesk.faqReview.someone')}</strong> {historyLine(locale, entry)}
                      </span>
                      <span className="hdFaqHistoryWhen">{longDate(entry.at, locale)}</span>
                      {fields.length > 0 ? (
                        <span className="hdFaqHistoryFields">
                          {t(locale, 'helpDesk.faqReview.changed', {
                            fields: fields.map((field) => t(locale, `helpDesk.faqReview.fields.${field}`)).join(zh ? '、' : ', '),
                          })}
                        </span>
                      ) : null}
                      {entry.kind === 'review' && entry.note ? <q className="hdFaqReviewQuote">{entry.note}</q> : null}
                    </li>
                  )
                })}
              </ol>
            )}
          </div>
        </div>
      </div>

      <footer className="hdReviewFooter">
        <div className="hdReviewFootLeft">
          {canWrite && mode === 'decide' ? (
            <>
              <button
                type="button"
                className="hdDrawerButton"
                disabled={busy}
                onClick={() => (setMode('needsChange'), setSubmitted(false), setAlert(null))}
              >
                {t(locale, 'helpDesk.faqReview.needsChange')}
              </button>
              <button
                type="button"
                className="hdDrawerButton hdFaqReviewArchive"
                disabled={busy}
                onClick={() => (setMode('confirmArchive'), setAlert(null))}
              >
                {t(locale, 'helpDesk.faqReview.archive')}
              </button>
            </>
          ) : null}
          {canWrite && mode !== 'decide' ? (
            <button type="button" className="hdDrawerButton" disabled={busy} onClick={() => (setMode('decide'), setSubmitted(false))}>
              {t(locale, 'helpDesk.candidates.cancel')}
            </button>
          ) : null}
        </div>
        <div className="hdReviewFootMid">{footerNote}</div>
        {canWrite ? (
          mode === 'confirmArchive' ? (
            <button
              ref={primaryRef}
              type="button"
              className="hdDrawerButton hdDrawerDanger"
              disabled={busy}
              aria-keyshortcuts="Control+Enter Meta+Enter"
              onClick={() => void archive()}
            >
              {t(locale, busy ? 'helpDesk.candidates.saving' : 'helpDesk.faqReview.confirmArchiveButton')}
              {shortcutHint}
            </button>
          ) : mode === 'needsChange' ? (
            <button
              ref={primaryRef}
              type="button"
              className="hdDrawerButton hdDrawerPrimary"
              disabled={busy}
              aria-keyshortcuts="Control+Enter Meta+Enter"
              onClick={() => void markNeedsChange()}
            >
              {t(locale, busy ? 'helpDesk.candidates.saving' : 'helpDesk.faqReview.confirmNeedsChange')}
              {shortcutHint}
            </button>
          ) : (
            <button
              ref={primaryRef}
              type="button"
              className="hdDrawerButton hdDrawerPrimary hdReviewPrimary"
              disabled={busy || assistBusy}
              aria-keyshortcuts="Control+Enter Meta+Enter"
              onClick={() => void markOk()}
            >
              {t(locale, busy ? 'helpDesk.candidates.saving' : dirty ? 'helpDesk.faqReview.saveAndOk' : 'helpDesk.faqReview.ok')}
              {shortcutHint}
            </button>
          )
        ) : null}
      </footer>
    </section>
  )
}
