import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { FAQ_CATEGORIES, type FaqCategory, type HelpdeskFaq } from '../contracts/helpdesk'
import { listFaqs } from '../lib/helpdeskApi'
import {
  FAQ_CATEGORY_SWATCH,
  FAQ_LIMITS,
  pageWindow,
  readFaqFilters,
  showingRange,
  writeFaqFilters,
  type FaqFilters,
  type PopularFilter,
} from '../lib/helpdeskFaqs'
import { errorMessage, faqCategoryLabel } from '../lib/helpdeskFormat'
import { summaryLine } from '../lib/helpdeskMarkdown'
import { longDate } from '../lib/helpdeskView'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import { HdSearchIcon } from './icons'

/**
 * FAQs Tab（Tickets v2 §3a，Figma 1379:2）：搜索 + 分类 + 热门筛选、表格、分页。
 * 筛选与页码都在地址栏（?tab=faqs&q=&category=&popular=&page=），刷新 / 分享不丢。
 * 写操作（Edit）只给 FULL；Preview 所有能进 Help Desk 的角色都能用。
 */

const POPULAR_FILTERS: PopularFilter[] = ['all', 'popular', 'not_popular']

type Props = {
  locale: Locale
  canWrite: boolean
  /** 抽屉保存 / 删除后父组件递增，触发刷新。 */
  refreshKey: number
  onEdit: (faq: HelpdeskFaq) => void
  onPreview: (faq: HelpdeskFaq) => void
}

type Loaded = { faqs: HelpdeskFaq[]; total: number }

export function FaqsView({ locale, canWrite, refreshKey, onEdit, onPreview }: Props) {
  const [searchParams, setSearchParams] = useSearchParams()
  const filters = readFaqFilters(searchParams)
  // 只在筛选真的变了时重新请求（地址栏里别的参数变化不算）
  const filterKey = JSON.stringify(filters)
  const [search, setSearch] = useState(filters.q)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  // 最近一次回来的请求属于哪组筛选：和当前不同就是「加载中」
  const [settledFor, setSettledFor] = useState<string | null>(null)
  const requestKey = `${filterKey}#${refreshKey}`
  const loading = settledFor !== requestKey
  const request = useRef(0)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const id = ++request.current
    void listFaqs(JSON.parse(filterKey) as FaqFilters).then((result) => {
      if (id !== request.current) return
      if (result.ok) {
        setLoaded({ faqs: result.data.faqs, total: result.data.total })
        setErrorCode(null)
      } else {
        setErrorCode(result.code)
      }
      setSettledFor(`${filterKey}#${refreshKey}`)
    })
  }, [filterKey, refreshKey])

  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    },
    [],
  )

  // 最新的地址栏参数：react-router 的 setSearchParams 函数式更新拿到的是「创建它那次渲染」的参数，
  // 防抖 300ms 后的搜索若用它，会把这期间改过的分类 / 热门筛选覆盖掉（跨应用联调发现）
  const latestParams = useRef(searchParams)
  useEffect(() => {
    latestParams.current = searchParams
  }, [searchParams])

  function update(patch: Partial<FaqFilters>, replace = false) {
    // 换筛选回到第一页；只翻页时保留其它筛选
    const next = writeFaqFilters(latestParams.current, 'page' in patch ? patch : { ...patch, page: 1 })
    latestParams.current = next
    setSearchParams(next, { replace })
  }

  function onSearch(value: string) {
    setSearch(value)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => update({ q: value.slice(0, FAQ_LIMITS.searchMax) }, true), 300)
  }

  const rows = loaded?.faqs ?? []
  const total = loaded?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / FAQ_LIMITS.pageSize))
  const range = showingRange(filters.page, FAQ_LIMITS.pageSize, total)
  const filtered = filters.q !== '' || filters.category !== 'all' || filters.popular !== 'all'
  const zh = locale === 'zh-CN'

  return (
    <div className="hdFaqs">
      <div className="hdFaqFilters">
        <label className="hdFaqSearch">
          <HdSearchIcon size={10} className="hdFaqSearchIcon" />
          <input
            type="search"
            value={search}
            maxLength={FAQ_LIMITS.searchMax}
            placeholder={t(locale, 'helpDesk.faqs.search')}
            aria-label={t(locale, 'helpDesk.faqs.search')}
            onChange={(event) => onSearch(event.target.value)}
          />
        </label>
        <select
          className="hdFaqSelect hdFaqSelectCategory"
          aria-label={t(locale, 'helpDesk.faqs.columns.category')}
          value={filters.category}
          onChange={(event) => update({ category: event.target.value as FaqCategory | 'all' })}
        >
          <option value="all">{t(locale, 'helpDesk.faqs.allCategories')}</option>
          {FAQ_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {faqCategoryLabel(locale, category)}
            </option>
          ))}
        </select>
        <select
          className="hdFaqSelect hdFaqSelectPopular"
          aria-label={t(locale, 'helpDesk.faqs.columns.popular')}
          value={filters.popular}
          onChange={(event) => update({ popular: event.target.value as PopularFilter })}
        >
          {POPULAR_FILTERS.map((value) => (
            <option key={value} value={value}>
              {t(locale, `helpDesk.faqs.popularFilter.${value}`)}
            </option>
          ))}
        </select>
        {loaded ? (
          <span className="hdFaqCount" aria-live="polite">
            {total === 1 ? t(locale, 'helpDesk.faqs.countOne') : t(locale, 'helpDesk.faqs.count', { count: total })}
          </span>
        ) : null}
      </div>

      {errorCode ? (
        <div className="hdNotice hdFaqError" role="alert">
          {errorMessage(locale, errorCode)}
        </div>
      ) : null}

      <div className="hdFaqTableWrap" aria-busy={loading}>
        <table className="hdFaqTable">
          <colgroup>
            <col className="hdFaqColQuestion" />
            <col className="hdFaqColCategory" />
            <col className="hdFaqColPopular" />
            <col className="hdFaqColUpdated" />
            <col className="hdFaqColAction" />
          </colgroup>
          <thead>
            <tr>
              {(['question', 'category', 'popular', 'updated', 'action'] as const).map((column) => (
                <th key={column} scope="col">
                  {t(locale, `helpDesk.faqs.columns.${column}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((faq) => {
              const question = zh ? faq.questionZh : faq.questionEn
              const swatch = FAQ_CATEGORY_SWATCH[faq.category] ?? FAQ_CATEGORY_SWATCH.other
              return (
                <tr key={faq.id}>
                  <td>
                    <div className="hdFaqQuestion">{question}</div>
                    <div className="hdFaqSummary">{summaryLine(zh ? faq.answerZh : faq.answerEn)}</div>
                  </td>
                  <td>
                    <span
                      className="hdFaqChip"
                      data-category={faq.category}
                      style={{ background: swatch.bg, color: swatch.fg }}
                    >
                      {faqCategoryLabel(locale, faq.category)}
                    </span>
                  </td>
                  <td>
                    <span className={`hdFaqChip ${faq.popular ? 'hdFaqChipYes' : 'hdFaqChipNo'}`}>
                      {t(locale, faq.popular ? 'helpDesk.faqs.yes' : 'helpDesk.faqs.no')}
                    </span>
                  </td>
                  <td className="hdFaqDate">{longDate(faq.updatedAt, locale)}</td>
                  <td>
                    <div className="hdFaqActions">
                      {canWrite ? (
                        <button
                          type="button"
                          className="hdFaqEdit"
                          aria-label={t(locale, 'helpDesk.faqs.editLabel', { question })}
                          onClick={() => onEdit(faq)}
                        >
                          {t(locale, 'helpDesk.faqs.edit')}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="hdFaqPreview"
                        aria-label={t(locale, 'helpDesk.faqs.previewLabel', { question })}
                        onClick={() => onPreview(faq)}
                      >
                        {t(locale, 'helpDesk.faqs.preview')}
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
            {loaded && rows.length === 0 && !errorCode ? (
              <tr>
                <td colSpan={5} className="hdFaqEmpty">
                  {t(locale, filtered ? 'helpDesk.faqs.emptyFiltered' : 'helpDesk.faqs.empty')}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {total > 0 ? (
        <footer className="hdFaqFooter">
          <span>{t(locale, 'helpDesk.faqs.showing', { from: range.from, to: range.to, total })}</span>
          <nav className="hdFaqPages" aria-label={t(locale, 'helpDesk.faqs.pagination')}>
            {filters.page > 1 ? (
              <button
                type="button"
                className="hdFaqPageStep"
                aria-label={t(locale, 'helpDesk.faqs.previous')}
                onClick={() => update({ page: filters.page - 1 })}
              >
                ‹
              </button>
            ) : null}
            {pageWindow(Math.min(filters.page, totalPages), totalPages).map((item, index) =>
              item === 'gap' ? (
                <span key={`gap-${index}`} className="hdFaqPageGap" aria-hidden="true">
                  …
                </span>
              ) : (
                <button
                  key={item}
                  type="button"
                  className={`hdFaqPage${item === filters.page ? ' hdFaqPageActive' : ''}`}
                  aria-label={t(locale, 'helpDesk.faqs.page', { page: item })}
                  aria-current={item === filters.page ? 'page' : undefined}
                  onClick={() => (item === filters.page ? undefined : update({ page: item }))}
                >
                  {item}
                </button>
              ),
            )}
            <button
              type="button"
              className="hdFaqPageStep"
              aria-label={t(locale, 'helpDesk.faqs.next')}
              disabled={filters.page >= totalPages}
              onClick={() => update({ page: filters.page + 1 })}
            >
              ›
            </button>
          </nav>
        </footer>
      ) : null}
    </div>
  )
}
