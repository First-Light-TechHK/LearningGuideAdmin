import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react'

import {
  CANDIDATE_LIMITS,
  DISMISS_REASONS,
  type AcceptCandidateBody,
  type CandidateDetail,
  type CandidateReview as ReviewData,
  type DismissReason,
  type FaqCandidate,
  type FaqMap,
  type ReviewSimilar,
} from '../contracts/helpdesk'
import {
  acceptCandidate,
  dismissCandidate,
  getCandidate,
  getCandidateDraft,
  getCandidateReview,
  getFaq,
  mergeCandidate,
  newIdempotencyKey,
} from '../lib/helpdeskApi'
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
  GROUP_ACTIONS,
  REVIEW_GROUPS,
  choiceProblems,
  defaultChoice,
  groupOf,
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
  type ReviewProblem,
} from '../lib/helpdeskReview'
import { cardTime, longDate } from '../lib/helpdeskView'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import type { Compose } from './CandidateDrawer'
import { FaqPicker } from './FaqPicker'
import { PlacePicker } from './PlacePicker'

/**
 * 「FAQ 候选」Tab 的卡片审核视图（?tab=candidates&view=cards，选中 &review=<id>）。
 * 没有 Figma 画板：沿用 HelpDesk 现有的卡片（Enquiry 卡片的白底细边圆角）、标签、按钮与单选样式，待视觉验收。
 * 左：队列卡片（和表格同一份筛选与分页）。中：AI 建议、用户原话与 AI 当时的处理、相似的已有卡（前 10）。
 * 右：提问用户的状态、预计净收益、你的决定（四种动作 + 目标卡 + 位置）与批准 / 驳回 / 合并。
 * 产品规则（owner 2026-10-31）：AI 只给建议，员工看完再批准；批准的改动进编辑区，下次发版过评测门才上线。
 * 写操作只给 FULL 且只对待处理的候选；VIEW 只看。决定带 version 与 Idempotency-Key（重试沿用同一个）。
 */

type Notice = { tone: 'status' | 'alert'; text: string } | null
type Mode = 'decide' | 'reject' | 'merge' | 'confirmRetire'

const when = (iso: string | null, locale: Locale) => (iso ? `${longDate(iso, locale)} ${cardTime(iso, locale)}` : '—')

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

/* ---------------------------------- 队列 ---------------------------------- */

type ReviewProps = {
  locale: Locale
  canWrite: boolean
  rows: readonly FaqCandidate[]
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
  const flashRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (flash) flashRef.current?.focus()
  }, [flash])

  return (
    <div className="hdReviewLayout">
      {flash ? (
        <div ref={flashRef} tabIndex={-1} className="hdNotice hdReviewNotice hdReviewFlash" role="status" key={flash.at}>
          {flash.text}
        </div>
      ) : null}
      <nav className="hdReviewQueue" aria-label={t(locale, 'helpDesk.review.queue')} aria-busy={loading}>
        <ul className="hdReviewQueueList">
          {rows.map((row) => {
            const on = row.id === current
            return (
              <li key={row.id}>
                <button
                  type="button"
                  className={`hdReviewQueueCard${on ? ' hdReviewQueueCardOn' : ''}`}
                  aria-current={on ? 'true' : undefined}
                  onClick={() => onSelect(row.id)}
                >
                  <span className="hdReviewQueueTop">
                    <span className={`hdFaqChip hdCandidateSuggestion hdCandidateSuggestion-${row.suggestion}`}>
                      {t(locale, `helpDesk.candidates.suggestion.${row.suggestion}`)}
                    </span>
                    <span className="hdReviewQueueCount">
                      {t(locale, 'helpDesk.review.asks', {
                        count: row.turnCount,
                      })}
                    </span>
                  </span>
                  <span className="hdReviewQueueTopic">{row.topic}</span>
                  <span className="hdReviewQueueQuestion">{row.proposedQuestion}</span>
                  <span className="hdReviewQueueSeen">
                    {row.status !== 'new' ? `${t(locale, `helpDesk.candidates.status.${row.status}`)} · ` : ''}
                    {t(locale, 'helpDesk.review.lastSeen', {
                      when: longDate(row.lastSeenAt, locale),
                    })}
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
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const [noticeShown, setNoticeShown] = useState(0)
  const [note, setNote] = useState('')
  const [reason, setReason] = useState<DismissReason | ''>('')
  const [mergeInto, setMergeInto] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [names, setNames] = useState<Record<string, { en: string; zh: string }>>({})
  const keyRef = useRef<DecisionKey | null>(null)
  const noticeRef = useRef<HTMLDivElement>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (noticeShown) noticeRef.current?.focus()
  }, [noticeShown])

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
    // 只在打开（换候选时整个组件换 key）读；决定之后再 load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateId])

  function say(next: Notice) {
    setNotice(next)
    setNoticeShown((value) => value + 1)
  }

  const similar = orderSimilar(review?.similar ?? [])
  const mapNodes = map?.nodes ?? []
  const mapHasNodes = mapNodes.length > 0

  /** 卡片的问题文字：相似卡、候选的相关节点、或搜索选中后读到的。 */
  function cardName(id: string | null): string | null {
    if (!id) return null
    const hit = similar.find((card) => card.faqId === id)
    if (hit) return zh ? hit.questionZh : hit.questionEn
    const node = detail?.nodes.find((n) => n.id === id)
    if (node) return zh ? node.questionZh : node.questionEn
    const named = names[id]
    if (named) return zh ? named.zh : named.en
    return null
  }

  // 搜索选中的卡不在相似卡和节点里：读一次名字
  const target = choice?.target ?? null
  useEffect(() => {
    if (!target || cardName(target) !== null) return
    let live = true
    void getFaq(target).then((result) => {
      if (live && result.ok)
        setNames((current) => ({
          ...current,
          [target]: { en: result.data.questionEn, zh: result.data.questionZh },
        }))
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, review, detail])

  /** 一个决定：失败（没变）重试沿用 key；别人先改了 → 重新载入并提示；成功 → 提示并跳到队列里下一条。 */
  async function decideWith<T>(
    body: unknown,
    send: (key: string) => Promise<{ ok: true; data: T } | { ok: false; code: string; status: number }>,
    success: string,
  ) {
    if (busy) return
    setBusy(true)
    keyRef.current = decisionKey(keyRef.current, body, newIdempotencyKey)
    const result = await send(keyRef.current.key)
    if (!mounted.current) return
    setBusy(false)
    if (result.ok) {
      keyRef.current = null
      await load(false)
      if (!mounted.current) return
      setMode('decide')
      setSubmitted(false)
      onDecided(success)
      return
    }
    if (result.code === 'CANDIDATE_CHANGED' || result.code === 'CANDIDATE_NOT_FOUND') await load(false)
    say({ tone: 'alert', text: errorMessage(locale, result.code) })
  }

  const cleanNote = note.trim().replace(/\s+/g, ' ')
  const noteTooLong = [...cleanNote].length > CANDIDATE_LIMITS.noteMax

  async function approve(candidate: FaqCandidate, current: ReviewChoice) {
    setSubmitted(true)
    const problems = choiceProblems(current, mapHasNodes)
    if (problems.length > 0 || noteTooLong || busy) return
    const place = current.place ?? undefined
    switch (current.action) {
      case 'no_change': {
        const body = {
          reason: 'not_a_gap' as const,
          ...(cleanNote ? { note: cleanNote } : {}),
          version: candidate.version,
        }
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
        if (mode !== 'confirmRetire') {
          setMode('confirmRetire')
          return
        }
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
        setBusy(true)
        setNotice(null)
        const faq = await getFaq(current.target as string)
        if (!mounted.current) return
        setBusy(false)
        if (!faq.ok) return say({ tone: 'alert', text: errorMessage(locale, faq.code) })
        return onCompose({
          candidate,
          as: 'update_faq',
          faq: faq.data,
          parentId: null,
          phrasings: current.picks,
          version: candidate.version,
          draftSources: candidate.answerSources,
          placementNodeId: place ?? null,
        })
      }
      case 'new_faq':
      case 'follow_up': {
        setBusy(true)
        setNotice(null)
        const draft = await getCandidateDraft(candidate.id)
        if (!mounted.current) return
        setBusy(false)
        if (!draft.ok) return say({ tone: 'alert', text: errorMessage(locale, draft.code) })
        return onCompose({
          candidate,
          as: current.action,
          parentId: current.action === 'follow_up' ? current.target : null,
          phrasings: current.picks,
          version: draft.data.version,
          initial: faqDraftFromCandidate(draft.data, current.action),
          draftSources: draft.data.answerDraft?.sources ?? [],
          placementNodeId: place ?? null,
        })
      }
    }
  }

  function reject(candidate: FaqCandidate) {
    setSubmitted(true)
    if (!reason || (reason === 'other' && cleanNote === '') || noteTooLong) return
    const body = {
      reason,
      ...(cleanNote ? { note: cleanNote } : {}),
      version: candidate.version,
    }
    void decideWith(body, (key) => dismissCandidate(candidate.id, body, key), t(locale, 'helpDesk.review.done.rejected'))
  }

  function merge(candidate: FaqCandidate) {
    setSubmitted(true)
    if (!mergeInto) return
    const body = { targetId: mergeInto, version: candidate.version }
    void decideWith(body, (key) => mergeCandidate(candidate.id, body, key), t(locale, 'helpDesk.review.done.merged'))
  }

  function update(patch: Partial<ReviewChoice>) {
    setChoice((current) => (current ? { ...current, ...patch } : current))
    if (mode === 'confirmRetire') setMode('decide')
  }

  function pickAction(action: ReviewAction) {
    setChoice((current) => (current ? switchAction(current, action, review?.recommendation.faqId ?? null) : current))
    setSubmitted(false)
    if (mode === 'confirmRetire') setMode('decide')
  }

  if (!detail)
    return (
      <div className="hdReviewMain" aria-busy={!loadError}>
        {loadError ? (
          <div className="hdNotice hdReviewNotice hdDrawerAlert" role="alert">
            {errorMessage(locale, loadError)}
          </div>
        ) : (
          <p className="hdGraphHint">{t(locale, 'helpDesk.candidates.loading')}</p>
        )}
      </div>
    )

  const { candidate } = detail
  const decidable = canDecide(candidate, canWrite) && choice !== null
  const action = choice?.action ?? candidate.suggestion
  const recommended = review?.recommendation.action ?? candidate.suggestion
  const problems: ReviewProblem[] = submitted && choice ? choiceProblems(choice, mapHasNodes) : []
  const shownIds = new Set((review?.handling ?? []).map((h) => h.shownFaqId).filter((id): id is string => id !== null))
  const rationale = review
    ? ((zh ? review.recommendation.rationaleZh : review.recommendation.rationaleEn) ?? review.recommendation.rationale)
    : null
  const picking = decidable && usesPhrasings(action)
  const targetPick = decidable && needsTarget(action)
  const targetLabel = action === 'follow_up' ? 'parent' : 'target'

  /* ---------------- 中栏 ---------------- */

  const headCard = (
    <section className="hdReviewCard" aria-labelledby={`${uid}-topic`}>
      <div className="hdCandidateHead">
        <h3 className="hdCandidateTopic" id={`${uid}-topic`}>
          {candidate.topic}
        </h3>
        <div className="hdCandidateTags">
          <span className={`hdFaqChip hdCandidateStatus hdCandidateStatus-${candidate.status}`}>
            {t(locale, `helpDesk.candidates.status.${candidate.status}`)}
          </span>
          <span className="hdGraphTag">{t(locale, `helpDesk.candidates.origin.${candidate.origin}`)}</span>
          {candidate.category ? <span className="hdGraphTag">{faqCategoryLabel(locale, candidate.category)}</span> : null}
        </div>
      </div>
      <div className="hdField">
        <p className="hdFieldLabel">{t(locale, 'helpDesk.candidates.proposed')}</p>
        <p className="hdCandidateQuestion">{candidate.proposedQuestion}</p>
      </div>
      <p className="hdCandidateMeta">
        <span>{t(locale, 'helpDesk.review.asks', { count: candidate.turnCount })}</span>
        <span className="hdGraphHint">
          {t(locale, 'helpDesk.candidates.seen', {
            first: longDate(candidate.firstSeenAt, locale),
            last: longDate(candidate.lastSeenAt, locale),
          })}
        </span>
      </p>
      <div className="hdReviewAdvice">
        <p className="hdReviewAdviceTitle">
          <span className="hdGraphTag hdReviewTagBlue">{t(locale, 'helpDesk.review.aiTag')}</span>
          {GROUP_ACTIONS[groupOf(recommended)].length === 1
            ? t(locale, `helpDesk.review.group.${groupOf(recommended)}`)
            : t(locale, 'helpDesk.review.advice', {
                group: t(locale, `helpDesk.review.group.${groupOf(recommended)}`),
                action: t(locale, `helpDesk.review.action.${recommended}`),
              })}
        </p>
        {rationale ? <p className="hdReviewAdviceText">{rationale}</p> : null}
        {review?.recommendation.faqId ? (
          <p className="hdGraphHint">
            {t(locale, recommended === 'follow_up' ? 'helpDesk.review.adviceParent' : 'helpDesk.review.adviceTarget', {
              question: cardName(review.recommendation.faqId) ?? '—',
            })}
          </p>
        ) : null}
        <p className="hdGraphHint">{t(locale, 'helpDesk.review.adviceHint')}</p>
      </div>
      {candidate.status !== 'new' ? (
        <div className="hdCandidateDecided">
          <p className="hdReleaseLive">
            {t(locale, `helpDesk.review.decided.${candidate.status}`, {
              when: when(candidate.decidedAt, locale),
              as: t(locale, `helpDesk.review.action.${candidate.acceptedAs ?? candidate.suggestion}`),
              reason: candidate.reason ? t(locale, `helpDesk.candidates.reasons.${candidate.reason}`) : '—',
            })}
          </p>
          {candidate.reasonNote ? <p className="hdGraphHint">{candidate.reasonNote}</p> : null}
          {candidate.status === 'merged' && candidate.mergedInto ? (
            <button type="button" className="hdFaqPreview" onClick={() => onOpen(candidate.mergedInto as string)}>
              {t(locale, 'helpDesk.candidates.openMerged')}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  )

  const handlingCard = (
    <section className="hdReviewCard" aria-labelledby={`${uid}-said`}>
      <h4 className="hdGraphTitle" id={`${uid}-said`}>
        {t(locale, 'helpDesk.review.said')}
      </h4>
      <p className="hdGraphHint" id={`${uid}-said-hint`}>
        {t(locale, picking ? 'helpDesk.review.saidPickHint' : 'helpDesk.review.saidHint')}
      </p>
      <ul className="hdReviewSaid">
        {candidate.examples.map((example, index) => {
          const handled = review?.handling.find((h) => h.exampleIndex === index)
          const outcome = handled?.outcome ?? example.reasons[0] ?? null
          const shown = handled?.shownFaqId ?? null
          const text = <Example text={example.text} locale={locale} />
          return (
            <li key={`${index}-${example.turnId ?? ''}`} className="hdReviewSaidItem">
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
              <div className="hdReviewSaidMeta">
                <span className="hdGraphTag">{t(locale, `helpDesk.review.locale.${example.locale}`)}</span>
                {outcome ? <span className="hdGraphTag hdReviewTagAmber">{t(locale, `helpDesk.candidates.mix.${outcome}`)}</span> : null}
                <span className="hdGraphHint">
                  {shown
                    ? t(locale, 'helpDesk.review.shownCard', {
                        question: cardName(shown) ?? t(locale, 'helpDesk.review.unknownCard'),
                      })
                    : t(locale, 'helpDesk.review.noCardShown')}
                </span>
              </div>
            </li>
          )
        })}
      </ul>
      {problems.includes('needExamples') ? <p className="hdFieldError">{t(locale, 'helpDesk.candidates.needExamples')}</p> : null}
    </section>
  )

  function similarItem(card: ReviewSimilar, index: number) {
    const isTarget = choice?.target === card.faqId
    const isMoveTo = choice?.moveTo === card.faqId
    return (
      <li key={card.faqId} className={`hdReviewSimilar${isTarget ? ' hdReviewSimilarOn' : ''}`}>
        <div className="hdReviewSimilarHead">
          <span className="hdReviewRank" aria-hidden="true">
            {index + 1}
          </span>
          <p className="hdReviewSimilarQuestion">{zh ? card.questionZh : card.questionEn}</p>
          <span className="hdReviewScore" title={t(locale, 'helpDesk.review.scoreTitle')}>
            {scorePercent(card.score)}
          </span>
        </div>
        <div className="hdReviewBar" aria-hidden="true">
          <span style={{ width: scorePercent(card.score) }} />
        </div>
        <div className="hdReviewSimilarTags">
          {card.samePlace ? <span className="hdGraphTag hdReviewTagBlue">{t(locale, 'helpDesk.review.samePlace')}</span> : null}
          {card.closeMatch ? <span className="hdGraphTag hdReviewTagAmber">{t(locale, 'helpDesk.review.closeMatch')}</span> : null}
          {shownIds.has(card.faqId) ? <span className="hdGraphTag">{t(locale, 'helpDesk.review.wasShown')}</span> : null}
          {review?.recommendation.faqId === card.faqId ? (
            <span className="hdGraphTag hdReviewTagBlue">{t(locale, 'helpDesk.review.aiTarget')}</span>
          ) : null}
          {!card.entry ? <span className="hdGraphTag">{t(locale, 'helpDesk.review.followUpCard')}</span> : null}
        </div>
        {card.placePath.length > 0 ? <p className="hdGraphHint">{pathText(card.placePath, locale)}</p> : null}
        <p className="hdReviewExcerpt">{zh ? card.answerExcerptZh : card.answerExcerptEn}</p>
        {card.closeMatch ? <p className="hdGraphHint">{t(locale, 'helpDesk.review.closeMatchHint')}</p> : null}
        {targetPick ? (
          <div className="hdReviewSimilarActions">
            <label className={`hdReviewOption hdReviewOptionInline${isTarget ? ' hdReviewOptionOn' : ''}`}>
              <input
                type="radio"
                className="hdReviewRadio"
                name={`${uid}-target`}
                checked={isTarget}
                disabled={busy}
                onChange={() =>
                  update({
                    target: card.faqId,
                    moveTo: choice?.moveTo === card.faqId ? null : (choice?.moveTo ?? null),
                  })
                }
              />
              <span>{t(locale, `helpDesk.review.pick.${targetLabel}`)}</span>
            </label>
            {action === 'retire_faq' && !isTarget ? (
              <label className={`hdReviewOption hdReviewOptionInline${isMoveTo ? ' hdReviewOptionOn' : ''}`}>
                <input
                  type="checkbox"
                  className="hdCheckInput"
                  checked={isMoveTo}
                  disabled={busy}
                  onChange={(event) => update({ moveTo: event.target.checked ? card.faqId : null })}
                />
                <span>{t(locale, 'helpDesk.review.pick.moveTo')}</span>
              </label>
            ) : null}
          </div>
        ) : null}
      </li>
    )
  }

  const similarCard = (
    <section className="hdReviewCard" aria-labelledby={`${uid}-similar`}>
      <div className="hdReviewCardHead">
        <h4 className="hdGraphTitle" id={`${uid}-similar`}>
          {t(locale, 'helpDesk.review.similar', { count: similar.length })}
        </h4>
        {review ? <span className="hdGraphTag">{t(locale, `helpDesk.review.source.${review.similaritySource}`)}</span> : null}
      </div>
      <p className="hdGraphHint">{t(locale, 'helpDesk.review.similarHint')}</p>
      {reviewError ? (
        <p className="hdGraphHint" role="status">
          {t(locale, 'helpDesk.review.reviewMissing', {
            error: errorMessage(locale, reviewError),
          })}
        </p>
      ) : null}
      {review && similar.length === 0 ? <p className="hdGraphHint">{t(locale, 'helpDesk.review.noSimilar')}</p> : null}
      {similar.length > 0 ? <ol className="hdReviewSimilarList">{similar.map(similarItem)}</ol> : null}
    </section>
  )

  /* ---------------- 右栏 ---------------- */

  const shares = review?.userStates ? stateShares(review.userStates.buckets, review.userStates.total) : []
  const statesCard = (
    <section className="hdReviewCard" aria-labelledby={`${uid}-states`}>
      <h4 className="hdGraphTitle" id={`${uid}-states`}>
        {t(locale, 'helpDesk.review.states.title')}
      </h4>
      {review?.userStates ? (
        <>
          <p className="hdGraphHint">
            {t(locale, 'helpDesk.review.states.total', {
              total: review.userStates.total,
            })}
          </p>
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
                  {t(locale, 'helpDesk.review.states.share', {
                    count: share.count,
                    percent: share.percent,
                  })}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="hdGraphHint">{t(locale, 'helpDesk.review.states.none')}</p>
      )}
    </section>
  )

  const net = review?.netValue ?? null
  const netCard = (
    <section className="hdReviewCard" aria-labelledby={`${uid}-net`}>
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
          <p className="hdGraphHint">
            {t(locale, 'helpDesk.review.net.basis', {
              version: net.releaseVersion,
              cases: net.evalCases,
            })}
          </p>
          {net.net < 0 ? <p className="hdFieldError">{t(locale, 'helpDesk.review.net.negative')}</p> : null}
        </>
      ) : (
        <p className="hdGraphHint">{t(locale, 'helpDesk.review.net.none')}</p>
      )}
    </section>
  )

  function actionPicker(): ReactNode {
    return (
      <fieldset className="hdReviewFieldset">
        <legend className="hdFieldLabel">{t(locale, 'helpDesk.review.chooseAction')}</legend>
        {REVIEW_GROUPS.map((group) => (
          <div key={group} className="hdReviewGroup">
            <p className="hdReviewGroupTitle">{t(locale, `helpDesk.review.group.${group}`)}</p>
            {GROUP_ACTIONS[group].map((value) => (
              <label key={value} className={`hdReviewOption${action === value ? ' hdReviewOptionOn' : ''}`}>
                <input
                  type="radio"
                  className="hdReviewRadio"
                  name={`${uid}-action`}
                  value={value}
                  checked={action === value}
                  disabled={busy}
                  onChange={() => pickAction(value)}
                />
                <span className="hdReviewOptionText">
                  <span>
                    {t(locale, `helpDesk.review.action.${value}`)}
                    {value === recommended ? (
                      <span className="hdGraphTag hdReviewTagBlue hdReviewInlineTag">{t(locale, 'helpDesk.review.aiTag')}</span>
                    ) : null}
                  </span>
                  <span className="hdGraphHint">{t(locale, `helpDesk.review.actionHint.${value}`)}</span>
                </span>
              </label>
            ))}
          </div>
        ))}
      </fieldset>
    )
  }

  const placeShown = choice ? placeMode(action, mapHasNodes) : 'hidden'
  const targetName = cardName(choice?.target ?? null)
  const moveToName = cardName(choice?.moveTo ?? null)

  const decideForm =
    choice && decidable ? (
      <>
        {actionPicker()}

        {targetPick ? (
          <div className="hdField" id={`${uid}-target-field`}>
            <p className="hdFieldLabel">
              {t(locale, `helpDesk.review.${targetLabel}Label`)}
              <span className="hdRequired" aria-hidden="true">
                {' '}
                *
              </span>
            </p>
            <p className={targetName ? 'hdReviewPicked' : 'hdGraphHint'}>{targetName ?? t(locale, 'helpDesk.review.noTarget')}</p>
            {problems.includes('needTarget') ? (
              <p className="hdFieldError" role="alert">
                {t(locale, 'helpDesk.review.needTarget')}
              </p>
            ) : null}
            <button type="button" className="hdFaqPreview" aria-expanded={searchOpen} onClick={() => setSearchOpen((open) => !open)}>
              {t(locale, searchOpen ? 'helpDesk.review.hideSearch' : 'helpDesk.review.searchOther')}
            </button>
            {searchOpen ? (
              <FaqPicker
                locale={locale}
                legend={t(locale, `helpDesk.review.${targetLabel}Label`)}
                selected={choice.target}
                onSelect={(id) => update({ target: id })}
                suggested={[]}
              />
            ) : null}
          </div>
        ) : null}

        {placeShown !== 'hidden' ? (
          <>
            <PlacePicker
              locale={locale}
              nodes={mapNodes}
              places={review?.places ?? []}
              regions={review?.regions ?? []}
              selected={choice.place}
              onSelect={(id) => update({ place: id })}
              disabled={busy}
              required={placeShown === 'required'}
              invalid={problems.includes('needPlace')}
              describedBy={problems.includes('needPlace') ? `${uid}-place-error` : undefined}
            />
            {problems.includes('needPlace') ? (
              <p className="hdFieldError" id={`${uid}-place-error`} role="alert">
                {t(locale, 'helpDesk.review.needPlace')}
              </p>
            ) : null}
          </>
        ) : null}
        {mapError && (action === 'new_faq' || action === 'follow_up') ? (
          <p className="hdGraphHint">
            {t(locale, 'helpDesk.review.mapMissing', {
              error: errorMessage(locale, mapError),
            })}
          </p>
        ) : null}

        {action === 'retire_faq' ? (
          <div className="hdField">
            <p className="hdFieldLabel">{t(locale, 'helpDesk.review.moveToLabel')}</p>
            <p className={moveToName ? 'hdReviewPicked' : 'hdGraphHint'}>{moveToName ?? t(locale, 'helpDesk.review.noMoveTo')}</p>
            {problems.includes('moveToSelf') ? <p className="hdFieldError">{t(locale, 'helpDesk.review.moveToSelf')}</p> : null}
          </div>
        ) : null}

        {action === 'retire_faq' || action === 'no_change' ? (
          <div className="hdField">
            <label className="hdFieldLabel" htmlFor={`${uid}-note`}>
              {t(locale, 'helpDesk.review.note')}
            </label>
            <textarea
              id={`${uid}-note`}
              className="hdTextarea hdCandidateNote"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
            <p className="hdGraphHint">{t(locale, 'helpDesk.review.noteHint')}</p>
            {noteTooLong ? (
              <p className="hdFieldError">
                {t(locale, 'helpDesk.candidates.noteTooLong', {
                  max: CANDIDATE_LIMITS.noteMax,
                })}
              </p>
            ) : null}
          </div>
        ) : null}

        {mode === 'confirmRetire' ? (
          <div className="hdReviewConfirm" role="alert">
            {t(locale, 'helpDesk.review.confirmRetire', {
              question: targetName ?? '—',
            })}
          </div>
        ) : null}

        <div className="hdReviewButtons">
          <button type="button" className="hdDrawerButton hdDrawerPrimary" disabled={busy} onClick={() => void approve(candidate, choice)}>
            {busy
              ? t(locale, 'helpDesk.candidates.saving')
              : t(locale, mode === 'confirmRetire' ? 'helpDesk.review.approve.confirmRetire' : `helpDesk.review.approve.${action}`)}
          </button>
          {mode === 'confirmRetire' ? (
            <button type="button" className="hdDrawerButton" disabled={busy} onClick={() => setMode('decide')}>
              {t(locale, 'helpDesk.candidates.cancel')}
            </button>
          ) : (
            <>
              <button type="button" className="hdDrawerButton" disabled={busy} onClick={() => (setMode('reject'), setSubmitted(false))}>
                {t(locale, 'helpDesk.review.reject')}
              </button>
              <button
                type="button"
                className="hdDrawerButton"
                disabled={busy || mergeTargets.length === 0}
                title={mergeTargets.length === 0 ? t(locale, 'helpDesk.review.noMergeTargets') : undefined}
                onClick={() => (setMode('merge'), setSubmitted(false))}
              >
                {t(locale, 'helpDesk.review.merge')}
              </button>
            </>
          )}
        </div>
        <p className="hdGraphHint">{t(locale, 'helpDesk.review.afterApprove')}</p>
      </>
    ) : null

  const rejectForm =
    decidable && mode === 'reject' ? (
      <div className="hdCandidateForm">
        <div className="hdField">
          <label className="hdFieldLabel" htmlFor={`${uid}-reason`}>
            {t(locale, 'helpDesk.candidates.reason')}
            <span className="hdRequired" aria-hidden="true">
              {' '}
              *
            </span>
          </label>
          <select
            id={`${uid}-reason`}
            className="hdDrawerSelect"
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
        <div className="hdField">
          <label className="hdFieldLabel" htmlFor={`${uid}-reject-note`}>
            {t(locale, 'helpDesk.candidates.note')}
          </label>
          <textarea
            id={`${uid}-reject-note`}
            className="hdTextarea hdCandidateNote"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <p className="hdGraphHint">{t(locale, 'helpDesk.review.noteHint')}</p>
          {submitted && reason === 'other' && cleanNote === '' ? (
            <p className="hdFieldError">{t(locale, 'helpDesk.candidates.needNote')}</p>
          ) : null}
          {noteTooLong ? (
            <p className="hdFieldError">
              {t(locale, 'helpDesk.candidates.noteTooLong', {
                max: CANDIDATE_LIMITS.noteMax,
              })}
            </p>
          ) : null}
        </div>
        <div className="hdReviewButtons">
          <button type="button" className="hdDrawerButton hdDrawerDanger" disabled={busy} onClick={() => reject(candidate)}>
            {t(locale, busy ? 'helpDesk.candidates.saving' : 'helpDesk.review.confirmReject')}
          </button>
          <button type="button" className="hdDrawerButton" disabled={busy} onClick={() => (setMode('decide'), setSubmitted(false))}>
            {t(locale, 'helpDesk.candidates.cancel')}
          </button>
        </div>
      </div>
    ) : null

  const mergeForm =
    decidable && mode === 'merge' ? (
      <div className="hdCandidateForm">
        <div className="hdField">
          <label className="hdFieldLabel" htmlFor={`${uid}-merge`}>
            {t(locale, 'helpDesk.review.mergeInto')}
            <span className="hdRequired" aria-hidden="true">
              {' '}
              *
            </span>
          </label>
          <select id={`${uid}-merge`} className="hdDrawerSelect" value={mergeInto} onChange={(event) => setMergeInto(event.target.value)}>
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
        <div className="hdReviewButtons">
          <button type="button" className="hdDrawerButton hdDrawerPrimary" disabled={busy} onClick={() => merge(candidate)}>
            {t(locale, busy ? 'helpDesk.candidates.saving' : 'helpDesk.review.confirmMerge')}
          </button>
          <button type="button" className="hdDrawerButton" disabled={busy} onClick={() => (setMode('decide'), setSubmitted(false))}>
            {t(locale, 'helpDesk.candidates.cancel')}
          </button>
        </div>
      </div>
    ) : null

  return (
    <>
      <div className="hdReviewMain" aria-busy={busy}>
        {notice ? (
          <div
            ref={noticeRef}
            tabIndex={-1}
            className={`hdNotice hdReviewNotice${notice.tone === 'alert' ? ' hdDrawerAlert' : ''}`}
            role={notice.tone}
          >
            {notice.text}
          </div>
        ) : null}
        {headCard}
        {handlingCard}
        {similarCard}
      </div>
      <aside className="hdReviewSide" aria-label={t(locale, 'helpDesk.review.side')}>
        {statesCard}
        {netCard}
        <section className="hdReviewCard hdReviewDecision" aria-labelledby={`${uid}-decision`}>
          <h4 className="hdGraphTitle" id={`${uid}-decision`}>
            {t(locale, 'helpDesk.review.decision')}
          </h4>
          {!canWrite ? <p className="hdGraphHint">{t(locale, 'helpDesk.review.readOnly')}</p> : null}
          {canWrite && candidate.status !== 'new' ? <p className="hdGraphHint">{t(locale, 'helpDesk.review.alreadyDecided')}</p> : null}
          {mode === 'reject' ? rejectForm : mode === 'merge' ? mergeForm : decideForm}
        </section>
      </aside>
    </>
  )
}
