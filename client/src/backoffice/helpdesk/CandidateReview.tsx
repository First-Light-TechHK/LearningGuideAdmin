import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import {
  CANDIDATE_LIMITS,
  DISMISS_REASONS,
  FAQ_CATEGORIES,
  type AcceptCandidateBody,
  type CandidateDetail,
  type CandidateReview as ReviewData,
  type DismissReason,
  type FaqCandidate,
  type FaqCategory,
  type FaqMap,
  type HelpdeskFaq,
  type ReviewSimilar,
} from '../contracts/helpdesk'
import {
  acceptCandidate,
  createFaq,
  dismissCandidate,
  getCandidate,
  getCandidateDraft,
  getCandidateReview,
  getFaq,
  mergeCandidate,
  newIdempotencyKey,
  updateFaq,
} from '../lib/helpdeskApi'
import {
  FAQ_LIMITS,
  draftFromFaq,
  faqKeyFor,
  isDraftDirty,
  toFaqBody,
  validateFaqDraft,
  type FaqDraft,
  type FaqField,
  type FaqKey,
} from '../lib/helpdeskFaqs'
import {
  canDecide,
  cleanExampleIndexes,
  decisionKey,
  faqDraftFromCandidate,
  hasPlaceholder,
  textSegments,
  type DecisionKey,
} from '../lib/helpdeskFlywheel'
import { errorMessage, faqCategoryLabel } from '../lib/helpdeskFormat'
import {
  REVIEW_GROUPS,
  GROUP_ACTIONS,
  choiceProblems,
  defaultChoice,
  needsTarget,
  nextInQueue,
  orderSimilar,
  pathText,
  placeMode,
  scorePercent,
  stateShares,
  switchAction,
  usesPhrasings,
  type ReviewAction,
  type ReviewChoice,
} from '../lib/helpdeskReview'
import { longDate } from '../lib/helpdeskView'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import type { Compose } from './CandidateDrawer'
import { FaqPicker } from './FaqPicker'
import { PlaceChips, PlaceTreePanel } from './PlacePicker'

/**
 * 「FAQ 候选」Tab 的卡片审核视图（?tab=candidates&view=cards，选中 &review=<id>）。
 * owner 2026-10-31：一屏放下、看得懂、运营直接改内容（AI 只给初稿和建议，不是让人在 AI 的几个答案里抽）。
 * 三栏，各自滚动，按钮固定在底部：
 * - 左：队列（J / K 或上下键切换）。
 * - 中：这个候选是什么（用户在问什么、提问次数、提问的用户、预计效果、AI 建议一句话），
 *   下面分页签看证据：用户怎么问的 / 相似的卡 / 提问的用户。
 * - 右：处理方式（一个下拉框，缺省是 AI 建议）+ 卡片内容（新卡、追问、改卡时就是可编辑的问题和答案）+ 放在哪；
 *   底部「保存并批准」一步完成：先存卡（编辑区），再接受候选（带位置）。
 * 没有 Figma：沿用 HelpDesk 的颜色、字号、标签和按钮，待视觉验收。写操作只给 FULL 且只对待处理的候选。
 */

type Mode = 'decide' | 'reject' | 'merge' | 'confirmRetire'
type Tab = 'said' | 'similar' | 'users'
type Lang = 'zh' | 'en'
type Alert = { tone: 'alert' | 'status'; text: string } | null

/** 编辑区：新卡 / 追问用候选的预填，改卡用那张卡当前的内容。 */
type Editor = { source: string; draft: FaqDraft; original: FaqDraft; base: HelpdeskFaq | null; sources: string[] }

const EDITS: ReviewAction[] = ['new_faq', 'follow_up', 'update_faq']

function Example({ text, locale }: { text: string; locale: Locale }) {
  return (
    <>
      {textSegments(text).map((segment, index) =>
        segment.placeholder ? (
          <mark key={index} className="hdPlaceholder">
            {segment.text}
          </mark>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
      {hasPlaceholder(text) ? (
        <>
          {' '}
          <span className="hdSrOnly">{t(locale, 'helpDesk.candidates.hiddenDetail')}</span>
        </>
      ) : null}
    </>
  )
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

/* ---------------------------------- 队列 ---------------------------------- */

type ReviewProps = {
  locale: Locale
  canWrite: boolean
  rows: readonly FaqCandidate[]
  total: number
  loading: boolean
  selectedId: string | null
  map: FaqMap | null
  mapError: string | null
  onSelect: (id: string, replace?: boolean) => void
  onChanged: () => void
  onCompose: (compose: Compose) => void
}

export function CandidateReview({
  locale,
  canWrite,
  rows,
  total,
  loading,
  selectedId,
  map,
  mapError,
  onSelect,
  onChanged,
  onCompose,
}: ReviewProps) {
  const current = selectedId ?? rows[0]?.id ?? null
  const ids = rows.map((row) => row.id)
  const [flash, setFlash] = useState<{ text: string; at: number } | null>(null)
  const queueRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!flash) return
    const timer = setTimeout(() => setFlash(null), 5000)
    return () => clearTimeout(timer)
  }, [flash])

  // J / K 切换（不在输入框里、没有弹层时）
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      if (event.key !== 'j' && event.key !== 'k') return
      const at = current ? ids.indexOf(current) : -1
      const next = ids[event.key === 'j' ? at + 1 : at - 1]
      if (next) onSelect(next, true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, ids, onSelect])

  function onQueueKey(event: ReactKeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const at = current ? ids.indexOf(current) : -1
    const next = ids[event.key === 'ArrowDown' ? at + 1 : at - 1]
    if (!next) return
    onSelect(next, true)
    requestAnimationFrame(() => queueRef.current?.querySelector<HTMLButtonElement>(`[data-id="${next}"]`)?.focus())
  }

  return (
    <div className="hdReviewLayout">
      {flash ? (
        <div className="hdReviewToast" role="status" key={flash.at}>
          {flash.text}
        </div>
      ) : null}
      <nav ref={queueRef} className="hdReviewQueue" aria-label={t(locale, 'helpDesk.review.queue')} aria-busy={loading}>
        <p className="hdReviewQueueHead">
          <span>{t(locale, 'helpDesk.review.queueCount', { count: total })}</span>
          <span className="hdReviewKeys">{t(locale, 'helpDesk.review.keys')}</span>
        </p>
        <ul className="hdReviewQueueList" onKeyDown={onQueueKey}>
          {rows.map((row) => {
            const on = row.id === current
            return (
              <li key={row.id}>
                <button
                  type="button"
                  data-id={row.id}
                  className={`hdReviewQueueCard${on ? ' hdReviewQueueCardOn' : ''}`}
                  aria-current={on ? 'true' : undefined}
                  onClick={() => onSelect(row.id)}
                >
                  <span className="hdReviewQueueTopic">{row.topic}</span>
                  <span className="hdReviewQueueQuestion">{row.proposedQuestion}</span>
                  <span className="hdReviewQueueMeta">
                    <span className={`hdReviewQueueTag hdCandidateSuggestion-${row.suggestion}`}>
                      {t(locale, `helpDesk.review.short.${row.suggestion}`)}
                    </span>
                    <span>{t(locale, 'helpDesk.review.asks', { count: row.turnCount })}</span>
                    {row.status !== 'new' ? <span>{t(locale, `helpDesk.candidates.status.${row.status}`)}</span> : null}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

      {current ? (
        <ReviewWorkspace
          key={current}
          locale={locale}
          candidateId={current}
          canWrite={canWrite}
          map={map}
          mapError={mapError}
          mergeTargets={rows.filter((row) => row.status === 'new' && row.id !== current)}
          onDecided={(message) => {
            setFlash({ text: message, at: Date.now() })
            const next = nextInQueue(ids, current)
            onChanged()
            if (next && next !== current) onSelect(next, true)
          }}
          onCompose={onCompose}
          onOpen={onSelect}
        />
      ) : (
        <div className="hdReviewEmpty">{t(locale, loading ? 'helpDesk.candidates.loading' : 'helpDesk.review.pickOne')}</div>
      )}
    </div>
  )
}

/* ---------------------------------- 一张候选的审核 ---------------------------------- */

type WorkspaceProps = {
  locale: Locale
  candidateId: string
  canWrite: boolean
  map: FaqMap | null
  mapError: string | null
  mergeTargets: readonly FaqCandidate[]
  /** 决定成功：提示交给队列（这一条会换成下一条）。 */
  onDecided: (message: string) => void
  /** 「在完整编辑器里打开」：交给页面的 FAQ 抽屉（关键词、情境、追问等全部字段）。 */
  onCompose: (compose: Compose) => void
  onOpen: (id: string) => void
}

function ReviewWorkspace({ locale, candidateId, canWrite, map, mapError, mergeTargets, onDecided, onCompose, onOpen }: WorkspaceProps) {
  const uid = useId()
  const zh = locale === 'zh-CN'
  const [detail, setDetail] = useState<CandidateDetail | null>(null)
  const [review, setReview] = useState<ReviewData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [choice, setChoice] = useState<ReviewChoice | null>(null)
  const [mode, setMode] = useState<Mode>('decide')
  const [tab, setTab] = useState<Tab>('said')
  const [lang, setLang] = useState<Lang>(zh ? 'zh' : 'en')
  const [editors, setEditors] = useState<Record<string, Editor>>({})
  const [editorError, setEditorError] = useState<string | null>(null)
  const [treeOpen, setTreeOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [alert, setAlert] = useState<Alert>(null)
  const [note, setNote] = useState('')
  const [reason, setReason] = useState<DismissReason | ''>('')
  const [mergeInto, setMergeInto] = useState('')
  const [names, setNames] = useState<Record<string, { en: string; zh: string }>>({})
  const [created, setCreated] = useState<string | null>(null)
  const keyRef = useRef<DecisionKey | null>(null)
  const faqKeyRef = useRef<FaqKey | null>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  async function load(first: boolean) {
    const [one, data] = await Promise.all([getCandidate(candidateId), getCandidateReview(candidateId)])
    if (!mounted.current) return
    if (one.ok) {
      setDetail(one.data)
      setLoadError(null)
    } else setLoadError(one.code)
    if (data.ok) {
      setReview(data.data)
      setReviewError(null)
    } else setReviewError(data.code)
    if (first && one.ok)
      setChoice(defaultChoice(one.data.candidate, data.ok ? data.data : null, cleanExampleIndexes(one.data.candidate.examples)))
  }

  useEffect(() => {
    void load(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateId])

  const action = choice?.action ?? detail?.candidate.suggestion ?? 'new_faq'
  const target = choice?.target ?? null
  /** 卡片内容来自哪：候选预填（新卡、追问），或目标卡（改卡、加说法、下线时只读）。 */
  const source = action === 'new_faq' || action === 'follow_up' ? 'draft' : target && action !== 'no_change' ? `faq:${target}` : null
  const editor = source ? (editors[source] ?? null) : null

  useEffect(() => {
    if (!source || editors[source] || !detail) return
    let live = true
    setEditorError(null)
    const done = (next: Editor) => live && setEditors((all) => ({ ...all, [next.source]: next }))
    if (source === 'draft')
      void getCandidateDraft(candidateId).then((result) => {
        if (!result.ok) return live && setEditorError(result.code)
        const draft = faqDraftFromCandidate(result.data, 'new_faq')
        done({ source, draft, original: draft, base: null, sources: result.data.answerDraft?.sources ?? [] })
      })
    else
      void getFaq(source.slice(4)).then((result) => {
        if (!result.ok) return live && setEditorError(result.code)
        const draft = draftFromFaq(result.data)
        done({ source, draft, original: draft, base: result.data, sources: [] })
        if (live) setNames((all) => ({ ...all, [result.data.id]: { en: result.data.questionEn, zh: result.data.questionZh } }))
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, detail !== null])

  const similar = orderSimilar(review?.similar ?? [])
  const mapNodes = map?.nodes ?? []
  const mapHasNodes = mapNodes.length > 0

  function cardName(id: string | null): string | null {
    if (!id) return null
    const hit = similar.find((card) => card.faqId === id)
    if (hit) return zh ? hit.questionZh : hit.questionEn
    const node = detail?.nodes.find((n) => n.id === id)
    if (node) return zh ? node.questionZh : node.questionEn
    const named = names[id]
    return named ? (zh ? named.zh : named.en) : null
  }

  function update(patch: Partial<ReviewChoice>) {
    setChoice((current) => (current ? { ...current, ...patch } : current))
    setAlert(null)
    if (mode === 'confirmRetire') setMode('decide')
  }

  function pickAction(next: ReviewAction) {
    setChoice((current) => (current ? switchAction(current, next, review?.recommendation.faqId ?? null) : current))
    setSubmitted(false)
    setAlert(null)
    setMode('decide')
  }

  function edit(field: FaqField, value: string) {
    if (!editor) return
    setEditors((all) => ({ ...all, [editor.source]: { ...editor, draft: { ...editor.draft, [field]: value } } }))
  }

  /** 一个决定（接受、驳回、合并）：重试沿用 key；别人先改了 → 重新载入并提示；成功 → 交给队列。 */
  async function decideWith<T>(
    body: unknown,
    send: (key: string) => Promise<{ ok: true; data: T } | { ok: false; code: string; status: number }>,
    success: string,
  ): Promise<boolean> {
    keyRef.current = decisionKey(keyRef.current, body, newIdempotencyKey)
    const result = await send(keyRef.current.key)
    if (!mounted.current) return false
    if (result.ok) {
      keyRef.current = null
      onDecided(success)
      return true
    }
    if (result.code === 'CANDIDATE_CHANGED' || result.code === 'CANDIDATE_NOT_FOUND') await load(false)
    setAlert({ tone: 'alert', text: errorMessage(locale, result.code) })
    return false
  }

  const cleanNote = note.trim().replace(/\s+/g, ' ')
  const noteTooLong = [...cleanNote].length > CANDIDATE_LIMITS.noteMax
  const editing = EDITS.includes(action)
  const draftErrors = editing && editor ? validateFaqDraft(editor.draft) : {}
  const unchanged = action === 'update_faq' && editor !== null && !isDraftDirty(editor.draft, editor.original)

  async function run(work: () => Promise<unknown>) {
    if (busy) return
    setBusy(true)
    setAlert(null)
    try {
      await work()
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  function approve(candidate: FaqCandidate, current: ReviewChoice) {
    setSubmitted(true)
    const problems = choiceProblems(current, mapHasNodes)
    if (problems.length > 0 || noteTooLong) return
    if (editing && (!editor || Object.keys(draftErrors).length > 0 || unchanged)) {
      const first = (Object.keys(draftErrors) as FaqField[])[0]
      if (first === 'answerEn' || first === 'questionEn') setLang('en')
      else if (first === 'answerZh' || first === 'questionZh') setLang('zh')
      return
    }
    const placementNodeId = current.place ?? undefined
    void run(async () => {
      switch (current.action) {
        case 'no_change': {
          const body = { reason: 'not_a_gap' as const, ...(cleanNote ? { note: cleanNote } : {}), version: candidate.version }
          return decideWith(body, (key) => dismissCandidate(candidate.id, body, key), t(locale, 'helpDesk.review.done.no_change'))
        }
        case 'add_phrasing': {
          const body: AcceptCandidateBody = {
            as: 'add_phrasing',
            faqId: current.target as string,
            phrasings: current.picks,
            version: candidate.version,
          }
          return decideWith(body, (key) => acceptCandidate(candidate.id, body, key), t(locale, 'helpDesk.review.done.add_phrasing'))
        }
        case 'retire_faq': {
          if (mode !== 'confirmRetire') return setMode('confirmRetire')
          const body: AcceptCandidateBody = {
            as: 'retire_faq',
            faqId: current.target as string,
            version: candidate.version,
            ...(current.moveTo ? { moveTo: current.moveTo } : {}),
            ...(cleanNote ? { note: cleanNote } : {}),
          }
          return decideWith(body, (key) => acceptCandidate(candidate.id, body, key), t(locale, 'helpDesk.review.done.retire_faq'))
        }
        case 'update_faq': {
          const draft = (editor as Editor).draft
          const base = (editor as Editor).base as HelpdeskFaq
          const saved = await updateFaq(base.id, { ...toFaqBody(draft), version: base.version })
          if (!mounted.current) return
          if (!saved.ok) {
            if (saved.status === 409) {
              const latest = await getFaq(base.id)
              if (latest.ok && mounted.current)
                setEditors((all) => ({
                  ...all,
                  [(editor as Editor).source]: { ...(editor as Editor), base: latest.data, original: draftFromFaq(latest.data) },
                }))
            }
            return setAlert({ tone: 'alert', text: errorMessage(locale, saved.code) })
          }
          setEditors((all) => ({ ...all, [(editor as Editor).source]: { ...(editor as Editor), base: saved.data, original: draft } }))
          const body: AcceptCandidateBody = {
            as: 'update_faq',
            faqId: base.id,
            phrasings: current.picks,
            version: candidate.version,
            ...(placementNodeId ? { placementNodeId } : {}),
          }
          return decideWith(body, (key) => acceptCandidate(candidate.id, body, key), t(locale, 'helpDesk.review.done.update_faq'))
        }
        case 'new_faq':
        case 'follow_up': {
          let faqId = created
          if (!faqId) {
            const body = toFaqBody({ ...(editor as Editor).draft, type: 'answer', entry: current.action !== 'follow_up' })
            faqKeyRef.current = faqKeyFor(faqKeyRef.current, body, newIdempotencyKey)
            const saved = await createFaq(body, faqKeyRef.current.key)
            if (!mounted.current) return
            if (!saved.ok) return setAlert({ tone: 'alert', text: errorMessage(locale, saved.code) })
            faqId = saved.data.id
            // 卡已经存进编辑区：接受失败时重试只接受，不再建第二张
            setCreated(faqId)
          }
          const body: AcceptCandidateBody = {
            as: current.action,
            faqId,
            ...(current.action === 'follow_up' ? { parentId: current.target } : {}),
            phrasings: current.picks,
            version: candidate.version,
            ...(placementNodeId ? { placementNodeId } : {}),
          }
          const ok = await decideWith(
            body,
            (key) => acceptCandidate(candidate.id, body, key),
            t(locale, `helpDesk.review.done.${current.action}`),
          )
          if (!ok && mounted.current)
            setAlert((now) => ({ tone: 'alert', text: `${t(locale, 'helpDesk.review.savedNotAccepted')} ${now?.text ?? ''}`.trim() }))
          return
        }
      }
    })
  }

  function reject(candidate: FaqCandidate) {
    setSubmitted(true)
    if (!reason || (reason === 'other' && cleanNote === '') || noteTooLong) return
    const body = { reason, ...(cleanNote ? { note: cleanNote } : {}), version: candidate.version }
    void run(() => decideWith(body, (key) => dismissCandidate(candidate.id, body, key), t(locale, 'helpDesk.review.done.rejected')))
  }

  function merge(candidate: FaqCandidate) {
    setSubmitted(true)
    if (!mergeInto) return
    const body = { targetId: mergeInto, version: candidate.version }
    void run(() => decideWith(body, (key) => mergeCandidate(candidate.id, body, key), t(locale, 'helpDesk.review.done.merged')))
  }

  function openFullEditor(candidate: FaqCandidate, current: ReviewChoice) {
    if (!editor) return
    onCompose({
      candidate,
      as: current.action === 'update_faq' ? 'update_faq' : current.action === 'follow_up' ? 'follow_up' : 'new_faq',
      faq: editor.base ?? undefined,
      initial: editor.base ? undefined : { ...editor.draft, entry: current.action !== 'follow_up' },
      parentId: current.action === 'follow_up' ? current.target : null,
      phrasings: current.picks,
      version: candidate.version,
      draftSources: editor.sources,
      placementNodeId: current.place,
    })
  }

  if (!detail)
    return (
      <div className="hdReviewPanel" aria-busy={!loadError}>
        <div className="hdReviewEmptyPanel">
          {loadError ? (
            <p className="hdFieldError" role="alert">
              {errorMessage(locale, loadError)}
            </p>
          ) : (
            <p className="hdGraphHint">{t(locale, 'helpDesk.candidates.loading')}</p>
          )}
        </div>
      </div>
    )

  const { candidate } = detail
  const decidable = canDecide(candidate, canWrite) && choice !== null
  const recommended = review?.recommendation.action ?? candidate.suggestion
  const recommendedTarget = review?.recommendation.faqId ?? null
  const problems = submitted && choice ? choiceProblems(choice, mapHasNodes) : []
  const shownIds = new Set((review?.handling ?? []).map((h) => h.shownFaqId).filter((id): id is string => id !== null))
  const rationale = review
    ? ((zh ? review.recommendation.rationaleZh : review.recommendation.rationaleEn) ?? review.recommendation.rationale)
    : null
  const picking = decidable && usesPhrasings(action)
  const targetPick = decidable && needsTarget(action)
  const placeShown = choice ? placeMode(action, mapHasNodes) : 'hidden'
  const states = review?.userStates ?? null
  const shares = states ? stateShares(states.buckets, states.total) : []
  const net = review?.netValue ?? null

  const sentence = (value: ReviewAction, cardId: string | null) =>
    t(locale, `helpDesk.review.say.${value}`, {
      card: cardName(cardId) ?? t(locale, 'helpDesk.review.aCard'),
      count: choice?.picks.length ?? 0,
    })

  /* ---------------- 中栏：这个候选是什么 + 证据 ---------------- */

  const summary = (
    <header className="hdReviewSummary">
      <div className="hdReviewTitleRow">
        <h3 className="hdReviewTopic" id={`${uid}-topic`}>
          {candidate.topic}
        </h3>
        {candidate.status !== 'new' ? (
          <span className={`hdFaqChip hdCandidateStatus hdCandidateStatus-${candidate.status}`}>
            {t(locale, `helpDesk.candidates.status.${candidate.status}`)}
          </span>
        ) : null}
        <span className="hdGraphTag">{t(locale, `helpDesk.candidates.origin.${candidate.origin}`)}</span>
        {candidate.category ? <span className="hdGraphTag">{faqCategoryLabel(locale, candidate.category)}</span> : null}
      </div>
      <p className="hdReviewAsking">
        <span className="hdReviewMuted">{t(locale, 'helpDesk.review.userAsks')}</span>
        {candidate.proposedQuestion}
      </p>
      <dl className="hdReviewFacts">
        <div>
          <dt>{t(locale, 'helpDesk.review.facts.asks')}</dt>
          <dd>
            <strong>{candidate.turnCount}</strong>
            <span>{t(locale, 'helpDesk.review.lastSeen', { when: longDate(candidate.lastSeenAt, locale) })}</span>
          </dd>
        </div>
        <div>
          <dt>{t(locale, 'helpDesk.review.facts.users')}</dt>
          <dd>
            {states && shares.length > 0 ? (
              <button
                type="button"
                className="hdReviewFactLink"
                onClick={() => setTab('users')}
                title={t(locale, 'helpDesk.review.facts.usersMore')}
              >
                <span className="hdReviewStack hdReviewStackMini" aria-hidden="true">
                  {shares.map((share) => (
                    <span key={share.bucket} className={`hdReviewState-${share.bucket}`} style={{ width: `${share.percent}%` }} />
                  ))}
                </span>
                <span>
                  {shares
                    .slice(0, 2)
                    .map((share) => `${t(locale, `helpDesk.review.states.bucket.${share.bucket}`)} ${share.percent}%`)
                    .join(' · ')}
                </span>
              </button>
            ) : (
              <span className="hdReviewMuted">{t(locale, 'helpDesk.review.notYet')}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>{t(locale, 'helpDesk.review.facts.net')}</dt>
          <dd>
            {net ? (
              <>
                <strong className={net.net < 0 ? 'hdReviewNegative' : net.net > 0 ? 'hdReviewPositive' : undefined}>
                  {net.net > 0 ? `+${net.net}` : net.net < 0 ? `−${Math.abs(net.net)}` : '0'}
                </strong>
                <span>{t(locale, 'helpDesk.review.facts.netParts', { gains: net.gains, steals: net.steals })}</span>
              </>
            ) : (
              <span className="hdReviewMuted">{t(locale, 'helpDesk.review.notYet')}</span>
            )}
          </dd>
        </div>
      </dl>
      <div className="hdReviewAdvice">
        <span className="hdGraphTag hdReviewTagBlue">{t(locale, 'helpDesk.review.aiTag')}</span>
        <div>
          <p className="hdReviewAdviceText">{sentence(recommended, recommendedTarget ?? candidate.relatedNodeId)}</p>
          {rationale ? <p className="hdReviewAdviceWhy">{rationale}</p> : null}
        </div>
      </div>
    </header>
  )

  const saidPanel = (
    <>
      <p className="hdGraphHint" id={`${uid}-said-hint`}>
        {t(locale, picking ? 'helpDesk.review.saidPickHint' : 'helpDesk.review.saidHint')}
      </p>
      <ul className="hdReviewRows">
        {candidate.examples.map((example, index) => {
          const handled = review?.handling.find((h) => h.exampleIndex === index)
          const outcome = handled?.outcome ?? example.reasons[0] ?? null
          const shown = handled?.shownFaqId ?? null
          const text = <Example text={example.text} locale={locale} />
          return (
            <li key={`${index}-${example.turnId ?? ''}`} className="hdReviewRow">
              <div className="hdReviewSaidText" lang={example.locale}>
                {picking ? (
                  <label className="hdReviewCheck">
                    <input
                      type="checkbox"
                      className="hdCheckInput"
                      checked={choice?.picks.includes(index) ?? false}
                      disabled={busy || hasPlaceholder(example.text)}
                      aria-describedby={`${uid}-said-hint`}
                      onChange={(event) =>
                        update({
                          picks: event.target.checked
                            ? [...(choice?.picks ?? []), index].sort((a, b) => a - b)
                            : (choice?.picks ?? []).filter((value) => value !== index),
                        })
                      }
                    />
                    <span>“{text}”</span>
                  </label>
                ) : (
                  <span>“{text}”</span>
                )}
              </div>
              <div className="hdReviewRowMeta">
                <span className="hdGraphTag">{t(locale, `helpDesk.review.locale.${example.locale}`)}</span>
                {outcome ? <span className="hdGraphTag hdReviewTagAmber">{t(locale, `helpDesk.candidates.mix.${outcome}`)}</span> : null}
                <span>
                  {shown
                    ? t(locale, 'helpDesk.review.shownCard', { question: cardName(shown) ?? t(locale, 'helpDesk.review.unknownCard') })
                    : t(locale, 'helpDesk.review.noCardShown')}
                </span>
              </div>
            </li>
          )
        })}
      </ul>
      {submitted && action === 'add_phrasing' && (choice?.picks.length ?? 0) === 0 ? (
        <p className="hdFieldError">{t(locale, 'helpDesk.candidates.needExamples')}</p>
      ) : null}
    </>
  )

  function similarRow(card: ReviewSimilar, index: number) {
    const isTarget = target === card.faqId
    const isMoveTo = choice?.moveTo === card.faqId
    return (
      <li key={card.faqId} className={`hdReviewRow hdReviewSimilar${isTarget ? ' hdReviewSimilarOn' : ''}`}>
        <div className="hdReviewSimilarHead">
          <span className="hdReviewRank" aria-hidden="true">
            {index + 1}
          </span>
          <p className="hdReviewSimilarQuestion">{zh ? card.questionZh : card.questionEn}</p>
          <span className="hdReviewScore" title={t(locale, 'helpDesk.review.scoreTitle')}>
            {scorePercent(card.score)}
          </span>
        </div>
        <p className="hdReviewExcerpt">{zh ? card.answerExcerptZh : card.answerExcerptEn}</p>
        <div className="hdReviewRowMeta hdReviewIndent">
          {card.samePlace ? <span className="hdGraphTag hdReviewTagBlue">{t(locale, 'helpDesk.review.samePlace')}</span> : null}
          {card.closeMatch ? (
            <span className="hdGraphTag hdReviewTagAmber" title={t(locale, 'helpDesk.review.closeMatchHint')}>
              {t(locale, 'helpDesk.review.closeMatch')}
            </span>
          ) : null}
          {shownIds.has(card.faqId) ? <span className="hdGraphTag">{t(locale, 'helpDesk.review.wasShown')}</span> : null}
          {card.placePath.length > 0 ? <span>{pathText(card.placePath, locale)}</span> : null}
        </div>
        {targetPick || (decidable && action === 'retire_faq') ? (
          <div className="hdReviewIndent hdReviewRowActions">
            {targetPick ? (
              <button
                type="button"
                className={`hdReviewMini${isTarget ? ' hdReviewMiniOn' : ''}`}
                aria-pressed={isTarget}
                disabled={busy}
                onClick={() => update({ target: card.faqId, moveTo: choice?.moveTo === card.faqId ? null : (choice?.moveTo ?? null) })}
              >
                {t(
                  locale,
                  isTarget
                    ? 'helpDesk.review.pick.chosen'
                    : action === 'follow_up'
                      ? 'helpDesk.review.pick.parent'
                      : 'helpDesk.review.pick.target',
                )}
              </button>
            ) : null}
            {action === 'retire_faq' && !isTarget ? (
              <button
                type="button"
                className={`hdReviewMini${isMoveTo ? ' hdReviewMiniOn' : ''}`}
                aria-pressed={isMoveTo}
                disabled={busy}
                onClick={() => update({ moveTo: isMoveTo ? null : card.faqId })}
              >
                {t(locale, 'helpDesk.review.pick.moveTo')}
              </button>
            ) : null}
          </div>
        ) : null}
      </li>
    )
  }

  const similarPanel = (
    <>
      <p className="hdGraphHint">
        {t(locale, 'helpDesk.review.similarHint')}
        {review ? ` ${t(locale, `helpDesk.review.source.${review.similaritySource}`)}` : ''}
      </p>
      {reviewError ? (
        <p className="hdGraphHint">{t(locale, 'helpDesk.review.reviewMissing', { error: errorMessage(locale, reviewError) })}</p>
      ) : null}
      {review && similar.length === 0 ? <p className="hdGraphHint">{t(locale, 'helpDesk.review.noSimilar')}</p> : null}
      {similar.length > 0 ? <ol className="hdReviewRows">{similar.map(similarRow)}</ol> : null}
    </>
  )

  const usersPanel = (
    <div className="hdReviewUsers">
      <section aria-labelledby={`${uid}-states`}>
        <h4 className="hdGraphTitle" id={`${uid}-states`}>
          {t(locale, 'helpDesk.review.states.title')}
        </h4>
        {states ? (
          <>
            <p className="hdGraphHint">{t(locale, 'helpDesk.review.states.total', { total: states.total })}</p>
            <div className="hdReviewStack" aria-hidden="true">
              {shares.map((share) => (
                <span key={share.bucket} className={`hdReviewState-${share.bucket}`} style={{ width: `${share.percent}%` }} />
              ))}
            </div>
            <ul className="hdReviewLegend">
              {shares.map((share) => (
                <li key={share.bucket}>
                  <span className={`hdReviewDot hdReviewState-${share.bucket}`} aria-hidden="true" />
                  <span>{t(locale, `helpDesk.review.states.bucket.${share.bucket}`)}</span>
                  <span className="hdReviewLegendCount">
                    {t(locale, 'helpDesk.review.states.share', { count: share.count, percent: share.percent })}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="hdGraphHint">{t(locale, 'helpDesk.review.states.none')}</p>
        )}
      </section>
      <section aria-labelledby={`${uid}-net`}>
        <h4 className="hdGraphTitle" id={`${uid}-net`}>
          {t(locale, 'helpDesk.review.net.title')}
        </h4>
        {net ? (
          <>
            <dl className="hdReviewStats">
              <div>
                <dt>{t(locale, 'helpDesk.review.net.gains')}</dt>
                <dd>+{net.gains}</dd>
              </div>
              <div>
                <dt>{t(locale, 'helpDesk.review.net.steals')}</dt>
                <dd>−{net.steals}</dd>
              </div>
              <div>
                <dt>{t(locale, 'helpDesk.review.net.net')}</dt>
                <dd className={net.net < 0 ? 'hdReviewNegative' : net.net > 0 ? 'hdReviewPositive' : undefined}>
                  {net.net > 0 ? `+${net.net}` : net.net < 0 ? `−${Math.abs(net.net)}` : '0'}
                </dd>
              </div>
            </dl>
            <p className="hdGraphHint">{t(locale, 'helpDesk.review.net.basis', { version: net.releaseVersion, cases: net.evalCases })}</p>
            {net.net < 0 ? <p className="hdFieldError">{t(locale, 'helpDesk.review.net.negative')}</p> : null}
          </>
        ) : (
          <p className="hdGraphHint">{t(locale, 'helpDesk.review.net.none')}</p>
        )}
      </section>
    </div>
  )

  const tabs: [Tab, string][] = [
    ['said', t(locale, 'helpDesk.review.tabs.said', { count: candidate.examples.length })],
    ['similar', t(locale, 'helpDesk.review.tabs.similar', { count: similar.length })],
    ['users', t(locale, 'helpDesk.review.tabs.users')],
  ]

  /* ---------------- 右栏：你的处理 ---------------- */

  const fieldError = (field: FaqField) =>
    submitted && draftErrors[field] ? (
      <p className="hdFieldError" id={`${uid}-${field}-error`}>
        {t(locale, `helpDesk.drawer.errors.${draftErrors[field]}`, {
          max: field.startsWith('question') ? FAQ_LIMITS.questionMax : FAQ_LIMITS.answerMax,
        })}
      </p>
    ) : null

  function textField(field: FaqField, labelKey: string, rows: number) {
    if (!editor) return null
    const invalid = submitted && Boolean(draftErrors[field])
    return (
      <div className="hdReviewField">
        <label className="hdReviewLabel" htmlFor={`${uid}-${field}`}>
          {t(locale, labelKey)}
          <span className="hdReviewStar"> *</span>
        </label>
        <textarea
          id={`${uid}-${field}`}
          className={`hdTextarea hdReviewText${rows > 2 ? ' hdReviewTextAnswer' : ''}`}
          rows={rows}
          value={editor.draft[field] as string}
          readOnly={!decidable}
          disabled={busy}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${uid}-${field}-error` : undefined}
          onChange={(event) => edit(field, event.target.value)}
        />
        {fieldError(field)}
      </div>
    )
  }

  const langHasError = (value: Lang) =>
    submitted && (value === 'zh' ? draftErrors.questionZh || draftErrors.answerZh : draftErrors.questionEn || draftErrors.answerEn)

  const cardEditor =
    editing && editor ? (
      <section className="hdReviewEditor" aria-label={t(locale, 'helpDesk.review.editor.title')}>
        <div className="hdReviewEditorHead">
          <p className="hdReviewLabel">
            {t(locale, action === 'update_faq' ? 'helpDesk.review.editor.titleUpdate' : 'helpDesk.review.editor.title')}
          </p>
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
                {langHasError(value) ? <span className="hdReviewErrDot" aria-label={t(locale, 'helpDesk.review.editor.hasError')} /> : null}
              </button>
            ))}
          </div>
        </div>
        {lang === 'zh' ? (
          <>
            {textField('questionZh', 'helpDesk.drawer.questionZh', 2)}
            {textField('answerZh', 'helpDesk.drawer.answerZh', 7)}
          </>
        ) : (
          <>
            {textField('questionEn', 'helpDesk.drawer.questionEn', 2)}
            {textField('answerEn', 'helpDesk.drawer.answerEn', 7)}
          </>
        )}
        <div className="hdReviewField hdReviewFieldRow">
          <label className="hdReviewLabel" htmlFor={`${uid}-category`}>
            {t(locale, 'helpDesk.drawer.category')}
            <span className="hdReviewStar"> *</span>
          </label>
          <select
            id={`${uid}-category`}
            className="hdReviewSelect"
            value={editor.draft.category ?? ''}
            disabled={!decidable || busy}
            aria-invalid={submitted && Boolean(draftErrors.category)}
            onChange={(event) =>
              setEditors((all) => ({
                ...all,
                [editor.source]: { ...editor, draft: { ...editor.draft, category: (event.target.value || null) as FaqCategory | null } },
              }))
            }
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
        </div>
        {fieldError('category')}
        {editor.sources.length > 0 ? (
          <details className="hdReviewSources">
            <summary>{t(locale, 'helpDesk.review.editor.sources', { count: editor.sources.length })}</summary>
            {editor.sources.map((text, index) => (
              <div key={index} className="hdReviewSource">
                <p>{text}</p>
                {decidable ? (
                  <button
                    type="button"
                    className="hdReviewMini"
                    onClick={() => {
                      const field = lang === 'zh' ? 'answerZh' : 'answerEn'
                      edit(field, editor.draft[field] ? `${editor.draft[field]}\n\n${text}` : text)
                    }}
                  >
                    {t(locale, 'helpDesk.review.editor.insert')}
                  </button>
                ) : null}
              </div>
            ))}
            <p className="hdGraphHint">{t(locale, 'helpDesk.review.editor.verify')}</p>
          </details>
        ) : null}
        {decidable ? (
          <button type="button" className="hdFaqPreview hdReviewFull" onClick={() => openFullEditor(candidate, choice)}>
            {t(locale, 'helpDesk.review.editor.full')}
          </button>
        ) : null}
        {submitted && unchanged ? <p className="hdFieldError">{t(locale, 'helpDesk.review.editor.unchanged')}</p> : null}
      </section>
    ) : null

  const cardPreview =
    !editing && editor ? (
      <section className="hdReviewEditor" aria-label={t(locale, 'helpDesk.review.editor.current')}>
        <p className="hdReviewLabel">{t(locale, 'helpDesk.review.editor.current')}</p>
        <div className="hdReviewPreview">
          <p className="hdReviewPreviewQ">{zh ? editor.draft.questionZh : editor.draft.questionEn}</p>
          <p className="hdReviewPreviewA">{zh ? editor.draft.answerZh : editor.draft.answerEn}</p>
        </div>
        {decidable && action === 'add_phrasing' ? (
          <button type="button" className="hdFaqPreview" onClick={() => pickAction('update_faq')}>
            {t(locale, 'helpDesk.review.editor.editInstead')}
          </button>
        ) : null}
      </section>
    ) : null

  const targetField = targetPick ? (
    <div className="hdReviewField">
      <p className="hdReviewLabel">
        {t(locale, action === 'follow_up' ? 'helpDesk.review.parentLabel' : 'helpDesk.review.targetLabel')}
        <span className="hdReviewStar"> *</span>
      </p>
      <div className="hdReviewTarget">
        <span className={cardName(target) ? 'hdReviewTargetName' : 'hdReviewMuted'}>
          {cardName(target) ?? t(locale, 'helpDesk.review.noTarget')}
        </span>
        <button type="button" className="hdReviewMini" onClick={() => setTab('similar')}>
          {t(locale, 'helpDesk.review.fromSimilar')}
        </button>
        <button type="button" className="hdReviewMini" aria-expanded={searchOpen} onClick={() => setSearchOpen((open) => !open)}>
          {t(locale, 'helpDesk.review.search')}
        </button>
      </div>
      {searchOpen ? (
        <FaqPicker
          locale={locale}
          legend={t(locale, action === 'follow_up' ? 'helpDesk.review.parentLabel' : 'helpDesk.review.targetLabel')}
          selected={target}
          onSelect={(id) => {
            update({ target: id })
            setSearchOpen(false)
          }}
          suggested={[]}
        />
      ) : null}
      {problems.includes('needTarget') ? <p className="hdFieldError">{t(locale, 'helpDesk.review.needTarget')}</p> : null}
    </div>
  ) : null

  const placeField =
    placeShown !== 'hidden' && choice ? (
      <div className="hdReviewField">
        <PlaceChips
          locale={locale}
          nodes={mapNodes}
          places={review?.places ?? []}
          selected={choice.place}
          onSelect={(id) => update({ place: id })}
          onOpenTree={() => setTreeOpen(true)}
          disabled={busy}
          required={placeShown === 'required'}
          invalid={problems.includes('needPlace')}
          errorId={`${uid}-place-error`}
        />
        {problems.includes('needPlace') ? (
          <p className="hdFieldError" id={`${uid}-place-error`}>
            {t(locale, 'helpDesk.review.needPlace')}
          </p>
        ) : null}
      </div>
    ) : mapError && (action === 'new_faq' || action === 'follow_up') ? (
      <p className="hdGraphHint">{t(locale, 'helpDesk.review.mapMissing', { error: errorMessage(locale, mapError) })}</p>
    ) : null

  const extraFields =
    action === 'retire_faq' || action === 'no_change' ? (
      <>
        {action === 'retire_faq' ? (
          <div className="hdReviewField">
            <p className="hdReviewLabel">{t(locale, 'helpDesk.review.moveToLabel')}</p>
            <div className="hdReviewTarget">
              <span className={choice?.moveTo ? 'hdReviewTargetName' : 'hdReviewMuted'}>
                {cardName(choice?.moveTo ?? null) ?? t(locale, 'helpDesk.review.noMoveTo')}
              </span>
              <button type="button" className="hdReviewMini" onClick={() => setTab('similar')}>
                {t(locale, 'helpDesk.review.fromSimilar')}
              </button>
            </div>
            {problems.includes('moveToSelf') ? <p className="hdFieldError">{t(locale, 'helpDesk.review.moveToSelf')}</p> : null}
          </div>
        ) : null}
        <div className="hdReviewField">
          <label className="hdReviewLabel" htmlFor={`${uid}-note`}>
            {t(locale, 'helpDesk.review.note')}
          </label>
          <textarea
            id={`${uid}-note`}
            className="hdTextarea hdReviewText"
            rows={2}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          {noteTooLong ? (
            <p className="hdFieldError">{t(locale, 'helpDesk.candidates.noteTooLong', { max: CANDIDATE_LIMITS.noteMax })}</p>
          ) : null}
        </div>
      </>
    ) : null

  const decidePane =
    decidable && choice ? (
      <>
        <div className="hdReviewField">
          <label className="hdReviewLabel" htmlFor={`${uid}-action`}>
            {t(locale, 'helpDesk.review.howLabel')}
          </label>
          <select
            id={`${uid}-action`}
            className="hdReviewSelect hdReviewSelectStrong"
            value={action}
            disabled={busy}
            onChange={(event) => pickAction(event.target.value as ReviewAction)}
          >
            {REVIEW_GROUPS.map((group) => (
              <optgroup key={group} label={t(locale, `helpDesk.review.group.${group}`)}>
                {GROUP_ACTIONS[group].map((value) => (
                  <option key={value} value={value}>
                    {t(locale, `helpDesk.review.action.${value}`)}
                    {value === recommended ? ` (${t(locale, 'helpDesk.review.aiTag')})` : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {action !== recommended || target !== (recommendedTarget ?? candidate.relatedNodeId) ? (
            <p className="hdReviewWill">{sentence(action, target)}</p>
          ) : null}
        </div>
        {targetField}
        {placeField}
        {cardEditor}
        {cardPreview}
        {editing && !editor && !editorError ? <p className="hdGraphHint">{t(locale, 'helpDesk.candidates.loading')}</p> : null}
        {editorError ? <p className="hdFieldError">{errorMessage(locale, editorError)}</p> : null}
        {extraFields}
      </>
    ) : (
      <>
        {cardEditor}
        {cardPreview}
      </>
    )

  const rejectPane = (
    <>
      <div className="hdReviewField">
        <label className="hdReviewLabel" htmlFor={`${uid}-reason`}>
          {t(locale, 'helpDesk.candidates.reason')}
          <span className="hdReviewStar"> *</span>
        </label>
        <select
          id={`${uid}-reason`}
          className="hdReviewSelect"
          value={reason}
          aria-invalid={submitted && !reason}
          onChange={(event) => setReason(event.target.value as DismissReason | '')}
        >
          <option value="" disabled>
            {t(locale, 'helpDesk.candidates.reasonPlaceholder')}
          </option>
          {DISMISS_REASONS.map((value) => (
            <option key={value} value={value}>
              {t(locale, `helpDesk.candidates.reasons.${value}`)}
            </option>
          ))}
        </select>
        {submitted && !reason ? <p className="hdFieldError">{t(locale, 'helpDesk.candidates.needReason')}</p> : null}
      </div>
      <div className="hdReviewField">
        <label className="hdReviewLabel" htmlFor={`${uid}-reject-note`}>
          {t(locale, 'helpDesk.candidates.note')}
        </label>
        <textarea
          id={`${uid}-reject-note`}
          className="hdTextarea hdReviewText"
          rows={3}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <p className="hdGraphHint">{t(locale, 'helpDesk.review.noteHint')}</p>
        {submitted && reason === 'other' && cleanNote === '' ? (
          <p className="hdFieldError">{t(locale, 'helpDesk.candidates.needNote')}</p>
        ) : null}
      </div>
    </>
  )

  const mergePane = (
    <div className="hdReviewField">
      <label className="hdReviewLabel" htmlFor={`${uid}-merge`}>
        {t(locale, 'helpDesk.review.mergeInto')}
        <span className="hdReviewStar"> *</span>
      </label>
      <select id={`${uid}-merge`} className="hdReviewSelect" value={mergeInto} onChange={(event) => setMergeInto(event.target.value)}>
        <option value="" disabled>
          {t(locale, 'helpDesk.review.mergePlaceholder')}
        </option>
        {mergeTargets.map((row) => (
          <option key={row.id} value={row.id}>
            {`${row.topic} · ${row.proposedQuestion}`}
          </option>
        ))}
      </select>
      <p className="hdGraphHint">{t(locale, 'helpDesk.review.mergeHint')}</p>
      {submitted && !mergeInto ? <p className="hdFieldError">{t(locale, 'helpDesk.review.needMerge')}</p> : null}
    </div>
  )

  const shortcutHint = (
    <kbd className="hdReviewKbd" aria-hidden="true">
      {t(locale, 'helpDesk.review.shortcut')}
    </kbd>
  )

  const primaryLabel =
    mode === 'confirmRetire'
      ? t(locale, 'helpDesk.review.approve.confirmRetire')
      : t(locale, `helpDesk.review.approve.${action}`, { count: choice?.picks.length ?? 0 })

  const footerNote = (() => {
    if (alert)
      return (
        <p className={alert.tone === 'alert' ? 'hdReviewFootAlert' : 'hdReviewFootNote'} role={alert.tone}>
          {alert.text}
        </p>
      )
    if (!canWrite) return <p className="hdReviewFootNote">{t(locale, 'helpDesk.review.readOnly')}</p>
    if (candidate.status !== 'new')
      return (
        <p className="hdReviewFootNote">
          {t(locale, `helpDesk.review.decided.${candidate.status}`, {
            when: longDate(candidate.decidedAt ?? candidate.updatedAt, locale),
            as: t(locale, `helpDesk.review.action.${candidate.acceptedAs ?? candidate.suggestion}`),
            reason: candidate.reason ? t(locale, `helpDesk.candidates.reasons.${candidate.reason}`) : '—',
          })}
          {candidate.status === 'merged' && candidate.mergedInto ? (
            <>
              {' '}
              <button type="button" className="hdFaqPreview" onClick={() => onOpen(candidate.mergedInto as string)}>
                {t(locale, 'helpDesk.candidates.openMerged')}
              </button>
            </>
          ) : null}
        </p>
      )
    if (mode === 'confirmRetire')
      return (
        <p className="hdReviewFootAlert" role="alert">
          {t(locale, 'helpDesk.review.confirmRetire', { question: cardName(target) ?? '—' })}
        </p>
      )
    if (mode === 'decide') return <p className="hdReviewFootNote">{t(locale, 'helpDesk.review.afterApprove')}</p>
    return null
  })()

  return (
    <section
      className="hdReviewPanel"
      aria-labelledby={`${uid}-topic`}
      aria-busy={busy}
      onKeyDown={(event) => {
        // Ctrl / ⌘ + Enter：按下右下角的主按钮（在输入框里也可以）
        if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.altKey) return
        if (!primaryRef.current || primaryRef.current.disabled) return
        event.preventDefault()
        primaryRef.current.click()
      }}
    >
      <div className="hdReviewBody">
        <div className="hdReviewEvidence">
          {summary}
          <div className="hdReviewTabs" role="tablist" aria-label={t(locale, 'helpDesk.review.evidence')}>
            {tabs.map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                id={`${uid}-tab-${key}`}
                aria-selected={tab === key}
                aria-controls={`${uid}-panel`}
                className={`hdReviewTab${tab === key ? ' hdReviewTabOn' : ''}`}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="hdReviewScroll" role="tabpanel" id={`${uid}-panel`} aria-labelledby={`${uid}-tab-${tab}`}>
            {tab === 'said' ? saidPanel : tab === 'similar' ? similarPanel : usersPanel}
          </div>
        </div>

        <div className="hdReviewDecide">
          <h4 className="hdReviewDecideTitle">
            {mode === 'reject'
              ? t(locale, 'helpDesk.review.rejectTitle')
              : mode === 'merge'
                ? t(locale, 'helpDesk.review.mergeTitle')
                : t(locale, 'helpDesk.review.decision')}
          </h4>
          <div className="hdReviewScroll hdReviewDecideBody">
            {mode === 'reject' ? rejectPane : mode === 'merge' ? mergePane : decidePane}
          </div>
          {treeOpen && choice ? (
            <PlaceTreePanel
              locale={locale}
              nodes={mapNodes}
              regions={review?.regions ?? []}
              selected={choice.place}
              onSelect={(id) => update({ place: id })}
              onClose={() => setTreeOpen(false)}
            />
          ) : null}
        </div>
      </div>

      <footer className="hdReviewFooter">
        <div className="hdReviewFootLeft">
          {decidable && mode === 'decide' ? (
            <>
              <button
                type="button"
                className="hdDrawerButton"
                disabled={busy}
                onClick={() => (setMode('reject'), setSubmitted(false), setAlert(null))}
              >
                {t(locale, 'helpDesk.review.reject')}
              </button>
              <button
                type="button"
                className="hdDrawerButton"
                disabled={busy || mergeTargets.length === 0}
                title={mergeTargets.length === 0 ? t(locale, 'helpDesk.review.noMergeTargets') : t(locale, 'helpDesk.review.mergeHint')}
                onClick={() => (setMode('merge'), setSubmitted(false), setAlert(null))}
              >
                {t(locale, 'helpDesk.review.merge')}
              </button>
            </>
          ) : null}
          {decidable && mode !== 'decide' ? (
            <button
              type="button"
              className="hdDrawerButton"
              disabled={busy}
              onClick={() => (setMode('decide'), setSubmitted(false), setAlert(null))}
            >
              {t(locale, 'helpDesk.candidates.cancel')}
            </button>
          ) : null}
        </div>
        <div className="hdReviewFootMid">{footerNote}</div>
        {decidable && choice ? (
          mode === 'reject' ? (
            <button
              ref={primaryRef}
              type="button"
              className="hdDrawerButton hdDrawerDanger"
              disabled={busy}
              aria-keyshortcuts="Control+Enter Meta+Enter"
              onClick={() => reject(candidate)}
            >
              {t(locale, busy ? 'helpDesk.candidates.saving' : 'helpDesk.review.confirmReject')}
              {shortcutHint}
            </button>
          ) : mode === 'merge' ? (
            <button
              ref={primaryRef}
              type="button"
              className="hdDrawerButton hdDrawerPrimary"
              disabled={busy}
              aria-keyshortcuts="Control+Enter Meta+Enter"
              onClick={() => merge(candidate)}
            >
              {t(locale, busy ? 'helpDesk.candidates.saving' : 'helpDesk.review.confirmMerge')}
              {shortcutHint}
            </button>
          ) : (
            <button
              type="button"
              ref={primaryRef}
              className="hdDrawerButton hdDrawerPrimary hdReviewPrimary"
              disabled={busy}
              aria-keyshortcuts="Control+Enter Meta+Enter"
              onClick={() => approve(candidate, choice)}
            >
              {busy ? t(locale, 'helpDesk.candidates.saving') : primaryLabel}
              {shortcutHint}
            </button>
          )
        ) : null}
      </footer>
    </section>
  )
}
