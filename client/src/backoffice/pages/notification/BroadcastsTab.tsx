import { useCallback, useEffect, useMemo, useState } from 'react'

import { CloseIcon } from '../../components/icons'
import { Pagination } from '../../components/Pagination'
import type {
  AudienceResponse,
  BroadcastDetailResponse,
  BroadcastDraftInput,
  NotificationBroadcast,
  NotificationCopy,
  NotificationLanguage,
} from '../../contracts/notifications'
import { t } from '../../lib/i18n/messages'
import { useLocale } from '../../lib/navigation'
import { notificationsApi } from '../../lib/notificationsApi'
import {
  broadcastLanguageLabel,
  countLabel,
  formatHktDateTime,
  notificationErrorText,
  readRateLabel,
  validateBroadcastDraft,
} from '../../lib/notificationFormat'
import { NotificationDialog } from './NotificationDialog'
import { NotificationPreview } from './NotificationPreview'

function errorText(
  locale: ReturnType<typeof useLocale>,
  result: { code?: string; message?: string; error?: string },
): string {
  return notificationErrorText((key) => t(locale, key), result)
}

function statusPill(status: NotificationBroadcast['status']) {
  if (status === 'sent') return 'smPill smPillActive'
  if (status === 'withdrawn') return 'smPill smPillInactive'
  return 'smPill smPillMuted'
}

function statusLabel(locale: ReturnType<typeof useLocale>, status: NotificationBroadcast['status']) {
  return t(
    locale,
    status === 'sent'
      ? 'notification.broadcasts.statusSent'
      : status === 'withdrawn'
        ? 'notification.broadcasts.statusWithdrawn'
        : 'notification.broadcasts.statusDraft',
  )
}

/** Tab 2：广播列表（B04）。草稿/已发/已撤回、收件人数与阅读率、撤回/删除确认。 */
export function BroadcastsTab({
  refreshKey,
  onNew,
  onEdit,
}: {
  refreshKey: number
  onNew: () => void
  onEdit: (broadcast: NotificationBroadcast) => void
}) {
  const locale = useLocale()
  const [rows, setRows] = useState<NotificationBroadcast[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState<{ kind: 'withdraw' | 'delete'; broadcast: NotificationBroadcast } | null>(null)
  const [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState<BroadcastDetailResponse | null>(null)

  const load = useCallback(async (targetPage = page) => {
    setLoading(true)
    const result = await notificationsApi.broadcasts(targetPage)
    setLoading(false)
    if (result.success) {
      setRows(result.data.broadcasts)
      setTotal(result.data.total)
      setPage(result.data.page)
      setError(null)
    } else {
      setError(errorText(locale, result))
    }
  }, [locale, page])

  useEffect(() => {
    void load(page)
    // reload when a draft/send/withdraw finished in the editor
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, refreshKey])

  async function act(kind: 'withdraw' | 'delete', broadcast: NotificationBroadcast) {
    setBusy(true)
    const result = await notificationsApi.patchBroadcast(broadcast.id, { action: kind })
    setBusy(false)
    setPending(null)
    if (result.success) {
      setNotice(
        t(
          locale,
          kind === 'withdraw' ? 'notification.broadcasts.withdrawn' : 'notification.broadcasts.deleted',
        ),
      )
      setDetail(null)
      await load(page)
    } else {
      setError(errorText(locale, result))
    }
  }

  async function view(id: string) {
    const result = await notificationsApi.broadcast(id)
    if (result.success) setDetail(result.data)
    else setError(errorText(locale, result))
  }

  return (
    <div className="notificationTabBody">
      <div className="notificationListHead">
        <span className="notificationListCount">
          {t(locale, 'notification.broadcasts.count', { count: total })}
        </span>
        <button type="button" className="button buttonCompact" onClick={onNew} data-testid="broadcast-new">
          {t(locale, 'notification.broadcasts.new')}
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
      {notice ? <div className="alert alertOk" role="status">{notice}</div> : null}

      <div className="tableWrap">
        <table className="table notificationTable notificationBroadcastTable" data-testid="broadcast-table">
          <colgroup>
            <col style={{ width: '27%' }} />
            <col style={{ width: '16%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '15%' }} />
            <col style={{ width: '11%' }} />
            <col style={{ width: '9%' }} />
            <col style={{ width: '12%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>Broadcast</th>
              <th>{t(locale, 'notification.broadcasts.audience')}</th>
              <th>{t(locale, 'notification.columns.status')}</th>
              <th>{t(locale, 'notification.broadcasts.sentAt')}</th>
              <th>{t(locale, 'notification.broadcasts.recipientsRead')}</th>
              <th>{t(locale, 'notification.broadcasts.createdBy')}</th>
              <th aria-label={t(locale, 'notification.columns.actions')} />
            </tr>
          </thead>
          <tbody>
            {rows.map((broadcast) => (
              <tr key={broadcast.id} data-testid={`broadcast-row-${broadcast.id}`}>
                <td className="notificationNameCell">
                  <span className="notificationName">{broadcast.titleEn}</span>
                  {broadcast.status === 'withdrawn' ? (
                    <span className="notificationId">
                      {t(locale, 'notification.broadcasts.withdrawnBy', {
                        date: broadcast.withdrawnAt ? formatHktDateTime(broadcast.withdrawnAt, true) : '—',
                        name: broadcast.withdrawnBy || '—',
                      })}
                    </span>
                  ) : (
                    <span className="notificationId">{broadcastLanguageLabel(broadcast)}</span>
                  )}
                </td>
                <td className="notificationNoWrap">
                  {broadcast.audience === 'paid'
                    ? t(locale, 'notification.broadcasts.audiencePaid')
                    : t(locale, 'notification.broadcasts.audienceAll')}
                </td>
                <td>
                  <span className={statusPill(broadcast.status)}>
                    {statusLabel(locale, broadcast.status)}
                  </span>
                </td>
                <td className={broadcast.status === 'withdrawn' ? 'notificationNoWrap notificationMutedCell' : 'notificationNoWrap'}>
                  {broadcast.sentAt ? formatHktDateTime(broadcast.sentAt) : '—'}
                </td>
                <td>
                  {broadcast.status === 'draft' || broadcast.status === 'withdrawn' ? (
                    '—'
                  ) : (
                    <span className="notificationReadCell">
                      <span>{countLabel(broadcast.recipients)}</span>
                      <span className="notificationReadRate">
                        {readRateLabel(broadcast.recipients, broadcast.rate)}
                      </span>
                    </span>
                  )}
                </td>
                <td>{broadcast.createdBy || '—'}</td>
                <td>
                  <div className="notificationRowActions">
                    {broadcast.status === 'draft' ? (
                      <>
                        <button type="button" className="linkButton" onClick={() => onEdit(broadcast)}>
                          {t(locale, 'notification.broadcasts.edit')}
                        </button>
                        <button
                          type="button"
                          className="linkButton notificationDangerLink"
                          onClick={() => setPending({ kind: 'delete', broadcast })}
                        >
                          {t(locale, 'notification.broadcasts.delete')}
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="linkButton" onClick={() => void view(broadcast.id)}>
                          {t(locale, 'notification.broadcasts.view')}
                        </button>
                        {broadcast.status === 'sent' ? (
                          <button
                            type="button"
                            className="linkButton notificationDangerLink"
                            onClick={() => setPending({ kind: 'withdraw', broadcast })}
                          >
                            {t(locale, 'notification.broadcasts.withdraw')}
                          </button>
                        ) : null}
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && rows.length === 0 ? (
          <p className="smMuted notificationEmpty">No broadcasts yet.</p>
        ) : null}
      </div>

      <Pagination locale={locale} page={page} pageSize={20} total={total} onPageChange={setPage} />
      <div className="notificationInlineNote" role="note">
        <span aria-hidden="true">ⓘ</span>
        <span>{t(locale, 'notification.broadcasts.footer')}</span>
      </div>

      {pending ? (
        <NotificationDialog
          locale={locale}
          title={t(
            locale,
            pending.kind === 'withdraw'
              ? 'notification.broadcasts.withdrawConfirmTitle'
              : 'notification.broadcasts.deleteConfirmTitle',
          )}
          confirmLabel={t(
            locale,
            pending.kind === 'withdraw'
              ? 'notification.broadcasts.withdraw'
              : 'notification.broadcasts.delete',
          )}
          danger
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void act(pending.kind, pending.broadcast)}
        >
          {t(
            locale,
            pending.kind === 'withdraw'
              ? 'notification.broadcasts.withdrawConfirmBody'
              : 'notification.broadcasts.deleteConfirmBody',
          )}
        </NotificationDialog>
      ) : null}

      {detail ? (
        <BroadcastDetailDrawer detail={detail} onClose={() => setDetail(null)} />
      ) : null}
    </div>
  )
}

/** View：广播详情（只读）；Sent/Withdrawn 都可看。 */
function BroadcastDetailDrawer({
  detail,
  onClose,
}: {
  detail: BroadcastDetailResponse
  onClose: () => void
}) {
  const locale = useLocale()
  const broadcast = detail.broadcast
  const copy: NotificationCopy =
    broadcast.titleZh || broadcast.bodyZh
      ? { title: broadcast.titleEn, message: broadcast.bodyEn }
      : { title: broadcast.titleEn, message: broadcast.bodyEn }
  return (
    <div className="smDrawerBackdrop" role="dialog" aria-modal="true" aria-label="Broadcast detail">
      <div className="smDrawer">
        <div className="smDrawerHead">
          <div>
            <h2 className="smDrawerTitle">{broadcast.titleEn}</h2>
            <div className="smDrawerMeta">
              <span className={statusPill(broadcast.status)}>{statusLabel(locale, broadcast.status)}</span>
              <span>{broadcastLanguageLabel(broadcast)}</span>
            </div>
          </div>
          <button type="button" className="modalClose" aria-label={t(locale, 'common.close')} onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </div>
        <div className="smDrawerBody">
          <section className="smSection">
            <h3 className="smSectionTitle">Message</h3>
            <p className="notificationDetailBody">{broadcast.bodyEn}</p>
            {broadcast.titleZh || broadcast.bodyZh ? (
              <p className="notificationDetailBody notificationDetailZh">
                {broadcast.titleZh || ''}
                {broadcast.bodyZh ? ` — ${broadcast.bodyZh}` : ''}
              </p>
            ) : null}
            {broadcast.buttonText ? (
              <p className="notificationDetailLink">
                {broadcast.buttonText} → {broadcast.buttonLink}
              </p>
            ) : null}
          </section>
          <section className="smSection">
            <h3 className="smSectionTitle">Delivery</h3>
            <dl className="smGrid">
              <dt>Audience</dt>
              <dd>
                {broadcast.audience === 'paid'
                  ? t(locale, 'notification.broadcasts.audiencePaid')
                  : t(locale, 'notification.broadcasts.audienceAll')}
              </dd>
              <dt>Recipients · read</dt>
              <dd>
                {countLabel(detail.readRate.recipients)} · {readRateLabel(detail.readRate.recipients, detail.readRate.rate)}
              </dd>
              <dt>Created by</dt>
              <dd>{broadcast.createdBy || '—'}</dd>
              <dt>Sent at</dt>
              <dd>{broadcast.sentAt ? formatHktDateTime(broadcast.sentAt) : '—'}</dd>
              <dt>Withdrawn</dt>
              <dd>
                {broadcast.withdrawnAt
                  ? `${formatHktDateTime(broadcast.withdrawnAt, true)} · ${broadcast.withdrawnBy || '—'}`
                  : '—'}
              </dd>
            </dl>
          </section>
          <NotificationPreview
            copy={copy}
            channel="in_app"
            label={t(locale, 'notification.broadcasts.announcement')}
            locale={locale}
            sample={false}
          />
        </div>
      </div>
    </div>
  )
}

/** New / Edit broadcast（B05）：audience + 文案 + 预览 + 保存草稿/立即发送。 */
export function BroadcastEditor({
  broadcast,
  onBack,
  onSaved,
}: {
  broadcast?: NotificationBroadcast
  onBack: () => void
  onSaved: (notice: string) => void
}) {
  const locale = useLocale()
  const editing = Boolean(broadcast)
  const [audiences, setAudiences] = useState<AudienceResponse | null>(null)
  const [audience, setAudience] = useState<'all' | 'paid'>(broadcast?.audience ?? 'all')
  const [language, setLanguage] = useState<NotificationLanguage>('en')
  const [titleEn, setTitleEn] = useState(broadcast?.titleEn ?? '')
  const [bodyEn, setBodyEn] = useState(broadcast?.bodyEn ?? '')
  const [titleZh, setTitleZh] = useState(broadcast?.titleZh ?? '')
  const [bodyZh, setBodyZh] = useState(broadcast?.bodyZh ?? '')
  const [buttonText, setButtonText] = useState(broadcast?.buttonText ?? '')
  const [buttonLink, setButtonLink] = useState(broadcast?.buttonLink ?? '')
  const [issues, setIssues] = useState<Array<{ field: string; message: string }>>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmSend, setConfirmSend] = useState(false)

  useEffect(() => {
    void notificationsApi.audiences().then((result) => {
      if (result.success) setAudiences(result.data)
    })
  }, [])

  const draft: BroadcastDraftInput = useMemo(
    () => ({
      titleEn,
      bodyEn,
      titleZh: titleZh.trim() ? titleZh : null,
      bodyZh: bodyZh.trim() ? bodyZh : null,
      buttonText: buttonText.trim() ? buttonText : null,
      buttonLink: buttonLink.trim() ? buttonLink : null,
      audience,
    }),
    [titleEn, bodyEn, titleZh, bodyZh, buttonText, buttonLink, audience],
  )

  const dirty = useMemo(() => {
    if (!broadcast) {
      return Boolean(
        titleEn || bodyEn || titleZh || bodyZh || buttonText || buttonLink || audience !== 'all',
      )
    }
    return (
      titleEn !== broadcast.titleEn ||
      bodyEn !== broadcast.bodyEn ||
      (titleZh || '') !== (broadcast.titleZh ?? '') ||
      (bodyZh || '') !== (broadcast.bodyZh ?? '') ||
      (buttonText || '') !== (broadcast.buttonText ?? '') ||
      (buttonLink || '') !== (broadcast.buttonLink ?? '') ||
      audience !== broadcast.audience
    )
  }, [audience, bodyEn, bodyZh, broadcast, buttonLink, buttonText, titleEn, titleZh])

  const copy: NotificationCopy =
    language === 'en'
      ? { title: titleEn, message: bodyEn, buttonText }
      : { title: titleZh, message: bodyZh, buttonText }

  useEffect(() => {
    if (!dirty) return
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target?.closest('a')) return
      if (!window.confirm(t(locale, 'notification.editor.leaveConfirm'))) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    window.addEventListener('beforeunload', beforeUnload)
    document.addEventListener('click', onClick, true)
    return () => {
      window.removeEventListener('beforeunload', beforeUnload)
      document.removeEventListener('click', onClick, true)
    }
  }, [dirty, locale])

  function leave() {
    if (dirty && !window.confirm(t(locale, 'notification.editor.leaveConfirm'))) return
    onBack()
  }

  function validate(): boolean {
    const next = validateBroadcastDraft(draft)
    setIssues(next)
    if (next.length > 0) {
      setError(t(locale, 'notification.errors.INVALID_INPUT'))
      return false
    }
    setError(null)
    return true
  }

  async function saveDraft(keepBusy = false): Promise<string | null> {
    if (!validate()) return null
    setBusy(true)
    const result = broadcast
      ? await notificationsApi.patchBroadcast(broadcast.id, { action: 'update', ...draftPatch(draft) })
      : await notificationsApi.createBroadcast(draft)
    if (!keepBusy || !result.success) setBusy(false)
    if (result.success) return broadcast?.id ?? extractBroadcastId(result.data)
    setError(errorText(locale, result))
    return null
  }

  async function onSaveDraft() {
    const id = await saveDraft()
    if (id) onSaved(t(locale, 'notification.broadcasts.saved'))
  }

  async function sendNow() {
    if (!validate()) return
    setConfirmSend(true)
  }

  async function confirmSendNow() {
    // Save what is on screen first, so the broadcast that goes out is the one the operator confirmed.
    setBusy(true)
    const id = await saveDraft(true)
    if (!id) {
      setConfirmSend(false)
      return
    }
    const result = await notificationsApi.patchBroadcast(id, { action: 'send' })
    setBusy(false)
    setConfirmSend(false)
    if (result.success) {
      const count = (result.data as { recipients?: number }).recipients ?? audiences?.[audience] ?? 0
      onSaved(t(locale, 'notification.broadcasts.sent', { count }))
    } else {
      setError(errorText(locale, result))
    }
  }

  const fieldsByField = new Map(issues.map((issue) => [issue.field, issue.message]))
  const visibleTitle = language === 'en' ? titleEn : titleZh
  const visibleBody = language === 'en' ? bodyEn : bodyZh
  const setVisibleTitle = language === 'en' ? setTitleEn : setTitleZh
  const setVisibleBody = language === 'en' ? setBodyEn : setBodyZh
  const audienceCount = audiences ? audiences[audience] : 0

  return (
    <div className="notificationEditor" data-testid="broadcast-editor">
      <div className="notificationBreadcrumb">
        <button type="button" className="notificationCrumbLink" onClick={leave}>
          {t(locale, 'notification.broadcasts.backToList')}
        </button>
        <span aria-hidden="true">/</span>
        <span>
          {editing
            ? t(locale, 'notification.broadcasts.edit')
            : t(locale, 'notification.broadcasts.newTitle')}
        </span>
      </div>
      <div className="notificationEditorHead">
        <h1 className="notificationEditorTitle">
          {editing
            ? t(locale, 'notification.broadcasts.edit')
            : t(locale, 'notification.broadcasts.newTitle')}
        </h1>
        <div className="notificationEditorActions">
          <button type="button" className="button buttonGhost buttonCompact" onClick={leave} disabled={busy}>
            {t(locale, 'notification.broadcasts.cancel')}
          </button>
          <button type="button" className="button buttonGhost buttonCompact" onClick={() => void onSaveDraft()} disabled={busy}>
            {t(locale, 'notification.broadcasts.saveDraft')}
          </button>
          <button type="button" className="button buttonCompact" onClick={() => void sendNow()} disabled={busy} data-testid="broadcast-send-now">
            {t(locale, 'notification.broadcasts.sendNow')}
          </button>
        </div>
      </div>

      {error ? <div className="alert alertError" role="alert">{error}</div> : null}

      <div className="notificationEditorGrid notificationBroadcastEditor">
        <div className="notificationEditorForm">
          <div className="notificationField">
            <span className="fieldLabel">{t(locale, 'notification.broadcasts.sendTo')}</span>
            <div className="notificationAudienceCards">
              <button
                type="button"
                className={
                  audience === 'all'
                    ? 'notificationAudienceCard notificationAudienceCardActive'
                    : 'notificationAudienceCard'
                }
                onClick={() => setAudience('all')}
              >
                <span className="notificationRadio" data-checked={audience === 'all'} />
                <span>
                  <strong>{t(locale, 'notification.broadcasts.audienceAll')}</strong>
                  <span className="notificationAudienceHint">
                    {t(locale, 'notification.broadcasts.audienceAbout', {
                      count: countLabel(audiences?.all ?? 0),
                    })}
                  </span>
                </span>
              </button>
              <button
                type="button"
                className={
                  audience === 'paid'
                    ? 'notificationAudienceCard notificationAudienceCardActive'
                    : 'notificationAudienceCard'
                }
                onClick={() => setAudience('paid')}
              >
                <span className="notificationRadio" data-checked={audience === 'paid'} />
                <span>
                  <strong>{t(locale, 'notification.broadcasts.audiencePaid')}</strong>
                  <span className="notificationAudienceHint">
                    {t(locale, 'notification.broadcasts.audiencePaidHint', {
                      count: countLabel(audiences?.paid ?? 0),
                    })}
                  </span>
                </span>
              </button>
            </div>
          </div>

          <div className="notificationLanguageBar">
            <span className="notificationLanguageSwitch" role="group" aria-label="Language">
              <button
                type="button"
                className={
                  language === 'en'
                    ? 'notificationLangButton notificationLangButtonActive'
                    : 'notificationLangButton'
                }
                onClick={() => setLanguage('en')}
              >
                {t(locale, 'notification.english')}
              </button>
              <button
                type="button"
                className={
                  language === 'zh'
                    ? 'notificationLangButton notificationLangButtonActive'
                    : 'notificationLangButton'
                }
                onClick={() => setLanguage('zh')}
              >
                {t(locale, 'notification.chinese')}
                {!titleZh && !bodyZh ? (
                  <span className="notificationLangNotSet">{t(locale, 'notification.editor.notSet')}</span>
                ) : null}
              </button>
            </span>
            <span className="notificationLanguageHint">
              {t(locale, 'notification.editor.languageHint')}
            </span>
          </div>

          <label className="field notificationField">
            <span className="notificationFieldHead">
              <span className="fieldLabel">{t(locale, 'notification.broadcasts.title')}</span>
              <span className={visibleTitle.length > 60 ? 'notificationCounter notificationCounterOver' : 'notificationCounter'}>
                {visibleTitle.length} / 60
              </span>
            </span>
            <input
              className={fieldsByField.has(language === 'en' ? 'titleEn' : 'titleZh') ? 'fieldInput notificationFieldInvalid' : 'fieldInput'}
              value={visibleTitle}
              maxLength={120}
              onChange={(event) => setVisibleTitle(event.target.value)}
            />
            {fieldsByField.has(language === 'en' ? 'titleEn' : 'titleZh') ? (
              <span className="notificationFieldError">{fieldsByField.get(language === 'en' ? 'titleEn' : 'titleZh')}</span>
            ) : null}
          </label>

          <label className="field notificationField">
            <span className="notificationFieldHead">
              <span className="fieldLabel">{t(locale, 'notification.broadcasts.message')}</span>
              <span className={visibleBody.length > 300 ? 'notificationCounter notificationCounterOver' : 'notificationCounter'}>
                {visibleBody.length} / 300
              </span>
            </span>
            <textarea
              className={fieldsByField.has(language === 'en' ? 'bodyEn' : 'bodyZh') ? 'fieldInput notificationTextarea notificationFieldInvalid' : 'fieldInput notificationTextarea'}
              value={visibleBody}
              maxLength={600}
              onChange={(event) => setVisibleBody(event.target.value)}
            />
            {fieldsByField.has(language === 'en' ? 'bodyEn' : 'bodyZh') ? (
              <span className="notificationFieldError">{fieldsByField.get(language === 'en' ? 'bodyEn' : 'bodyZh')}</span>
            ) : null}
          </label>

          <div className="notificationTwoColumn">
            <label className="field notificationField">
              <span className="fieldLabel">{t(locale, 'notification.broadcasts.buttonText')}</span>
              <input
                className="fieldInput"
                value={buttonText}
                maxLength={80}
                placeholder={t(locale, 'notification.broadcasts.buttonPlaceholder')}
                onChange={(event) => setButtonText(event.target.value)}
              />
            </label>
            <label className="field notificationField">
              <span className="fieldLabel">{t(locale, 'notification.broadcasts.buttonLink')}</span>
              <input
                className={fieldsByField.has('button') || fieldsByField.has('buttonLink') ? 'fieldInput notificationFieldInvalid' : 'fieldInput'}
                value={buttonLink}
                maxLength={500}
                placeholder={t(locale, 'notification.broadcasts.linkPlaceholder')}
                onChange={(event) => setButtonLink(event.target.value)}
              />
            </label>
          </div>
          {fieldsByField.has('button') || fieldsByField.has('buttonLink') ? (
            <span className="notificationFieldError">
              {fieldsByField.get('button') ?? fieldsByField.get('buttonLink')}
            </span>
          ) : null}

          <div className="notificationInlineNote" role="note">
            <span aria-hidden="true">ⓘ</span>
            <span>{t(locale, 'notification.broadcasts.sendNowNote')}</span>
          </div>
        </div>

        <NotificationPreview
          copy={copy}
          channel="in_app"
          label={t(locale, 'notification.broadcasts.announcement')}
          locale={locale}
          sample={false}
        />
      </div>

      {confirmSend ? (
        <NotificationDialog
          locale={locale}
          title={t(locale, 'notification.broadcasts.sendConfirmTitle')}
          confirmLabel={t(locale, 'notification.broadcasts.sendNow')}
          busy={busy}
          onCancel={() => setConfirmSend(false)}
          onConfirm={() => void confirmSendNow()}
        >
          {t(locale, 'notification.broadcasts.sendConfirmBody', {
            count: countLabel(audienceCount),
          })}
        </NotificationDialog>
      ) : null}
    </div>
  )
}

function draftPatch(draft: BroadcastDraftInput): Record<string, unknown> {
  return {
    titleEn: draft.titleEn,
    bodyEn: draft.bodyEn,
    titleZh: draft.titleZh,
    bodyZh: draft.bodyZh,
    buttonText: draft.buttonText,
    buttonLink: draft.buttonLink,
    audience: draft.audience,
  }
}

function extractBroadcastId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const broadcast = (data as { broadcast?: unknown }).broadcast
  if (!broadcast || typeof broadcast !== 'object') return null
  const id = (broadcast as { id?: unknown }).id
  return typeof id === 'string' ? id : null
}
