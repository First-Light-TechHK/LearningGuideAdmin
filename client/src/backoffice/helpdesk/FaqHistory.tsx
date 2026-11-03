import { useEffect, useId, useState } from 'react'

import type { FaqChange } from '../contracts/helpdesk'
import { listFaqHistory } from '../lib/helpdeskApi'
import { actionLabel, changeDateTime, changeSummary, personName, personRole, subjectLabel } from '../lib/helpdeskChanges'
import { errorMessage } from '../lib/helpdeskFormat'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import { ChangeDiff } from './ChangeDetailsDrawer'

/**
 * FAQ 抽屉的「History」页签（Figma 草案 2.8）：这条 FAQ、它的追问 / 选项（作为父或子）与问法每一次保存的改动，
 * 新的在前；中间插入「Went live」（它的改动随哪一版发布）。每一条可展开看改前改后（与改动详情同一个 ChangeDiff）。
 * 一次读 50 条，「Show more」再读；超过服务端一次读出的上限时提示去 Change Log 看全部。
 * total 交给抽屉显示在页签上「History (N)」。refreshKey 变了（抽屉里保存过）重新读。
 */

const PAGE = 50

type Props = {
  locale: Locale
  faqId: string
  refreshKey: number
  onTotal: (total: number) => void
}

export function FaqHistory({ locale, faqId, refreshKey, onTotal }: Props) {
  const uid = useId()
  const [changes, setChanges] = useState<FaqChange[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [open, setOpen] = useState<string[]>([])

  useEffect(() => {
    let live = true
    setLoading(true)
    void listFaqHistory(faqId, 1, PAGE).then((result) => {
      if (!live) return
      setLoading(false)
      if (!result.ok) return setErrorCode(result.code)
      setErrorCode(null)
      // 回来的形状不对（旧服务端、代理页）也不能把整个抽屉弄崩
      const rows = Array.isArray(result.data?.changes) ? result.data.changes : []
      const count = Number.isFinite(result.data?.total) ? result.data.total : rows.length
      setChanges(rows)
      setTotal(count)
      setTruncated(result.data?.truncated === true)
      setPage(1)
      onTotal(count)
    })
    return () => {
      live = false
    }
    // onTotal 是父组件每次渲染新建的回调，不算依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [faqId, refreshKey])

  async function more() {
    setLoading(true)
    const result = await listFaqHistory(faqId, page + 1, PAGE)
    setLoading(false)
    if (!result.ok) return setErrorCode(result.code)
    const rows = Array.isArray(result.data?.changes) ? result.data.changes : []
    setChanges((current) => [...current, ...rows.filter((c) => !current.some((seen) => seen.id === c.id))])
    if (Number.isFinite(result.data?.total)) setTotal(result.data.total)
    setPage(page + 1)
  }

  const toggle = (id: string) => setOpen((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]))

  return (
    <div className="hdHistory">
      <p className="hdGraphHint">{t(locale, 'helpDesk.changes.history.hint')}</p>
      {errorCode ? (
        <div className="hdNotice hdDrawerNotice hdDrawerAlert" role="alert">
          {errorMessage(locale, errorCode)}
        </div>
      ) : null}
      {truncated ? <p className="hdNotice hdDrawerNotice">{t(locale, 'helpDesk.changes.history.truncated', { count: total })}</p> : null}
      {!loading && !errorCode && changes.length === 0 ? <p className="hdMuted">{t(locale, 'helpDesk.changes.history.empty')}</p> : null}
      <ol className="hdHistoryList" aria-busy={loading}>
        {changes.map((change) => {
          const wentLive = change.subject === 'release'
          const expanded = open.includes(change.id)
          const panel = `${uid}-${change.id}`
          const title = wentLive
            ? t(locale, 'helpDesk.changes.history.wentLive')
            : change.subject === 'faq'
              ? actionLabel(locale, change)
              : `${subjectLabel(locale, change)} ${actionLabel(locale, change).toLocaleLowerCase(locale)}`
          const role = personRole(locale, change)
          const canExpand = !wentLive && (change.changes.length > 0 || change.subject === 'phrasing')
          return (
            <li key={change.id} className={`hdHistoryItem${wentLive ? ' hdHistoryLive' : ''}`}>
              <span className="hdHistoryDot" aria-hidden="true" />
              <div className="hdHistoryMain">
                <div className="hdHistoryLine">
                  <span className="hdChangesStrong">{title}</span>
                  <span className="hdChangesSub">{changeDateTime(change.at, locale)}</span>
                </div>
                <div className="hdChangesSub">{[personName(locale, change), role].filter(Boolean).join(' · ')}</div>
                <div className="hdHistorySummary">
                  {wentLive
                    ? t(locale, 'helpDesk.changes.history.wentLiveLine', {
                        version: change.release?.version ?? '',
                      })
                    : changeSummary(locale, change)}
                </div>
                {canExpand ? (
                  <button
                    type="button"
                    className="hdLinkButton hdHistoryToggle"
                    aria-expanded={expanded}
                    aria-controls={panel}
                    onClick={() => toggle(change.id)}
                  >
                    {t(locale, expanded ? 'helpDesk.changes.history.hide' : 'helpDesk.changes.history.view')}
                  </button>
                ) : null}
                {expanded ? (
                  <div id={panel} className="hdHistoryDiff">
                    <ChangeDiff locale={locale} change={change} />
                  </div>
                ) : null}
              </div>
            </li>
          )
        })}
      </ol>
      {loading ? <p className="hdMuted">{t(locale, 'helpDesk.changes.history.loading')}</p> : null}
      {!loading && changes.length < total && !truncated ? (
        <button type="button" className="hdDrawerButton" onClick={() => void more()}>
          {t(locale, 'helpDesk.changes.history.more')}
        </button>
      ) : null}
    </div>
  )
}
