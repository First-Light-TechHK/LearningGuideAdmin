import { useEffect, useId, useRef, useState } from 'react'

import { INSTRUCTION_MAX, type CardHistory, type CardVersion } from '../lib/helpdeskVersions'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'

/**
 * 像 Claude Artifact 那样改卡：
 * - VersionBar：卡片面板右上角「‹ 版本 3 / 3 ›」，旁边一句这个版本从哪来（AI 初稿 / 你改的 / AI 按「…」改）；
 * - AiComposer：面板底下的输入框，样式照 Gemini（圆角胶囊、浅底、聚焦时彩色光环，发送键在框里）；
 *   跟 AI 说怎么改，AI 就地改这张卡、生成新版本；选中一段文字时只改那一段。还有几个常用指令一点就发。
 * 没有 Figma，待视觉验收。
 */

function versionNote(locale: Locale, version: CardVersion, startKey: string): string {
  if (version.origin === 'start') return t(locale, startKey)
  if (version.origin === 'manual') return t(locale, 'helpDesk.review.assist.manual')
  return t(locale, 'helpDesk.review.assist.byAi', { instruction: version.instruction ?? '' })
}

type BarProps = { locale: Locale; history: CardHistory; startKey: string; onGoTo: (index: number) => void; disabled?: boolean }

export function VersionBar({ locale, history, startKey, onGoTo, disabled = false }: BarProps) {
  const total = history.versions.length
  const version = history.versions[history.at]
  return (
    <div className="hdVersionBar" role="group" aria-label={t(locale, 'helpDesk.review.assist.versions')}>
      <button
        type="button"
        className="hdVersionStep"
        aria-label={t(locale, 'helpDesk.review.assist.previous')}
        disabled={disabled || history.at === 0}
        onClick={() => onGoTo(history.at - 1)}
      >
        ‹
      </button>
      <span className="hdVersionCount" aria-live="polite">
        {t(locale, 'helpDesk.review.assist.versionOf', { n: version.n, total })}
      </span>
      <button
        type="button"
        className="hdVersionStep"
        aria-label={t(locale, 'helpDesk.review.assist.next')}
        disabled={disabled || history.at === total - 1}
        onClick={() => onGoTo(history.at + 1)}
      >
        ›
      </button>
      <span className={`hdVersionNote hdVersionNote-${version.origin}`} title={versionNote(locale, version, startKey)}>
        {version.origin === 'ai' ? (
          <span className="hdSpark" aria-hidden="true">
            ✦
          </span>
        ) : null}
        {versionNote(locale, version, startKey)}
      </span>
    </div>
  )
}

const QUICK = ['shorter', 'friendlier', 'steps', 'translate'] as const

type ComposerProps = {
  locale: Locale
  busy: boolean
  disabled?: boolean
  /** 选中的文字（只改这一段）；null 表示改整张卡。 */
  selection: string | null
  onClearSelection: () => void
  onSend: (instruction: string) => Promise<boolean>
  error: string | null
}

export function AiComposer({ locale, busy, disabled = false, selection, onClearSelection, onSend, error }: ComposerProps) {
  const uid = useId()
  const [text, setText] = useState('')
  const area = useRef<HTMLTextAreaElement>(null)
  const clean = text.trim()
  const tooLong = [...clean].length > INSTRUCTION_MAX

  // 高度跟着内容长（最多 5 行），像 Gemini
  useEffect(() => {
    const node = area.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 132)}px`
  }, [text])

  async function send(instruction: string) {
    if (busy || disabled || !instruction.trim() || [...instruction.trim()].length > INSTRUCTION_MAX) return
    const ok = await onSend(instruction.trim())
    if (ok) setText('')
  }

  return (
    <div className={`hdComposerWrap${busy ? ' hdComposerBusy' : ''}`}>
      <div className="hdComposerQuick" role="group" aria-label={t(locale, 'helpDesk.review.assist.quick')}>
        {QUICK.map((key) => (
          <button
            key={key}
            type="button"
            className="hdComposerChip"
            disabled={busy || disabled}
            onClick={() => void send(t(locale, `helpDesk.review.assist.quickText.${key}`))}
          >
            {t(locale, `helpDesk.review.assist.quickLabel.${key}`)}
          </button>
        ))}
      </div>
      <div className="hdComposer">
        {selection ? (
          <div className="hdComposerScope">
            <span className="hdComposerScopeText">{t(locale, 'helpDesk.review.assist.onlySelection', { text: selection })}</span>
            <button
              type="button"
              className="hdComposerScopeClear"
              aria-label={t(locale, 'helpDesk.review.assist.wholeCard')}
              onClick={onClearSelection}
            >
              ×
            </button>
          </div>
        ) : null}
        <div className="hdComposerRow">
          <label className="hdSrOnly" htmlFor={`${uid}-ask`}>
            {t(locale, 'helpDesk.review.assist.label')}
          </label>
          <textarea
            ref={area}
            id={`${uid}-ask`}
            className="hdComposerInput"
            rows={1}
            value={text}
            disabled={disabled}
            readOnly={busy}
            placeholder={t(locale, busy ? 'helpDesk.review.assist.working' : 'helpDesk.review.assist.placeholder')}
            aria-invalid={tooLong || undefined}
            aria-describedby={error || tooLong ? `${uid}-err` : `${uid}-hint`}
            title={t(locale, 'helpDesk.review.assist.hint')}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              // Enter 发送，Shift+Enter 换行；Ctrl/⌘+Enter 留给页面的主按钮
              if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                event.stopPropagation()
                void send(text)
              }
            }}
          />
          <button
            type="button"
            className={`hdComposerSend${clean && !tooLong ? ' hdComposerSendReady' : ''}`}
            aria-label={t(locale, 'helpDesk.review.assist.send')}
            disabled={busy || disabled || !clean || tooLong}
            onClick={() => void send(text)}
          >
            {busy ? <span className="hdComposerSpinner" aria-hidden="true" /> : <span aria-hidden="true">↑</span>}
          </button>
        </div>
      </div>
      {error || tooLong ? (
        <p className="hdFieldError" id={`${uid}-err`} role="alert">
          {tooLong ? t(locale, 'helpDesk.review.assist.tooLong', { max: INSTRUCTION_MAX }) : error}
        </p>
      ) : (
        <p className="hdComposerHint" id={`${uid}-hint`}>
          {t(locale, 'helpDesk.review.assist.hint')}
        </p>
      )}
    </div>
  )
}
