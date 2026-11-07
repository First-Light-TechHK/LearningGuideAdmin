import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import '../students.css'
import { Pagination } from '../components/Pagination';
import { usePageSize } from '../components/paginationState';
import { SearchIcon } from '../components/icons'
import { StudentDrawer } from '../components/StudentDrawer'
import {
  SPECIAL_FILTERS,
  STATUS_FILTERS,
  SUBSCRIPTION_FILTERS,
  type SpecialFilter,
  type StatusFilter,
  type StudentList,
  type StudentListItem,
  type SubscriptionFilter,
} from '../contracts/students'
import { t } from '../lib/i18n/messages'
import type { Locale } from '../lib/i18n/config'
import { useLocale } from '../lib/navigation'
import { studentsApi, type StudentFilters } from '../lib/studentsApi'
import { formatStudentDate, initialOf, studentErrorText } from '../lib/studentsFormat'
import { canViewMenu, isActionAllowed, settingsSubHref } from '../rbac/permissions'
import { useEmployee } from '../employeeSession';
import { MenuGuard } from './ModulePages'

const EMPTY_FILTERS: StudentFilters = { q: '', status: 'all', subscription: 'all', special: 'all' }

function subscriptionText(locale: Locale, item: StudentListItem): string {
  const { count, label, state } = item.subscription
  if (count === 0 || !label) return t(locale, 'students.noSubscription')
  const head = `${label} · ${state ? t(locale, `students.subState.${state}`) : ''}`
  return count > 1 ? `${head} (+${count - 1})` : head
}

function specialText(locale: Locale, item: StudentListItem): string {
  const list = item.specialAccess
  if (list.length === 0) return t(locale, 'students.none')
  if (list.length > 1) return t(locale, 'students.featuresEnabled', { count: list.length })
  const [only] = list
  const name = t(locale, `students.feature.${only!.feature}`)
  return only!.value === 'deny' ? t(locale, 'students.denied', { feature: name }) : name
}

/** Student Management 列表（Figma 1423:3）。详情抽屉用 ?student=<id> 打开，可直接分享链接。 */
export function StudentManagementPage() {
  return (
    <MenuGuard menu="student">
      <StudentManagementInner />
    </MenuGuard>
  )
}

function StudentManagementInner() {
  const locale = useLocale()
  const employee = useEmployee()
  const canWrite = isActionAllowed(employee.role, 'student', 'CREATE')
  const [params, setParams] = useSearchParams()
  const openId = params.get('student')

  const [filters, setFilters] = useState<StudentFilters>(EMPTY_FILTERS)
  const [query, setQuery] = useState<StudentFilters>(EMPTY_FILTERS)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = usePageSize('students')
  const [data, setData] = useState<StudentList | null>(null)
  const [loading, setLoading] = useState(true)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const requestId = useRef(0)

  const fetchLoad = useCallback(() => {
    const id = ++requestId.current
    return studentsApi.list(query, page, pageSize).then((result) => {
      if (id !== requestId.current) return
      setLoading(false)
      if (result.ok) {
        setData(result.data)
        setErrorCode(null)
        // 筛选后总数变少时，当前页可能越界
        const lastPage = Math.max(1, Math.ceil(result.data.total / pageSize))
        if (page > lastPage) setPage(lastPage)
      } else {
        setErrorCode(result.code)
      }
    })
  }, [query, page, pageSize])

  const [loadSource, setLoadSource] = useState(() => ({ query, page, pageSize }))
  if (loadSource.query !== query || loadSource.page !== page || loadSource.pageSize !== pageSize) {
    setLoadSource({ query, page, pageSize })
    setLoading(true)
  }
  const load = useCallback(() => {
    setLoading(true)
    return fetchLoad()
  }, [fetchLoad])

  useEffect(() => {
    void fetchLoad();
  }, [fetchLoad]);

  // 搜索框 300ms 防抖；下拉立即生效
  useEffect(() => {
    if (filters.q === query.q) return
    const timer = window.setTimeout(() => {
      setQuery((prev) => ({ ...prev, q: filters.q }))
      setPage(1)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [filters.q, query.q])

  function selectFilter<K extends 'status' | 'subscription' | 'special'>(key: K, value: StudentFilters[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }))
    setQuery((prev) => ({ ...prev, [key]: value }))
    setPage(1)
  }

  function resetFilters() {
    setFilters(EMPTY_FILTERS)
    setQuery(EMPTY_FILTERS)
    setPage(1)
  }

  function openStudent(id: string | null) {
    const next = new URLSearchParams(params)
    if (id) next.set('student', id)
    else next.delete('student')
    setParams(next, { replace: !id })
  }

  const filtered = query.q !== '' || query.status !== 'all' || query.subscription !== 'all' || query.special !== 'all'
  const items = data?.items ?? []

  return (
    <section className="card cardGrow" data-testid="students-page">
      <div className="pageHead">
        <div>
          <h1 className="cardTitle">{t(locale, 'students.title')}</h1>
          <p className="cardSubtitle">{t(locale, 'students.subtitle')}</p>
        </div>
        {canViewMenu(employee.role, 'settings') ? (
          <Link className="button buttonGhost buttonCompact" to={settingsSubHref(locale, 'learningAccess')}>
            {t(locale, 'students.featureSettings')} →
          </Link>
        ) : null}
      </div>

      <div className="filters smFilters">
        <label className="searchField">
          <SearchIcon size={15} />
          <input
            type="search"
            placeholder={t(locale, 'students.searchPlaceholder')}
            aria-label={t(locale, 'students.searchLabel')}
            value={filters.q}
            maxLength={120}
            onChange={(event) => setFilters((prev) => ({ ...prev, q: event.target.value }))}
          />
        </label>
        <select
          className="filterSelect"
          aria-label={t(locale, 'students.statusFilter')}
          value={filters.status}
          onChange={(event) => selectFilter('status', event.target.value as StatusFilter)}
        >
          {STATUS_FILTERS.map((value) => (
            <option key={value} value={value}>{t(locale, `students.status.${value}`)}</option>
          ))}
        </select>
        <select
          className="filterSelect"
          aria-label={t(locale, 'students.subscriptionFilter')}
          value={filters.subscription}
          onChange={(event) => selectFilter('subscription', event.target.value as SubscriptionFilter)}
        >
          {SUBSCRIPTION_FILTERS.map((value) => (
            <option key={value} value={value}>{t(locale, `students.subscriptionOption.${value}`)}</option>
          ))}
        </select>
        <select
          className="filterSelect"
          aria-label={t(locale, 'students.specialFilter')}
          value={filters.special}
          onChange={(event) => selectFilter('special', event.target.value as SpecialFilter)}
        >
          {SPECIAL_FILTERS.map((value) => (
            <option key={value} value={value}>{t(locale, `students.specialOption.${value}`)}</option>
          ))}
        </select>
        <button type="button" className="linkButton smReset" onClick={resetFilters} disabled={!filtered && filters.q === ''}>
          {t(locale, 'students.reset')}
        </button>
      </div>

      {errorCode ? (
        <div className="alert alertError" role="alert" data-testid="students-error">
          {errorCode === 'STUDENTS_NOT_CONNECTED' ? t(locale, 'students.notConnected') : studentErrorText(locale, errorCode)}{' '}
          <button type="button" className="linkButton" onClick={() => void load()}>
            {t(locale, 'students.retry')}
          </button>
        </div>
      ) : null}

      <div className="tableWrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t(locale, 'students.col.student')}</th>
              <th>{t(locale, 'students.col.email')}</th>
              <th>{t(locale, 'students.col.status')}</th>
              <th>{t(locale, 'students.col.subscription')}</th>
              <th>{t(locale, 'students.col.special')}</th>
              <th>{t(locale, 'students.col.registered')}</th>
              <th>{t(locale, 'students.col.action')}</th>
            </tr>
          </thead>
          <tbody>
            {loading && !data ? (
              <tr><td colSpan={7}>{t(locale, 'students.loading')}</td></tr>
            ) : null}
            {!loading && data && items.length === 0 ? (
              <tr><td colSpan={7} data-testid="students-empty">{t(locale, filtered ? 'students.empty' : 'students.emptyAll')}</td></tr>
            ) : null}
            {items.map((item) => (
              <tr key={item.id} data-testid="student-row">
                <td>
                  <span className="smStudentCell">
                    <span className="smAvatar" aria-hidden="true">{initialOf(item.name)}</span>
                    <span className="smName">{item.name}</span>
                  </span>
                </td>
                <td>
                  {item.email ?? <span className="smMuted">{t(locale, 'students.noEmail')}</span>}
                  {item.email && item.emailVerification === 'pending' ? (
                    <span className="smSub">{t(locale, 'students.pendingShort')}</span>
                  ) : null}
                </td>
                <td>
                  <span className={item.accountStatus === 'active' ? 'smPill smPillActive' : 'smPill smPillInactive'}>
                    {t(locale, `students.accountStatus.${item.accountStatus}`)}
                  </span>
                </td>
                <td className={item.subscription.count === 0 ? 'smMuted' : undefined}>{subscriptionText(locale, item)}</td>
                <td className={item.specialAccess.length ? 'smSpecial' : 'smMuted'}>{specialText(locale, item)}</td>
                <td>{formatStudentDate(item.registeredAt, locale)}</td>
                <td>
                  <button
                    type="button"
                    className="smLinkButton"
                    aria-label={t(locale, 'students.viewStudent', { name: item.name })}
                    onClick={() => openStudent(item.id)}
                  >
                    {t(locale, 'students.view')} →
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination
        locale={locale}
        page={page}
        pageSize={pageSize}
        total={data ? data.total : null}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size)
          setPage(1)
        }}
      />

      {openId ? (
        <StudentDrawer
          key={openId}
          studentId={openId}
          canWrite={canWrite}
          onClose={() => openStudent(null)}
          onChanged={() => void load()}
        />
      ) : null}
    </section>
  )
}
