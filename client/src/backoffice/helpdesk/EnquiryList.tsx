import { useEffect, useRef, useState } from 'react'

import { HELPDESK_CATEGORIES, LIST_STATUS_FILTERS, type EnquiryRow } from '../contracts/helpdesk'
import { categoryLabel, errorMessage, statusLabel } from '../lib/helpdeskFormat'
import {
  activeFilterCount,
  avatarColor,
  initials,
  listTime,
  type EnquiryFilters,
} from '../lib/helpdeskView'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import { HdFilterIcon, HdSearchIcon } from './icons'

/**
 * 左栏 340px（Figma 1324:2 LeftPanel）：搜索 + 筛选按钮 + 咨询列表（滚动到底自动加载下一页）。
 */

export function LearnerAvatar({ seed, name, email }: { seed: string; name: string; email?: string }) {
  const colour = avatarColor(seed)
  return (
    <span className="hdAvatar" style={{ background: colour.bg, color: colour.fg }} aria-hidden="true">
      {initials(name, email)}
    </span>
  )
}

type Props = {
  locale: Locale
  rows: EnquiryRow[]
  selectedId: string | null
  filters: EnquiryFilters
  query: string
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  errorCode: string | null
  onQueryChange: (value: string) => void
  onFiltersChange: (patch: Partial<EnquiryFilters>) => void
  onSelect: (id: string) => void
  onLoadMore: () => void
}

function FilterPanel({
  locale,
  filters,
  onChange,
  onClose,
}: {
  locale: Locale
  filters: EnquiryFilters
  onChange: (patch: Partial<EnquiryFilters>) => void
  onClose: () => void
}) {
  const [tag, setTag] = useState(filters.tag)
  return (
    <div className="hdFilterPanel" role="dialog" aria-label={t(locale, 'helpDesk.filter')}>
      <label className="hdFilterField">
        <span>{t(locale, 'helpDesk.filters.status')}</span>
        <select
          value={filters.status}
          onChange={(event) => onChange({ status: event.target.value as EnquiryFilters['status'] })}
        >
          {LIST_STATUS_FILTERS.map((value) => (
            <option key={value} value={value}>
              {value === 'all'
                ? t(locale, 'helpDesk.filters.any')
                : value === 'needs_reply'
                  ? t(locale, 'helpDesk.filters.needsReply')
                  : statusLabel(locale, value)}
            </option>
          ))}
        </select>
      </label>
      <label className="hdFilterField">
        <span>{t(locale, 'helpDesk.filters.category')}</span>
        <select
          value={filters.category}
          onChange={(event) => onChange({ category: event.target.value as EnquiryFilters['category'] })}
        >
          <option value="all">{t(locale, 'helpDesk.filters.any')}</option>
          {HELPDESK_CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {categoryLabel(locale, value)}
            </option>
          ))}
        </select>
      </label>
      <label className="hdFilterField">
        <span>{t(locale, 'helpDesk.filters.tag')}</span>
        <input
          value={tag}
          maxLength={32}
          placeholder={t(locale, 'helpDesk.filters.tagPlaceholder')}
          onChange={(event) => setTag(event.target.value)}
          onBlur={() => onChange({ tag })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              onChange({ tag })
            }
          }}
        />
      </label>
      <div className="hdFilterActions">
        <button
          type="button"
          className="hdLinkButton"
          onClick={() => {
            setTag('')
            onChange({ status: 'all', category: 'all', tag: '' })
          }}
        >
          {t(locale, 'helpDesk.filters.clear')}
        </button>
        <button type="button" className="hdLinkButton" onClick={onClose}>
          {t(locale, 'common.close')}
        </button>
      </div>
    </div>
  )
}

export function EnquiryList(props: Props) {
  const { locale, rows, selectedId, filters, loading, loadingMore, hasMore, errorCode } = props
  const [filterOpen, setFilterOpen] = useState(false)
  const listRef = useRef<HTMLUListElement | null>(null)
  const sentinelRef = useRef<HTMLLIElement | null>(null)
  const onLoadMore = props.onLoadMore
  const filterCount = activeFilterCount(filters)

  // 滚动加载：哨兵进入列表可视区（提前 200px）就取下一页
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || !hasMore || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore()
      },
      { root: listRef.current, rootMargin: '200px 0px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, onLoadMore, rows.length])

  const filtered = filters.q !== '' || filterCount > 0
  const now = new Date()

  return (
    <div className="hdList">
      <div className="hdSearchRow">
        <label className="hdSearch">
          <HdSearchIcon />
          <input
            type="search"
            value={props.query}
            maxLength={120}
            placeholder={t(locale, 'helpDesk.searchPlaceholder')}
            aria-label={t(locale, 'helpDesk.searchPlaceholder')}
            onChange={(event) => props.onQueryChange(event.target.value)}
          />
        </label>
        <button
          type="button"
          className={`hdFilterButton${filterCount > 0 ? ' hdFilterButtonActive' : ''}`}
          aria-label={t(locale, 'helpDesk.filter')}
          aria-expanded={filterOpen}
          onClick={() => setFilterOpen((open) => !open)}
        >
          <HdFilterIcon />
          {filterCount > 0 ? <span className="hdFilterCount">{filterCount}</span> : null}
        </button>
        {filterOpen ? (
          <FilterPanel
            locale={locale}
            filters={filters}
            onChange={props.onFiltersChange}
            onClose={() => setFilterOpen(false)}
          />
        ) : null}
      </div>

      {errorCode ? (
        <div className="hdListNotice" role="alert">
          {errorMessage(locale, errorCode)}
        </div>
      ) : null}

      <ul className="hdRows" ref={listRef} aria-busy={loading}>
        {loading && rows.length === 0 ? <li className="hdListNotice">{t(locale, 'common.loading')}</li> : null}
        {!loading && rows.length === 0 && !errorCode ? (
          <li className="hdListNotice">
            {filtered ? t(locale, 'helpDesk.list.emptyFiltered') : t(locale, 'helpDesk.list.empty')}
          </li>
        ) : null}
        {rows.map((row) => {
          const selected = row.id === selectedId
          const name = row.learner.name || row.learner.email
          return (
            <li key={row.id}>
              <button
                type="button"
                className={`hdRow${selected ? ' hdRowSelected' : ''}${row.unreadByAgent ? ' hdRowUnread' : ''}`}
                aria-current={selected ? 'true' : undefined}
                onClick={() => props.onSelect(row.id)}
              >
                <LearnerAvatar seed={row.learner.id || row.id} name={row.learner.name} email={row.learner.email} />
                <span className="hdRowBody">
                  <span className="hdRowTop">
                    <span className="hdRowName">{name}</span>
                    <time className="hdRowTime" dateTime={row.lastMessageAt ?? row.updatedAt}>
                      {listTime(row.lastMessageAt ?? row.updatedAt, locale, now)}
                    </time>
                  </span>
                  <span className="hdRowSubject">{row.subject}</span>
                  <span className="hdRowBottom">
                    <span className="hdRowPreview">{row.preview}</span>
                    {row.unreadByAgent ? (
                      <span className="hdUnreadDot" role="img" aria-label={t(locale, 'helpDesk.list.unread')} />
                    ) : null}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
        {hasMore ? (
          <li ref={sentinelRef} className="hdListNotice">
            {loadingMore ? t(locale, 'helpDesk.list.loadingMore') : ' '}
          </li>
        ) : null}
      </ul>
    </div>
  )
}
