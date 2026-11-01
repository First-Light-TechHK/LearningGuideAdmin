import { useEffect, useId, useRef, useState } from 'react'

import type { FaqNodeSummary } from '../contracts/helpdesk'
import { listFaqs } from '../lib/helpdeskApi'
import { FAQ_LIMITS } from '../lib/helpdeskFaqs'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'

/**
 * 选一个已发布的 FAQ（答案卡）：候选接受成问法时的目标、加成追问时的上一级问题（v5 Part G4，待视觉验收）。
 * 先列出候选建议的节点（最接近的 / 学员当时在看的），再按搜索（FAQ 列表接口，防抖 250ms）补充；
 * 单选按钮组，键盘上下键切换，读屏读出图例。
 */

type Option = { id: string; questionEn: string; questionZh: string }

type Props = {
  locale: Locale
  legend: string
  selected: string | null
  onSelect: (id: string) => void
  /** 先列出的节点（候选建议的）。 */
  suggested: readonly FaqNodeSummary[]
  invalid?: boolean
  describedBy?: string
}

export function FaqPicker({ locale, legend, selected, onSelect, suggested, invalid = false, describedBy }: Props) {
  const uid = useId()
  const zh = locale === 'zh-CN'
  const [query, setQuery] = useState('')
  // 按搜索词存结果：清空搜索框后不显示旧结果（不在 effect 里同步清空）
  const [found, setFound] = useState<{ q: string; options: Option[] } | null>(null)
  const request = useRef(0)
  const q = query.trim()
  const results = q && found?.q === q ? found.options : null

  useEffect(() => {
    const id = ++request.current
    if (!q) return
    const timer = setTimeout(() => {
      void listFaqs({ q: q.slice(0, FAQ_LIMITS.searchMax), category: 'all', popular: 'all', page: 1 }).then((result) => {
        if (id !== request.current) return
        // 只有答案卡能收问法与当上一级问题；选择题不陈述事实
        setFound({
          q,
          options: result.ok ? result.data.faqs.filter((faq) => faq.type !== 'choice' && faq.status === 'published') : [],
        })
      })
    }, 250)
    return () => clearTimeout(timer)
  }, [q])

  const options: Option[] = []
  for (const option of [...suggested.filter((node) => node.status === 'published'), ...(results ?? [])])
    if (!options.some((known) => known.id === option.id)) options.push(option)

  return (
    <fieldset
      className="hdGraphFieldset hdFaqPicker"
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
    >
      <legend className="hdFieldLabel">{legend}</legend>
      <input
        type="search"
        className="hdDrawerInput hdDrawerInputSmall"
        value={query}
        maxLength={FAQ_LIMITS.searchMax}
        aria-label={t(locale, 'helpDesk.candidates.searchFaqs')}
        placeholder={t(locale, 'helpDesk.candidates.searchFaqs')}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="hdFaqPickerOptions">
        {options.map((option) => (
          <label key={option.id} className="hdCheck hdGraphCheck">
            <input
              type="radio"
              className="hdCheckInput hdGraphRadio"
              name={`${uid}-faq`}
              value={option.id}
              checked={selected === option.id}
              onChange={() => onSelect(option.id)}
            />
            <span>{zh ? option.questionZh : option.questionEn}</span>
          </label>
        ))}
      </div>
      {results !== null && results.length === 0 ? <p className="hdGraphHint">{t(locale, 'helpDesk.candidates.noResults')}</p> : null}
    </fieldset>
  )
}
