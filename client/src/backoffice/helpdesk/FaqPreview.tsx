import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'

import type { HelpdeskFaq } from '../contracts/helpdesk'
import { FAQ_CATEGORY_SWATCH } from '../lib/helpdeskFaqs'
import { faqCategoryLabel } from '../lib/helpdeskFormat'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import { MarkdownView } from './Markdown'

/**
 * FAQ Preview（Tickets v2 §3a）：按 Help Centre 的样子显示一条 FAQ，可在 EN / 中文 之间切换
 * （缺省跟随界面语言）。答案经同一个安全渲染器（Markdown.tsx）。Figma 没有画板（待视觉验收）。
 */

type PreviewLocale = 'en-GB' | 'zh-CN'
const LANGUAGES: { value: PreviewLocale; key: string }[] = [
  { value: 'en-GB', key: 'helpDesk.preview.en' },
  { value: 'zh-CN', key: 'helpDesk.preview.zh' },
]

export function FaqPreview({ locale, faq, onClose }: { locale: Locale; faq: HelpdeskFaq; onClose: () => void }) {
  const uid = useId()
  const [language, setLanguage] = useState<PreviewLocale>(locale === 'zh-CN' ? 'zh-CN' : 'en-GB')
  const closeRef = useRef<HTMLButtonElement>(null)
  const radios = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    return () => opener?.focus?.()
  }, [])

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
    }
  }

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
      <div className="hdPreview" role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} onKeyDown={onKeyDown}>
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
      </div>
    </div>
  )
}
