import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'

import type { HelpdeskFaq } from '../contracts/helpdesk'
import { FAQ_CATEGORY_SWATCH } from '../lib/helpdeskFaqs'
import { faqCategoryLabel } from '../lib/helpdeskFormat'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import { MarkdownView } from './Markdown'
import { useModal } from './useModal'

/**
 * FAQ Preview（Tickets v2 §3a）：按 Help Centre 的样子显示一条 FAQ，可在 EN / 中文 之间切换
 * （缺省跟随界面语言）。答案经同一个安全渲染器（Markdown.tsx）。Figma 没有画板（待视觉验收）。
 * 模态层（useModal）：Tab 不出 Preview，Escape 在哪儿按都关。
 * v5 问题树的入口放在这里（所有角色都能看 Preview），不占 Figma 1379:2 表格的操作列（Edit / Preview 两个）。
 */

type PreviewLocale = 'en-GB' | 'zh-CN'
const LANGUAGES: { value: PreviewLocale; key: string }[] = [
  { value: 'en-GB', key: 'helpDesk.preview.en' },
  { value: 'zh-CN', key: 'helpDesk.preview.zh' },
]

export function FaqPreview({ locale, faq, onClose, onTree }: { locale: Locale; faq: HelpdeskFaq; onClose: () => void; onTree?: () => void }) {
  const uid = useId()
  const [language, setLanguage] = useState<PreviewLocale>(locale === 'zh-CN' ? 'zh-CN' : 'en-GB')
  const closeRef = useRef<HTMLButtonElement>(null)
  const radios = useRef<(HTMLButtonElement | null)[]>([])
  const dialogRef = useRef<HTMLDivElement>(null)
  useModal(() => dialogRef.current, onClose)

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    return () => opener?.focus?.()
  }, [])

  function onRadioKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const next = (index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + LANGUAGES.length) % LANGUAGES.length
    setLanguage(LANGUAGES[next].value)
    radios.current[next]?.focus()
  }

  const zh = language === 'zh-CN'
  const swatch = FAQ_CATEGORY_SWATCH[faq.category] ?? FAQ_CATEGORY_SWATCH.other

  return (
    <div className="hdModalLayer">
      <div className="hdModalBackdrop" aria-hidden="true" onClick={onClose} />
      <div ref={dialogRef} className="hdPreview" role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`}>
        <header className="hdPreviewHead">
          <div className="hdDrawerHeading">
            <h2 className="hdDrawerTitle" id={`${uid}-title`}>
              {t(locale, 'helpDesk.preview.title')}
            </h2>
            <p className="hdDrawerSubtitle">{t(locale, 'helpDesk.preview.hint')}</p>
          </div>
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
          <button
            ref={closeRef}
            type="button"
            className="hdDrawerClose"
            aria-label={t(locale, 'helpDesk.drawer.close')}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <article className="hdPreviewBody" lang={language}>
          <span className="hdFaqChip" style={{ background: swatch.bg, color: swatch.fg }}>
            {faqCategoryLabel(language, faq.category)}
          </span>
          <h3 className="hdPreviewQuestion">{zh ? faq.questionZh : faq.questionEn}</h3>
          <MarkdownView className="hdPreviewAnswer" text={zh ? faq.answerZh : faq.answerEn} />
        </article>
        {onTree ? (
          <footer className="hdPreviewFoot">
            <button
              type="button"
              className="hdFaqPreview"
              aria-label={t(locale, 'helpDesk.faqs.treeLabel', { question: locale === 'zh-CN' ? faq.questionZh : faq.questionEn })}
              onClick={onTree}
            >
              {t(locale, 'helpDesk.preview.tree')}
            </button>
          </footer>
        ) : null}
      </div>
    </div>
  )
}
