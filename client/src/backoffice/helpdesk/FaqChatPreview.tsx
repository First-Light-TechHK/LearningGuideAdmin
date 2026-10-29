import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import type { FaqGraphPreview, HelpdeskLocale } from '../contracts/helpdesk'
import { getGraphPreview } from '../lib/helpdeskApi'
import { errorMessage } from '../lib/helpdeskFormat'
import { previewGraph, previewStarts, previewTurn, type PreviewStep, type PreviewTurn } from '../lib/helpdeskGraph'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import { MarkdownView } from './Markdown'

/**
 * 对话预览（helpdesk-v5-faq-graph-design §5.3）：在工作副本上模拟学员的对话，像学员一样点追问 chip 和
 * 选项按钮，看到的就是 Portal 点击时会显示的样子（v5 Part H：点击不问模型）：
 * - answer：固定开场 → 引用卡片「来自：<问题>」+ 整条答案原文 → 固定结尾 →「你可能还想问：」至多 4 个追问；
 * - choice：提问 + A/B/C/D 选项按钮。
 * 数据是服务端按 Portal 读 faq-release/current 的同一个投影（GET /api/helpdesk/faq-releases/preview）。
 * 不模拟学员打字（那要问模型）。语言可在 EN / 中文 之间切换，缺省跟随界面语言。只读。
 * 没有 Figma 画板：气泡、引用卡片、chip 沿用 Enquiries 时间线与 FAQ 抽屉的样式（待视觉验收）。
 */

type Entry = { nodeId: string; fromNodeId: string | null }
type State = { kind: 'loading' } | { kind: 'ready'; preview: FaqGraphPreview } | { kind: 'failed'; code: string }
type Loaded = { language: HelpdeskLocale; state: State }

const LANGUAGES: { value: HelpdeskLocale; key: string }[] = [
  { value: 'en-GB', key: 'helpDesk.preview.en' },
  { value: 'zh-CN', key: 'helpDesk.preview.zh' },
]

export function FaqChatPreview({ locale, startId }: { locale: Locale; startId: string }) {
  const uid = useId()
  const [language, setLanguage] = useState<HelpdeskLocale>(locale === 'zh-CN' ? 'zh-CN' : 'en-GB')
  // 最近一次回来的是哪种语言：和当前不同就是「加载中」
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const state: State = loaded && loaded.language === language ? loaded.state : { kind: 'loading' }
  const [start, setStart] = useState(startId)
  const [entries, setEntries] = useState<Entry[]>([{ nodeId: startId, fromNodeId: null }])
  const radios = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    let live = true
    void getGraphPreview(language).then((result) => {
      if (!live) return
      setLoaded({ language, state: result.ok ? { kind: 'ready', preview: result.data } : { kind: 'failed', code: result.code } })
    })
    return () => {
      live = false
    }
  }, [language])

  const ready = state.kind === 'ready' ? state.preview : null
  const graph = useMemo(() => (ready ? previewGraph(ready) : null), [ready])
  const starts = state.kind === 'ready' ? previewStarts(state.preview) : []
  const startNode = graph?.node(start) ?? null

  function onRadioKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const next = (index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + LANGUAGES.length) % LANGUAGES.length
    setLanguage(LANGUAGES[next].value)
    radios.current[next]?.focus()
  }

  function restart(nodeId = start) {
    setStart(nodeId)
    setEntries([{ nodeId, fromNodeId: null }])
  }

  function click(from: string, step: PreviewStep) {
    setEntries((current) => [...current, { nodeId: step.nodeId, fromNodeId: from }])
  }

  /** 学员这一步说了什么：点的 chip / 按钮上的字（从图里取，切换语言跟着变），第一步是问题本身。 */
  function learnerText(entry: Entry): string {
    if (!graph) return ''
    if (entry.fromNodeId) {
      const edge = graph.children(entry.fromNodeId).find((item) => item.childId === entry.nodeId)
      if (edge) return edge.label
    }
    return graph.node(entry.nodeId)?.question ?? ''
  }

  function steps(turn: Extract<PreviewTurn, { kind: 'answer' | 'choice' }>, index: number) {
    if (turn.steps.length === 0) return null
    const labelId = `${uid}-steps-${index}`
    const choice = turn.kind === 'choice'
    return (
      <>
        {choice ? null : (
          <p className="hdChatStepsTitle" id={labelId}>
            {t(language, 'helpDesk.chatPreview.followUpsTitle')}
          </p>
        )}
        <ul className="hdChatSteps" aria-labelledby={choice ? `${uid}-prompt-${index}` : labelId}>
          {turn.steps.map((step) => (
            <li key={step.nodeId}>
              <button type="button" className={`hdChatChip${choice ? ' hdChatOption' : ''}`} onClick={() => click(turn.nodeId, step)}>
                {choice ? (
                  <span className="hdGraphLetter" aria-hidden="true">
                    {step.letter}
                  </span>
                ) : null}
                <span>{step.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </>
    )
  }

  function assistant(turn: PreviewTurn, index: number) {
    if (turn.kind === 'missing') return <p className="hdGraphHint">{t(locale, 'helpDesk.chatPreview.missing')}</p>
    if (turn.kind === 'choice')
      return (
        <>
          <p className="hdChatText" id={`${uid}-prompt-${index}`}>
            {turn.prompt}
          </p>
          {turn.steps.length === 0 ? <p className="hdGraphHint">{t(locale, 'helpDesk.chatPreview.noOptions')}</p> : null}
          {steps(turn, index)}
        </>
      )
    return (
      <>
        <p className="hdChatText">{turn.opening}</p>
        <blockquote className="hdChatExcerpt">
          <p className="hdChatSource">{t(language, 'helpDesk.chatPreview.source', { question: turn.question })}</p>
          <MarkdownView className="hdAiAnswer" text={turn.answer} />
        </blockquote>
        <p className="hdChatText">{turn.closing}</p>
        {steps(turn, index)}
        {turn.hiddenSteps > 0 ? <p className="hdGraphHint">{t(locale, 'helpDesk.chatPreview.hidden', { count: turn.hiddenSteps })}</p> : null}
      </>
    )
  }

  return (
    <div className="hdChatPreview">
      <p className="hdGraphHint">{t(locale, 'helpDesk.chatPreview.hint')}</p>
      <div className="hdChatControls">
        <div className="hdPreviewSwitch" role="radiogroup" aria-label={t(locale, 'helpDesk.preview.languages')}>
          {LANGUAGES.map((item, index) => (
            <button
              key={item.value}
              ref={(node) => {
                radios.current[index] = node
              }}
              type="button"
              role="radio"
              aria-checked={language === item.value}
              tabIndex={language === item.value ? 0 : -1}
              className={`hdPreviewLang${language === item.value ? ' hdPreviewLangActive' : ''}`}
              onClick={() => setLanguage(item.value)}
              onKeyDown={(event) => onRadioKey(event, index)}
            >
              {t(locale, item.key)}
            </button>
          ))}
        </div>
        {state.kind === 'ready' && starts.length > 0 ? (
          <label className="hdChatStart">
            <span>{t(locale, 'helpDesk.chatPreview.start')}</span>
            <select className="hdDrawerSelect" value={start} onChange={(event) => restart(event.target.value)}>
              {startNode && !startNode.entry ? <option value={startNode.id}>{startNode.question}</option> : null}
              {starts.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.question}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button type="button" className="hdDrawerButton" onClick={() => restart()}>
          {t(locale, 'helpDesk.chatPreview.restart')}
        </button>
      </div>

      {state.kind === 'loading' ? <p className="hdGraphHint">{t(locale, 'helpDesk.releases.loading')}</p> : null}
      {state.kind === 'failed' ? (
        <div className="hdNotice hdDrawerNotice hdDrawerAlert" role="alert">
          {errorMessage(locale, state.code)}
        </div>
      ) : null}
      {state.kind === 'ready' && starts.length === 0 && !startNode ? <p className="hdGraphHint">{t(locale, 'helpDesk.chatPreview.empty')}</p> : null}
      {state.kind === 'ready' && startNode && !startNode.entry ? (
        <p className="hdGraphHint">{t(locale, 'helpDesk.chatPreview.notEntry')}</p>
      ) : null}

      {graph ? (
        <ol className="hdChatLog" role="log" aria-live="polite" aria-label={t(locale, 'helpDesk.chatPreview.transcript')} lang={language}>
          {entries.map((entry, index) => {
            const turn = previewTurn(graph, entry.nodeId, language)
            return (
              <li key={`${index}-${entry.nodeId}`} className="hdChatTurn">
                <div className="hdChatBubble hdChatLearner">
                  <span className="hdSrOnly">{t(locale, 'helpDesk.chatPreview.learner')}: </span>
                  {learnerText(entry)}
                </div>
                <div className="hdChatBubble hdChatAssistant">
                  <span className="hdSrOnly">{t(locale, 'helpDesk.chatPreview.assistant')}: </span>
                  {assistant(turn, index)}
                </div>
              </li>
            )
          })}
        </ol>
      ) : null}
      {graph ? <p className="hdGraphHint">{t(locale, 'helpDesk.chatPreview.handover')}</p> : null}
    </div>
  )
}
