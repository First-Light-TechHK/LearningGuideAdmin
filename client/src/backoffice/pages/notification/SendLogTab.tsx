import { useCallback, useEffect, useState } from 'react'

import { CloseIcon, SearchIcon } from '../../components/icons'
import { Pagination } from '../../components/Pagination'
import type {
  NotificationBroadcast,
  NotificationLogStatus,
  NotificationTemplate,
  SendLogDetailResponse,
  SendLogItem,
} from '../../contracts/notifications'
import { t } from '../../lib/i18n/messages'
import { useLocale } from '../../lib/navigation'
import { notificationsApi } from '../../lib/notificationsApi'
import {
  channelLabel,
  defaultSendLogRange,
  formatHktDateTime,
  notificationErrorText,
} from '../../lib/notificationFormat'

function errorText(
  locale: ReturnType<typeof useLocale>,
  result: { code?: string; message?: string; error?: string },
): string {
  return notificationErrorText((key) => t(locale, key), result)
}

const STATUSES: NotificationLogStatus[] = ['delivered', 'read', 'withdrawn', 'sent', 'failed']

function statusClass(status: NotificationLogStatus): string {
  if (status === 'failed') return 'notificationStatusBadge notificationStatusFailed'
  if (status === 'read' || status === 'delivered') return 'notificationStatusBadge notificationStatusOk'
  if (status === 'sent') return 'notificationStatusBadge notificationStatusSent'
  return 'notificationStatusBadge notificationStatusWithdrawn'
}

function statusText(locale: ReturnType<typeof useLocale>, status: NotificationLogStatus): string {
  const key =
    status === 'delivered'
      ? 'notification.sendLog.statusDelivered'
      : status === 'read'
        ? 'notification.sendLog.statusRead'
        : status === 'withdrawn'
          ? 'notification.sendLog.statusWithdrawn'
          : status === 'sent'
            ? 'notification.sendLog.statusSent'
            : 'notification.sendLog.statusFailed'
  return t(locale, key)
}

/** Tab 3：发送日志（B06）。筛选、列、详情侧栏、Test 标记、180 天说明。 */
export function SendLogTab({
  templates,
  broadcasts,
}: {
  templates: NotificationTemplate[]
  broadcasts: NotificationBroadcast[]
}) {
  const locale = useLocale()
  const initialRange = defaultSendLogRange()
  const [recipient, setRecipient] = useState('')
  const [notification, setNotification] = useState('')
  const [channel, setChannel] = useState('')
  const [status, setStatus] = useState('')
  const [from, setFrom] = useState(initialRange.from)
  const [to, setTo] = useState(initialRange.to)
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<SendLogItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<SendLogDetailResponse | null>(null)

  const load = useCallback(
    async (targetPage = page) => {
      setLoading(true)
      const [kind, id] = notification.split(':')
      const result = await notificationsApi.sendLog({
        recipient: recipient.trim() || undefined,
        template: kind === 'template' ? id : undefined,
        broadcast: kind === 'broadcast' ? id : undefined,
        channel: channel || undefined,
        status: status || undefined,
        from: from || undefined,
        to: to || undefined,
        page: targetPage,
      })
      setLoading(false)
      if (result.success) {
        setItems(result.data.items)
        setTotal(result.data.total)
        setPage(result.data.page)
        setError(null)
      } else {
        setError(errorText(locale, result))
      }
    },
    [channel, from, locale, notification, page, recipient, status, to],
  )

  useEffect(() => {
    void load(1)
    // First load + explicit Search; filters are applied by the button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function openDetail(id: string) {
    const result = await notificationsApi.sendLogDetail(id)
    if (result.success) setDetail(result.data)
    else setError(errorText(locale, result))
  }

  return (
    <div className="notificationTabBody">
      <div className="filters notificationFilters">
        <label className="searchField notificationSearch">
          <SearchIcon size={15} />
          <input
            value={recipient}
            placeholder={t(locale, 'notification.sendLog.searchPlaceholder')}
            onChange={(event) => setRecipient(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void load(1)
            }}
          />
        </label>
        <select
          className="filterSelect"
          value={notification}
          onChange={(event) => setNotification(event.target.value)}
          aria-label={t(locale, 'notification.sendLog.notification')}
        >
          <option value="">{t(locale, 'notification.sendLog.allNotifications')}</option>
          {templates.map((template) => (
            <option key={template.id} value={`template:${template.id}`}>
              {template.name ?? template.en.title ?? template.id}
            </option>
          ))}
          {broadcasts.map((broadcast) => (
            <option key={broadcast.id} value={`broadcast:${broadcast.id}`}>
              {broadcast.titleEn}
            </option>
          ))}
        </select>
        <select
          className="filterSelect notificationChannelFilter"
          value={channel}
          onChange={(event) => setChannel(event.target.value)}
          aria-label={t(locale, 'notification.sendLog.channel')}
        >
          <option value="">{t(locale, 'notification.sendLog.allChannels')}</option>
          <option value="in_app">In-app</option>
          <option value="email">Email</option>
        </select>
        <select
          className="filterSelect notificationChannelFilter"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          aria-label={t(locale, 'notification.sendLog.status')}
        >
          <option value="">{t(locale, 'notification.sendLog.allStatuses')}</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {statusText(locale, value)}
            </option>
          ))}
        </select>
        <span className="notificationDateRange">
          <input
            className="fieldInput notificationDateInput"
            type="date"
            value={from}
            aria-label={t(locale, 'notification.sendLog.from')}
            onChange={(event) => setFrom(event.target.value)}
          />
          <span aria-hidden="true">–</span>
          <input
            className="fieldInput notificationDateInput"
            type="date"
            value={to}
            aria-label={t(locale, 'notification.sendLog.to')}
            onChange={(event) => setTo(event.target.value)}
          />
        </span>
        <button type="button" className="button buttonCompact" onClick={() => void load(1)} disabled={loading}>
          {t(locale, 'notification.sendLog.search')}
        </button>
      </div>

      {error ? (
        <div className="alert alertError" role="alert">
          {error}{' '}
          <button type="button" className="linkButton" onClick={() => void load(page)}>
            {t(locale, 'common.retry')}
          </button>
        </div>
      ) : null}

      <div className="tableWrap">
        <table className="table notificationTable notificationLogTable" data-testid="send-log-table">
          <colgroup>
            <col style={{ width: '17%' }} />
            <col style={{ width: '25%' }} />
            <col style={{ width: '25%' }} />
            <col style={{ width: '9%' }} />
            <col style={{ width: '16%' }} />
            <col style={{ width: '8%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>{t(locale, 'notification.sendLog.sentAt')}</th>
              <th>{t(locale, 'notification.sendLog.recipient')}</th>
              <th>{t(locale, 'notification.sendLog.notification')}</th>
              <th>{t(locale, 'notification.sendLog.channel')}</th>
              <th>{t(locale, 'notification.sendLog.status')}</th>
              <th aria-label={t(locale, 'notification.columns.actions')} />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} data-testid={`send-log-row-${item.id}`}>
                <td className="notificationNoWrap">{formatHktDateTime(item.occurredAt)}</td>
                <td className="notificationRecipientCell">
                  <span>{item.recipientEmail || '—'}</span>
                  {item.recipientName ? <span className="notificationId">{item.recipientName}</span> : null}
                </td>
                <td className="notificationLogNotificationCell">
                  <div>
                    <span>{item.notificationName}</span>
                    {item.isTest ? <span className="smPill smPillWarn notificationTestTag">{t(locale, 'notification.sendLog.test')}</span> : null}
                  </div>
                  {item.templateId ? <div className="notificationId">{item.templateId}</div> : null}
                </td>
                <td>{channelLabel(item.channel)}</td>
                <td>
                  <span className={statusClass(item.status)}>{statusText(locale, item.status)}</span>
                  {item.status === 'failed' && item.failureReason ? (
                    <span className="notificationFailure">{item.failureReason}</span>
                  ) : null}
                </td>
                <td>
                  <button type="button" className="linkButton" onClick={() => void openDetail(item.id)}>
                    {t(locale, 'notification.sendLog.view')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && items.length === 0 ? (
          <p className="smMuted notificationEmpty">No messages in this period.</p>
        ) : null}
      </div>

      <div className="notificationLogFooter">
        <span>{t(locale, 'notification.sendLog.footer')}</span>
        <Pagination locale={locale} page={page} pageSize={20} total={total} onPageChange={(next) => void load(next)} />
      </div>

      {detail ? <SendLogDrawer detail={detail} onClose={() => setDetail(null)} /> : null}
    </div>
  )
}

function SendLogDrawer({
  detail,
  onClose,
}: {
  detail: SendLogDetailResponse
  onClose: () => void
}) {
  const locale = useLocale()
  return (
    <div className="smDrawerBackdrop" role="dialog" aria-modal="true" aria-label="Send log detail">
      <div className="smDrawer">
        <div className="smDrawerHead">
          <div>
            <h2 className="smDrawerTitle">{t(locale, 'notification.sendLog.detailTitle')}</h2>
            <div className="smDrawerMeta">
              <span>{detail.entry.notificationName}</span>
              <span>{formatHktDateTime(detail.entry.occurredAt)}</span>
              {detail.isTest ? <span className="smPill smPillWarn">{t(locale, 'notification.sendLog.test')}</span> : null}
            </div>
          </div>
          <button type="button" className="modalClose" aria-label={t(locale, 'common.close')} onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </div>
        <div className="smDrawerBody">
          <section className="smSection">
            <h3 className="smSectionTitle">
              {t(locale, 'notification.sendLog.messageAsSent')}
            </h3>
            {detail.message ? (
              <>
                <p className="notificationDetailTitle">{detail.message.title}</p>
                <p className="notificationDetailBody">{detail.message.body}</p>
                {detail.message.buttonText ? (
                  <p className="notificationDetailLink">{detail.message.buttonText}</p>
                ) : null}
                <div className="smDrawerMeta">
                  <span>
                    {t(locale, 'notification.sendLog.language')}:{' '}
                    {detail.message.language === 'zh' ? '中文' : 'English'}
                  </span>
                  {detail.message.category ? <span>{detail.message.category}</span> : null}
                  {detail.message.readAt ? <span>Read {formatHktDateTime(detail.message.readAt)}</span> : null}
                  {detail.message.withdrawnAt ? <span>Withdrawn {formatHktDateTime(detail.message.withdrawnAt)}</span> : null}
                </div>
              </>
            ) : (
              <p className="smMuted">{t(locale, 'notification.sendLog.noMessage')}</p>
            )}
          </section>
          <section className="smSection">
            <h3 className="smSectionTitle">{t(locale, 'notification.sendLog.timeline')}</h3>
            <ul className="notificationTimeline">
              {detail.timeline.map((event, index) => (
                <li key={`${event.status}-${index}`}>
                  <span className={statusClass(event.status)}>{statusText(locale, event.status)}</span>
                  <span>{formatHktDateTime(event.occurredAt)}</span>
                  {event.failureReason ? <span className="notificationFailure">{event.failureReason}</span> : null}
                </li>
              ))}
            </ul>
          </section>
          <section className="smSection">
            <h3 className="smSectionTitle">Details</h3>
            <dl className="smGrid">
              <dt>{t(locale, 'notification.sendLog.recipient')}</dt>
              <dd>
                {detail.entry.recipientEmail}
                {detail.entry.recipientName ? ` · ${detail.entry.recipientName}` : ''}
              </dd>
              <dt>{t(locale, 'notification.sendLog.channel')}</dt>
              <dd>{channelLabel(detail.entry.channel)}</dd>
              <dt>{t(locale, 'notification.sendLog.status')}</dt>
              <dd>{statusText(locale, detail.entry.status)}</dd>
              {detail.entry.failureReason ? (
                <>
                  <dt>{t(locale, 'notification.sendLog.failureReason')}</dt>
                  <dd>{detail.entry.failureReason}</dd>
                </>
              ) : null}
              <dt>{t(locale, 'notification.sendLog.related')}</dt>
              <dd>{detail.entry.related || '—'}</dd>
            </dl>
          </section>
        </div>
      </div>
    </div>
  )
}
