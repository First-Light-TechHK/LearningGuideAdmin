import { useEffect, useId, useRef, useState, type DragEvent } from 'react'

import {
  FAQ_GRAPH_LIMITS,
  FAQ_NODE_TYPES,
  FAQ_SIGNALS,
  PHRASING_LOCALES,
  type FaqEdgeKind,
  type FaqEdgeView,
  type FaqPhrasing,
  type FaqSignal,
  type HelpdeskFaq,
  type PhrasingLocale,
} from '../contracts/helpdesk'
import {
  addPhrasing,
  createFaq,
  createFaqEdge,
  deleteFaqEdge,
  deletePhrasing,
  getFaqEdges,
  listFaqs,
  listPhrasings,
  newIdempotencyKey,
  reorderFaqEdges,
  updateFaqEdge,
} from '../lib/helpdeskApi'
import { DEFAULT_FAQ_FILTERS, faqKeyFor, orderedSignals, toFaqBody, validateFaqDraft, type FaqDraft, type FaqKey } from '../lib/helpdeskFaqs'
import { errorMessage, faqSignalLabel } from '../lib/helpdeskFormat'
import {
  labelBody,
  labelDraftOf,
  labelLimits,
  moveItem,
  validateLabelDraft,
  validatePhrasing,
  type LabelDraft,
  type LabelError,
} from '../lib/helpdeskGraph'
import { isImeComposing } from '../lib/helpdeskView'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'

/**
 * FAQ 抽屉里的「追问与选项」（helpdesk-v5-faq-graph-design §5.1；没有 Figma 画板，沿用抽屉的字段、
 * 勾选框、按钮与提示样式，待视觉验收）：
 * - FaqNodeFields：卡片类型（answer / choice）、入口开关、学员情境多选。属于草稿，跟「Save FAQ」一起保存；
 * - FaqLinksEditor（只在编辑已有 FAQ 时）：子节点列表（拖动或上移 / 下移排序、改显示文字、移除）、
 *  「添加已有问题」（搜索）、「新建追问」（新建一条非入口的 FAQ 并连上）、学员的问法。这些改动立即写进
 *   工作副本，学员要等发布新版本后才看到。键盘：每个操作都是按钮；拖动有上移 / 下移按钮代替。
 */

const SEARCH_DELAY_MS = 300

type FieldsProps = {
  locale: Locale
  draft: Pick<FaqDraft, 'type' | 'entry' | 'signals'>
  onChange: (patch: Partial<Pick<FaqDraft, 'type' | 'entry' | 'signals'>>) => void
}

export function FaqNodeFields({ locale, draft, onChange }: FieldsProps) {
  const uid = useId()
  function toggleSignal(signal: FaqSignal, on: boolean) {
    const next = on ? [...draft.signals, signal] : draft.signals.filter((value) => value !== signal)
    onChange({ signals: orderedSignals(next) })
  }
  return (
    <>
      <fieldset className="hdGraphFieldset">
        <legend className="hdFieldLabel">{t(locale, 'helpDesk.graph.type')}</legend>
        <div className="hdGraphChoices">
          {FAQ_NODE_TYPES.map((type) => (
            <label key={type} className="hdCheck hdGraphCheck">
              <input
                type="radio"
                className="hdCheckInput hdGraphRadio"
                name={`${uid}-type`}
                value={type}
                checked={draft.type === type}
                aria-describedby={`${uid}-type-hint`}
                onChange={() => onChange({ type })}
              />
              <span>{t(locale, `helpDesk.graph.types.${type}`)}</span>
            </label>
          ))}
        </div>
        <p className="hdGraphHint" id={`${uid}-type-hint`}>
          {t(locale, `helpDesk.graph.typeHint.${draft.type}`)}
        </p>
      </fieldset>

      <div className="hdField">
        <label className="hdCheck hdGraphCheck">
          <input
            type="checkbox"
            className="hdCheckInput"
            checked={draft.entry}
            aria-describedby={`${uid}-entry-hint`}
            onChange={(event) => onChange({ entry: event.target.checked })}
          />
          <span>{t(locale, 'helpDesk.graph.entry')}</span>
        </label>
        <p className="hdGraphHint" id={`${uid}-entry-hint`}>
          {t(locale, 'helpDesk.graph.entryHint')}
        </p>
      </div>

      <fieldset className="hdGraphFieldset" aria-describedby={`${uid}-signals-hint`}>
        <legend className="hdFieldLabel">{t(locale, 'helpDesk.graph.signals')}</legend>
        <p className="hdGraphHint" id={`${uid}-signals-hint`}>
          {t(locale, 'helpDesk.graph.signalsHint')}
        </p>
        <div className="hdGraphChoices hdGraphSignals">
          {FAQ_SIGNALS.map((signal) => (
            <label key={signal} className="hdCheck hdGraphCheck">
              <input
                type="checkbox"
                className="hdCheckInput"
                checked={draft.signals.includes(signal)}
                onChange={(event) => toggleSignal(signal, event.target.checked)}
              />
              <span>{faqSignalLabel(locale, signal)}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </>
  )
}

/* ------------------------------ 子节点与问法（工作副本） ------------------------------ */

type Adding = null | 'existing' | 'new'
type NewDraft = { questionEn: string; answerEn: string; questionZh: string; answerZh: string }
const EMPTY_NEW: NewDraft = { questionEn: '', answerEn: '', questionZh: '', answerZh: '' }

function labelErrorText(locale: Locale, kind: FaqEdgeKind, error: LabelError): string {
  const max = labelLimits(kind)
  if (error === 'tooLongEn') return t(locale, 'helpDesk.graph.labelErrors.tooLongEn', { max: max.en })
  if (error === 'tooLongZh') return t(locale, 'helpDesk.graph.labelErrors.tooLongZh', { max: max.zh })
  return t(locale, 'helpDesk.graph.labelErrors.both')
}

export function FaqLinksEditor({ locale, faq }: { locale: Locale; faq: HelpdeskFaq }) {
  const uid = useId()
  const zh = locale === 'zh-CN'
  const kind: FaqEdgeKind = faq.type === 'choice' ? 'option' : 'follow_up'
  const max = kind === 'option' ? FAQ_GRAPH_LIMITS.optionsMax : FAQ_GRAPH_LIMITS.followUpsMax
  const [children, setChildren] = useState<FaqEdgeView[]>([])
  const [parents, setParents] = useState<FaqEdgeView[]>([])
  const [phrasings, setPhrasings] = useState<FaqPhrasing[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadFailed, setLoadFailed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ edgeId: string; draft: LabelDraft; error: LabelError | null } | null>(null)
  const [adding, setAdding] = useState<Adding>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<HelpdeskFaq[] | null>(null)
  const [newDraft, setNewDraft] = useState<NewDraft>(EMPTY_NEW)
  const [newSubmitted, setNewSubmitted] = useState(false)
  const [phrasingLocale, setPhrasingLocale] = useState<PhrasingLocale>(zh ? 'zh-CN' : 'en-GB')
  const [phrasingText, setPhrasingText] = useState('')
  const [phrasingError, setPhrasingError] = useState<'required' | 'tooLong' | null>(null)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  // 键盘 / 读屏用户：写操作卸掉了有焦点的控件时把焦点放到合适的位置，并用礼貌的 live region 读出结果
  const [announcement, setAnnouncement] = useState('')
  const pendingFocus = useRef<string | null>(null)
  const newKey = useRef<FaqKey | null>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchRequest = useRef(0)

  async function loadEdges() {
    const result = await getFaqEdges(faq.id)
    if (result.ok) {
      setChildren(result.data.children)
      setParents(result.data.parents)
    }
    return result
  }

  useEffect(() => {
    let live = true
    void Promise.all([getFaqEdges(faq.id), listPhrasings(faq.id)]).then(([edges, words]) => {
      if (!live) return
      if (edges.ok) {
        setChildren(edges.data.children)
        setParents(edges.data.parents)
      }
      if (words.ok) setPhrasings(words.data.phrasings)
      const failed = !edges.ok ? edges : !words.ok ? words : null
      setLoadFailed(failed && !failed.ok ? failed.code : null)
      setLoaded(true)
    })
    return () => {
      live = false
    }
  }, [faq.id])

  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    },
    [],
  )

  // 每次渲染后：有待放的焦点就放过去（目标在这次渲染里才出现，比如收起表单后的 Edit 按钮）
  useEffect(() => {
    const id = pendingFocus.current
    if (!id) return
    pendingFocus.current = null
    document.getElementById(id)?.focus()
  })

  function settle(focusId: string | null, message: string | null) {
    if (focusId) pendingFocus.current = focusId
    if (message !== null) setAnnouncement(message)
  }

  const keyIds = {
    addExisting: `${uid}-add-existing`,
    addNew: `${uid}-add-new`,
    children: `${uid}-children`,
    edit: (edgeId: string) => `${uid}-edit-${edgeId}`,
    up: (edgeId: string) => `${uid}-up-${edgeId}`,
    down: (edgeId: string) => `${uid}-down-${edgeId}`,
    phrasing: `${uid}-phrasing-input`,
  }

  /** 一个写操作：同一时间只跑一个；失败显示错误码的文案。 */
  async function act(work: () => Promise<{ ok: true } | { ok: false; code: string }>): Promise<boolean> {
    if (busy) return false
    setBusy(true)
    setErrorCode(null)
    const result = await work()
    setBusy(false)
    if (!result.ok) {
      setErrorCode(result.code)
      return false
    }
    return true
  }

  const labelOf = (view: FaqEdgeView) => (zh ? view.label.zh : view.label.en)

  async function reorder(from: number, to: number) {
    const ids = moveItem(
      children.map((view) => view.edge.childId),
      from,
      to,
    )
    if (ids.join() === children.map((view) => view.edge.childId).join()) return
    const moved = children[from]
    const ok = await act(async () => {
      const result = await reorderFaqEdges(faq.id, ids)
      if (result.ok) setChildren(result.data.children)
      else if (result.code === 'FAQ_CHILDREN_CHANGED') await loadEdges()
      return result
    })
    if (ok && moved) {
      // ↑ / ↓：焦点留在同一行同方向的按钮上（移到头了那个按钮会禁用，就换另一个）
      const edgeId = moved.edge.id
      const goingUp = to < from
      const blocked = goingUp ? to === 0 : to === ids.length - 1
      settle(
        goingUp !== blocked ? keyIds.up(edgeId) : keyIds.down(edgeId),
        t(locale, 'helpDesk.graph.announce.moved', { label: labelOf(moved), position: to + 1, count: ids.length }),
      )
    }
  }

  function onDrop(event: DragEvent, to: number) {
    event.preventDefault()
    const from = dragFrom
    setDragFrom(null)
    if (from !== null) void reorder(from, to)
  }

  async function saveLabel() {
    if (!editing) return
    const view = children.find((item) => item.edge.id === editing.edgeId)
    if (!view) return
    const error = validateLabelDraft(view.edge.kind, editing.draft)
    if (error) {
      setEditing({ ...editing, error })
      return
    }
    const ok = await act(async () => {
      const result = await updateFaqEdge(view.edge.id, labelBody(editing.draft))
      return result.ok ? loadEdges() : result
    })
    if (ok) {
      setEditing(null)
      settle(keyIds.edit(view.edge.id), t(locale, 'helpDesk.graph.announce.labelSaved'))
    }
  }

  function cancelLabel(edgeId: string) {
    setEditing(null)
    settle(keyIds.edit(edgeId), null)
  }

  async function remove(view: FaqEdgeView) {
    const ok = await act(async () => {
      const result = await deleteFaqEdge(view.edge.id)
      return result.ok ? loadEdges() : result
    })
    if (ok) settle(keyIds.children, t(locale, 'helpDesk.graph.announce.removed', { label: labelOf(view) }))
  }

  function search(value: string) {
    setQuery(value)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      searchTimer.current = null
      const id = ++searchRequest.current
      void listFaqs({ ...DEFAULT_FAQ_FILTERS, q: value.trim() }).then((result) => {
        if (id !== searchRequest.current) return
        setResults(result.ok ? result.data.faqs.filter((item) => item.id !== faq.id) : [])
        if (!result.ok) setErrorCode(result.code)
      })
    }, SEARCH_DELAY_MS)
  }

  function openAdding(next: Adding) {
    setAdding((current) => (current === next ? null : next))
    setErrorCode(null)
    if (next === 'existing' && results === null) search('')
  }

  async function link(childId: string, question: string) {
    const ok = await act(async () => {
      const result = await createFaqEdge(faq.id, { childId })
      return result.ok ? loadEdges() : result
    })
    if (ok) {
      setAdding(null)
      settle(keyIds.addExisting, t(locale, 'helpDesk.graph.announce.added', { label: question }))
    }
  }

  /** 新建追问：一条非入口的答案卡片（分类同父节点），再连到这张卡片下面。 */
  const newAsDraft: FaqDraft = {
    category: faq.category,
    popular: false,
    ...newDraft,
    keywords: '',
    type: 'answer',
    entry: false,
    signals: [],
  }
  const newErrors = newSubmitted ? validateFaqDraft(newAsDraft) : {}

  async function createAndLink() {
    setNewSubmitted(true)
    const found = validateFaqDraft(newAsDraft)
    const first = (['questionEn', 'answerEn', 'questionZh', 'answerZh'] as const).find((field) => found[field])
    if (first) {
      document.getElementById(`${uid}-new-${first}`)?.focus()
      return
    }
    const body = toFaqBody(newAsDraft)
    newKey.current = faqKeyFor(newKey.current, body, newIdempotencyKey)
    const key = newKey.current.key
    const ok = await act(async () => {
      const created = await createFaq(body, key)
      if (!created.ok) return created
      const linked = await createFaqEdge(faq.id, { childId: created.data.id })
      return linked.ok ? loadEdges() : linked
    })
    if (ok) {
      setAdding(null)
      settle(keyIds.addNew, t(locale, 'helpDesk.graph.announce.created', { label: zh ? newDraft.questionZh.trim() : newDraft.questionEn.trim() }))
      setNewDraft(EMPTY_NEW)
      setNewSubmitted(false)
      newKey.current = null
    }
  }

  async function submitPhrasing() {
    const error = validatePhrasing(phrasingText)
    setPhrasingError(error)
    if (error) return
    const ok = await act(async () => {
      const result = await addPhrasing(faq.id, { locale: phrasingLocale, text: phrasingText.trim().replace(/\s+/g, ' ') })
      if (!result.ok) return result
      const words = await listPhrasings(faq.id)
      if (words.ok) setPhrasings(words.data.phrasings)
      return words
    })
    if (ok) {
      setPhrasingText('')
      settle(keyIds.phrasing, t(locale, 'helpDesk.graph.announce.phrasingAdded'))
    }
  }

  async function removePhrasing(phrasing: FaqPhrasing) {
    const ok = await act(async () => {
      const result = await deletePhrasing(phrasing.id)
      if (result.ok) setPhrasings((current) => current.filter((item) => item.id !== phrasing.id))
      return result
    })
    if (ok) settle(keyIds.phrasing, t(locale, 'helpDesk.graph.announce.phrasingRemoved'))
  }

  const linkedIds = new Set(children.map((view) => view.edge.childId))
  const full = children.length >= max

  function newField(field: keyof NewDraft, key: string, multiline: boolean) {
    const id = `${uid}-new-${field}`
    const error = newErrors[field]
    const common = {
      id,
      value: newDraft[field],
      lang: field.endsWith('Zh') ? 'zh-CN' : undefined,
      'aria-invalid': Boolean(error),
      'aria-describedby': error ? `${id}-error` : undefined,
    }
    return (
      <div className="hdField">
        <label className="hdFieldLabel" htmlFor={id}>
          {t(locale, key)}
        </label>
        {multiline ? (
          <textarea
            {...common}
            className="hdTextarea hdGraphTextarea"
            onChange={(event) => setNewDraft((current) => ({ ...current, [field]: event.target.value }))}
          />
        ) : (
          <input
            {...common}
            className="hdDrawerInput hdDrawerInputSmall"
            onChange={(event) => setNewDraft((current) => ({ ...current, [field]: event.target.value }))}
          />
        )}
        {error ? (
          <p className="hdFieldError" id={`${id}-error`}>
            {error === 'tooLong' ? t(locale, 'helpDesk.drawer.errors.tooLong', { max: field.startsWith('answer') ? 4000 : 200 }) : t(locale, `helpDesk.drawer.errors.${error}`)}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <div className="hdGraphLinks" aria-busy={!loaded || busy}>
      <p className="hdSrOnly hdGraphAnnounce" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      {faq.key ? <p className="hdGraphHint hdGraphKey">{t(locale, 'helpDesk.graph.key', { key: faq.key })}</p> : null}
      {loadFailed ? <p className="hdGraphHint hdGraphProblem">{errorMessage(locale, loadFailed)}</p> : null}
      {errorCode ? (
        <div className="hdNotice hdDrawerNotice hdDrawerAlert" role="alert">
          {errorMessage(locale, errorCode)}
        </div>
      ) : null}

      {parents.length > 0 ? (
        <div className="hdField">
          <span className="hdFieldLabel">{t(locale, 'helpDesk.graph.parents')}</span>
          <ul className="hdGraphParents">
            {parents.map((view) => (
              <li key={view.edge.id}>{view.node ? (zh ? view.node.questionZh : view.node.questionEn) : view.edge.parentId}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="hdField">
        <span className="hdFieldLabel" id={keyIds.children} tabIndex={-1}>
          {kind === 'option'
            ? t(locale, 'helpDesk.graph.children.option', { min: FAQ_GRAPH_LIMITS.optionsMin, max })
            : t(locale, 'helpDesk.graph.children.follow_up', { max, shown: FAQ_GRAPH_LIMITS.followUpsShown })}
        </span>
        {loaded && children.length === 0 ? <p className="hdGraphHint">{t(locale, `helpDesk.graph.empty.${kind}`)}</p> : null}
        {children.length > 0 ? (
          <ol className="hdGraphChildren" aria-labelledby={`${uid}-children`}>
            {children.map((view, index) => {
              const label = labelOf(view)
              const custom = view.edge.labelEn !== null || view.edge.labelZh !== null
              const question = view.node ? (zh ? view.node.questionZh : view.node.questionEn) : ''
              const open = editing?.edgeId === view.edge.id
              return (
                <li
                  key={view.edge.id}
                  className={`hdGraphChild${dragFrom === index ? ' hdGraphChildDragging' : ''}`}
                  draggable={!busy && !open}
                  onDragStart={(event) => {
                    event.dataTransfer?.setData('text/plain', view.edge.id)
                    setDragFrom(index)
                  }}
                  onDragEnd={() => setDragFrom(null)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => onDrop(event, index)}
                >
                  <div className="hdGraphChildRow">
                    <span className="hdGraphGrip" aria-hidden="true" title={t(locale, 'helpDesk.graph.drag')}>
                      ⋮⋮
                    </span>
                    {kind === 'option' ? (
                      <span className="hdGraphLetter" aria-hidden="true">
                        {String.fromCharCode(65 + index)}
                      </span>
                    ) : null}
                    <div className="hdGraphChildText">
                      <span className="hdGraphChildLabel">{label}</span>
                      {custom && question && question !== label ? <span className="hdGraphHint">{question}</span> : null}
                      {custom ? <span className="hdGraphTag">{t(locale, 'helpDesk.graph.customLabel')}</span> : null}
                    </div>
                    <div className="hdGraphChildActions">
                      <button
                        id={keyIds.up(view.edge.id)}
                        type="button"
                        className="hdEditorTool"
                        aria-label={t(locale, 'helpDesk.graph.moveUp', { label })}
                        disabled={busy || index === 0}
                        onClick={() => void reorder(index, index - 1)}
                      >
                        ↑
                      </button>
                      <button
                        id={keyIds.down(view.edge.id)}
                        type="button"
                        className="hdEditorTool"
                        aria-label={t(locale, 'helpDesk.graph.moveDown', { label })}
                        disabled={busy || index === children.length - 1}
                        onClick={() => void reorder(index, index + 1)}
                      >
                        ↓
                      </button>
                      <button
                        id={keyIds.edit(view.edge.id)}
                        type="button"
                        className="hdLinkButton"
                        aria-label={t(locale, 'helpDesk.graph.editLabel', { label })}
                        aria-expanded={open}
                        disabled={busy}
                        onClick={() => setEditing(open ? null : { edgeId: view.edge.id, draft: labelDraftOf(view.edge), error: null })}
                      >
                        {t(locale, 'helpDesk.graph.editLabelShort')}
                      </button>
                      <button
                        type="button"
                        className="hdLinkButton hdLinkDanger"
                        aria-label={t(locale, 'helpDesk.graph.remove', { label })}
                        disabled={busy}
                        onClick={() => void remove(view)}
                      >
                        {t(locale, 'helpDesk.graph.removeShort')}
                      </button>
                    </div>
                  </div>
                  {open && editing ? (
                    <div className="hdGraphLabelForm">
                      {(['en', 'zh'] as const).map((language) => (
                        <div className="hdField" key={language}>
                          <label className="hdFieldLabel" htmlFor={`${uid}-label-${language}`}>
                            {t(locale, language === 'en' ? 'helpDesk.graph.labelEn' : 'helpDesk.graph.labelZh')}
                          </label>
                          <input
                            id={`${uid}-label-${language}`}
                            className="hdDrawerInput hdDrawerInputSmall"
                            lang={language === 'zh' ? 'zh-CN' : undefined}
                            value={editing.draft[language]}
                            placeholder={view.node ? (language === 'zh' ? view.node.questionZh : view.node.questionEn) : ''}
                            aria-invalid={Boolean(editing.error)}
                            aria-describedby={editing.error ? `${uid}-label-error` : `${uid}-label-hint`}
                            onChange={(event) =>
                              setEditing({ ...editing, draft: { ...editing.draft, [language]: event.target.value }, error: null })
                            }
                          />
                        </div>
                      ))}
                      <p className="hdGraphHint" id={`${uid}-label-hint`}>
                        {t(locale, 'helpDesk.graph.labelHint')}
                      </p>
                      {editing.error ? (
                        <p className="hdFieldError" id={`${uid}-label-error`}>
                          {labelErrorText(locale, view.edge.kind, editing.error)}
                        </p>
                      ) : null}
                      <div className="hdGraphFormActions">
                        <button type="button" className="hdDrawerButton" onClick={() => cancelLabel(view.edge.id)}>
                          {t(locale, 'helpDesk.graph.cancel')}
                        </button>
                        <button type="button" className="hdDrawerButton hdDrawerPrimary" disabled={busy} onClick={() => void saveLabel()}>
                          {t(locale, 'helpDesk.graph.saveLabel')}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ol>
        ) : null}
        {full ? <p className="hdGraphHint">{t(locale, 'helpDesk.graph.full', { max })}</p> : null}
        <div className="hdGraphFormActions hdGraphAddRow">
          <button
            id={keyIds.addExisting}
            type="button"
            className="hdDrawerButton"
            aria-expanded={adding === 'existing'}
            disabled={!loaded || full}
            onClick={() => openAdding('existing')}
          >
            {t(locale, 'helpDesk.graph.addExisting')}
          </button>
          <button
            id={keyIds.addNew}
            type="button"
            className="hdDrawerButton"
            aria-expanded={adding === 'new'}
            disabled={!loaded || full}
            onClick={() => openAdding('new')}
          >
            {t(locale, kind === 'option' ? 'helpDesk.graph.addNewOption' : 'helpDesk.graph.addNew')}
          </button>
        </div>

        {adding === 'existing' && !full ? (
          <div className="hdGraphPanel">
            <input
              type="search"
              className="hdDrawerInput hdDrawerInputSmall"
              value={query}
              autoFocus
              aria-label={t(locale, 'helpDesk.graph.search')}
              placeholder={t(locale, 'helpDesk.graph.search')}
              onChange={(event) => search(event.target.value)}
            />
            {results && results.length === 0 ? <p className="hdGraphHint">{t(locale, 'helpDesk.graph.searchEmpty')}</p> : null}
            {results && results.length > 0 ? (
              <ul className="hdGraphResults">
                {results.map((item) => {
                  const question = zh ? item.questionZh : item.questionEn
                  const linked = linkedIds.has(item.id)
                  return (
                    <li key={item.id} className="hdGraphResult">
                      <span className="hdGraphChildLabel">{question}</span>
                      {item.type === 'choice' ? <span className="hdGraphTag">{t(locale, 'helpDesk.tree.types.choice')}</span> : null}
                      {linked ? (
                        <span className="hdGraphHint">{t(locale, 'helpDesk.graph.linked')}</span>
                      ) : (
                        <button
                          type="button"
                          className="hdLinkButton"
                          aria-label={t(locale, 'helpDesk.graph.pick', { question })}
                          disabled={busy}
                          onClick={() => void link(item.id, question)}
                        >
                          {t(locale, 'helpDesk.graph.pickShort')}
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            ) : null}
          </div>
        ) : null}

        {adding === 'new' && !full ? (
          <div className="hdGraphPanel">
            <p className="hdGraphHint">{t(locale, 'helpDesk.graph.newFollowUpHint')}</p>
            {newField('questionEn', 'helpDesk.drawer.questionEn', false)}
            {newField('answerEn', 'helpDesk.drawer.answerEn', true)}
            {newField('questionZh', 'helpDesk.drawer.questionZh', false)}
            {newField('answerZh', 'helpDesk.drawer.answerZh', true)}
            <div className="hdGraphFormActions">
              <button
                type="button"
                className="hdDrawerButton"
                onClick={() => {
                  setAdding(null)
                  settle(keyIds.addNew, null)
                }}
              >
                {t(locale, 'helpDesk.graph.cancel')}
              </button>
              <button type="button" className="hdDrawerButton hdDrawerPrimary" disabled={busy} onClick={() => void createAndLink()}>
                {t(locale, busy ? 'helpDesk.graph.working' : 'helpDesk.graph.createAndLink')}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="hdField">
        <span className="hdFieldLabel" id={`${uid}-phrasings`}>
          {t(locale, 'helpDesk.graph.phrasings')}
        </span>
        <p className="hdGraphHint">{t(locale, 'helpDesk.graph.phrasingsHint')}</p>
        {loaded && phrasings.length === 0 ? <p className="hdGraphHint">{t(locale, 'helpDesk.graph.phrasingsEmpty')}</p> : null}
        {phrasings.length > 0 ? (
          <ul className="hdGraphPhrasings" aria-labelledby={`${uid}-phrasings`}>
            {phrasings.map((phrasing) => (
              <li key={phrasing.id} className="hdGraphPhrasing">
                <span className="hdGraphTag">{t(locale, `helpDesk.graph.phrasingLocales.${phrasing.locale}`)}</span>
                <span className="hdGraphChildLabel" lang={phrasing.locale}>
                  {phrasing.text}
                </span>
                {phrasing.source !== 'staff' ? (
                  <span className="hdGraphHint">{t(locale, `helpDesk.graph.phrasingSources.${phrasing.source}`)}</span>
                ) : null}
                <button
                  type="button"
                  className="hdLinkButton hdLinkDanger"
                  aria-label={t(locale, 'helpDesk.graph.removePhrasing', { text: phrasing.text })}
                  disabled={busy}
                  onClick={() => void removePhrasing(phrasing)}
                >
                  {t(locale, 'helpDesk.graph.removeShort')}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="hdGraphPhrasingAdd">
          <select
            className="hdDrawerSelect hdGraphLocale"
            aria-label={t(locale, 'helpDesk.graph.phrasingLocale')}
            value={phrasingLocale}
            onChange={(event) => setPhrasingLocale(event.target.value as PhrasingLocale)}
          >
            {PHRASING_LOCALES.map((value) => (
              <option key={value} value={value}>
                {t(locale, `helpDesk.graph.phrasingLocales.${value}`)}
              </option>
            ))}
          </select>
          <input
            id={keyIds.phrasing}
            className="hdDrawerInput hdDrawerInputSmall"
            value={phrasingText}
            lang={phrasingLocale}
            aria-label={t(locale, 'helpDesk.graph.phrasingText')}
            placeholder={t(locale, 'helpDesk.graph.phrasingPlaceholder')}
            aria-invalid={Boolean(phrasingError)}
            aria-describedby={phrasingError ? `${uid}-phrasing-error` : undefined}
            onChange={(event) => {
              setPhrasingText(event.target.value)
              setPhrasingError(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !isImeComposing(event)) {
                event.preventDefault()
                void submitPhrasing()
              }
            }}
          />
          <button
            type="button"
            className="hdDrawerButton"
            disabled={busy || !loaded || phrasings.length >= FAQ_GRAPH_LIMITS.phrasingsMax}
            onClick={() => void submitPhrasing()}
          >
            {t(locale, 'helpDesk.graph.addPhrasing')}
          </button>
        </div>
        {phrasingError ? (
          <p className="hdFieldError" id={`${uid}-phrasing-error`}>
            {t(locale, `helpDesk.graph.phrasingErrors.${phrasingError}`, { max: FAQ_GRAPH_LIMITS.phrasingMax })}
          </p>
        ) : null}
      </div>
    </div>
  )
}
