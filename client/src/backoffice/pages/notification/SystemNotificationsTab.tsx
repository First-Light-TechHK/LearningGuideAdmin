import { useEffect, useMemo, useRef, useState } from 'react'

import { LockIcon } from '../../components/icons'
import type {
  NotificationChannel,
  NotificationCopy,
  NotificationLanguage,
  NotificationTemplate,
} from '../../contracts/notifications'
import { t } from '../../lib/i18n/messages'
import { useLocale } from '../../lib/navigation'
import { notificationsApi } from '../../lib/notificationsApi'
import { useEmployee } from '../../employeeSession'
import {
  channelLabel,
  chineseCopyMissing,
  copyLimit,
  formatHktDateTime,
  groupTemplates,
  insertVariable,
  notificationErrorText,
  unknownVariables,
  validateTemplateDraft,
  variableErrorMessage,
  type DraftIssues,
  type UnknownVariable,
} from '../../lib/notificationFormat'
import { NotificationDialog } from './NotificationDialog'
import { NotificationPreview } from './NotificationPreview'

function errorText(
  locale: ReturnType<typeof useLocale>,
  result: { code?: string; error?: string; message?: string },
): string {
  return notificationErrorText((key) => t(locale, key), result)
}

function cleanCopy(copy: NotificationCopy): NotificationCopy {
  const result: NotificationCopy = {}
  for (const [key, value] of Object.entries(copy)) {
    if (typeof value === 'string' && value.trim() !== '')
      result[key as keyof NotificationCopy] = value
  }
  return result
}

/** Tab 1：13 条系统通知（B01）。分组、渠道/语言标签、锁定开关与编辑入口。 */
export function SystemNotificationsTab({
  templates,
  loading,
  errorMessage,
  onReload,
  onEdit,
}: {
  templates: NotificationTemplate[]
  loading: boolean
  errorMessage: string | null
  onReload: () => void
  onEdit: (id: string) => void
}) {
  const locale = useLocale()
  const [pendingOff, setPendingOff] = useState<NotificationTemplate | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const groups = groupTemplates(templates, (category) => t(locale, `notification.categories.${category}`))

  async function setEnabled(template: NotificationTemplate, enabled: boolean) {
    setBusy(true)
    setActionError(null)
    const result = await notificationsApi.updateTemplate(template.id, {
      enabled,
      expectedUpdatedAt: template.updatedAt,
    })
    setBusy(false)
    if (result.success) {
      setNotice(t(locale, 'notification.editor.saved'))
      onReload()
    } else {
      setActionError(errorText(locale, result))
      if (result.code === 'TEMPLATE_CONFLICT') onReload()
    }
  }

  return (
    <div className="notificationTabBody">
      {errorMessage ? (
        <div className="alert alertError" role="alert">
          {errorMessage}{' '}
          <button type="button" className="linkButton" onClick={onReload}>
            {t(locale, 'common.retry')}
          </button>
        </div>
      ) : null}
      {notice ? <div className="alert alertOk" role="status">{notice}</div> : null}
      {actionError ? (
        <div className="alert alertError" role="alert">
          {actionError}{' '}
          <button type="button" className="linkButton" onClick={onReload}>
            {t(locale, 'common.retry')}
          </button>
        </div>
      ) : null}
      {loading && templates.length === 0 ? (
        <p className="smMuted">{t(locale, 'common.loading')}</p>
      ) : null}

      <div className="tableWrap">
        <table className="table notificationTable" data-testid="system-notifications-table">
          <colgroup>
            <col style={{ width: '23%' }} />
            <col />
            <col style={{ width: '112px' }} />
            <col style={{ width: '124px' }} />
            <col style={{ width: '184px' }} />
          </colgroup>
          <thead>
            <tr>
              <th>{t(locale, 'notification.columns.notification')}</th>
              <th>{t(locale, 'notification.columns.trigger')}</th>
              <th>{t(locale, 'notification.columns.channels')}</th>
              <th>{t(locale, 'notification.columns.languages')}</th>
              <th>{t(locale, 'notification.columns.status')}</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <NotificationGroup
                key={group.category}
                label={group.label}
                count={group.items.length}
                templates={group.items}
                locale={locale}
                busy={busy}
                onToggle={(template) => {
                  setNotice(null)
                  if (template.locked) return
                  if (template.enabled) setPendingOff(template)
                  else void setEnabled(template, true)
                }}
                onEdit={onEdit}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div className="notificationInlineNote" role="note">
        <span aria-hidden="true">ⓘ</span>
        <span>{t(locale, 'notification.system.note')}</span>
      </div>

      {pendingOff ? (
        <NotificationDialog
          locale={locale}
          title={t(locale, 'notification.editor.confirmOff')}
          confirmLabel={t(locale, 'notification.editor.turnOff')}
          danger
          busy={busy}
          onCancel={() => setPendingOff(null)}
          onConfirm={() => {
            const template = pendingOff
            setPendingOff(null)
            void setEnabled(template, false)
          }}
        >
          {t(locale, 'notification.editor.confirmOffBody')}
        </NotificationDialog>
      ) : null}
    </div>
  )
}

function NotificationGroup({
  label,
  count,
  templates,
  locale,
  busy,
  onToggle,
  onEdit,
}: {
  label: string
  count: number
  templates: NotificationTemplate[]
  locale: ReturnType<typeof useLocale>
  busy: boolean
  onToggle: (template: NotificationTemplate) => void
  onEdit: (id: string) => void
}) {
  return (
    <>
      <tr className="notificationGroupRow">
        <td colSpan={5}>
          {label.toUpperCase()} · {count}
        </td>
      </tr>
      {templates.map((template) => {
        const missing = chineseCopyMissing(template)
        const name = template.name ?? template.en.title ?? template.id
        return (
          <tr key={template.id} data-testid={`notification-row-${template.id}`}>
            <td className="notificationNameCell">
              <span className="notificationName">{name}</span>
              <span className="notificationId">{template.id}</span>
            </td>
            <td className="notificationTriggerCell">
              <div className="notificationTriggerClamp" title={template.triggerText}>
                {template.triggerText}
              </div>
            </td>
            <td>
              <span className="notificationTagList">
                {template.channels.map((channel) => (
                  <span
                    key={channel}
                    className={
                      channel === 'email'
                        ? 'notificationTag notificationTagEmail'
                        : 'notificationTag notificationTagInApp'
                    }
                  >
                    {channelLabel(channel)}
                  </span>
                ))}
              </span>
            </td>
            <td>
              <span className="notificationTagList">
                <span className="notificationTag notificationTagLang">EN</span>
                <span
                  className={
                    missing
                      ? 'notificationTag notificationTagLang notificationTagMissing'
                      : 'notificationTag notificationTagLang'
                  }
                  data-testid={`language-tag-${template.id}`}
                >
                  {missing ? t(locale, 'notification.chineseMissing') : t(locale, 'notification.chinese')}
                </span>
              </span>
            </td>
            <td>
              <div className="notificationStatusCell">
                <span className="notificationToggleCell">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={template.enabled}
                    aria-label={name}
                    className={template.enabled ? 'smSwitch smSwitchOn' : 'smSwitch'}
                    disabled={template.locked || busy}
                    onClick={() => onToggle(template)}
                  />
                  <span className="notificationToggleText">
                    {template.locked ? (
                      <>
                        <LockIcon size={13} /> {t(locale, 'notification.alwaysOn')}
                      </>
                    ) : template.enabled ? (
                      t(locale, 'notification.on')
                    ) : (
                      t(locale, 'notification.off')
                    )}
                  </span>
                </span>
                <button
                  type="button"
                  className="linkButton"
                  onClick={() => onEdit(template.id)}
                  data-testid={`notification-edit-${template.id}`}
                >
                  {t(locale, 'notification.edit')}
                </button>
              </div>
            </td>
          </tr>
        )
      })}
    </>
  )
}

/** Edit（B02/B03）：频道/语言、限长、变量、实时预览、Send test、乐观并发与离开确认。 */
export function NotificationEditor({
  template,
  onBack,
  onReload,
  onSaved,
}: {
  template: NotificationTemplate
  onBack: () => void
  onReload: () => void
  onSaved: () => void
}) {
  const locale = useLocale()
  const employee = useEmployee()
  const [channel, setChannel] = useState<NotificationChannel>(
    template.channels.includes('in_app') ? 'in_app' : 'email',
  )
  const [language, setLanguage] = useState<NotificationLanguage>('en')
  const [en, setEn] = useState<NotificationCopy>({ ...template.en })
  const [zh, setZh] = useState<NotificationCopy>({ ...template.zh })
  const [focus, setFocus] = useState<{
    language: NotificationLanguage
    field: keyof NotificationCopy
    start: number
    end: number
  } | null>(null)
  const [issues, setIssues] = useState<DraftIssues | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [conflict, setConflict] = useState(false)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const allowed = useMemo(
    () =>
      (template.variables ?? []).filter(
        (name) =>
          !['app_url', 'ticket_link', 'course_link', 'session_link'].includes(name),
      ),
    [template.variables],
  )
  const dirty = useMemo(
    () =>
      JSON.stringify(cleanCopy(en)) !== JSON.stringify(cleanCopy(template.en)) ||
      JSON.stringify(cleanCopy(zh)) !== JSON.stringify(cleanCopy(template.zh)),
    [en, zh, template.en, template.zh],
  )

  useEffect(() => {
    if (!dirty) return
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    // 侧边栏/子导航是 SPA 链接，beforeunload 不会触发；捕获阶段先确认。
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

  useEffect(() => {
    return () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
    }
  }, [])

  const copy = language === 'en' ? en : zh
  const setCopy = language === 'en' ? setEn : setZh
  const templateHasButton = template.en.buttonText !== undefined
  const templateHasEmailButton = template.en.emailButtonText !== undefined

  function leave() {
    if (dirty && !window.confirm(t(locale, 'notification.editor.leaveConfirm'))) return
    onBack()
  }

  function updateField(field: keyof NotificationCopy, value: string) {
    setCopy({ ...copy, [field]: value })
    setError(null)
  }

  function insertToken(field: keyof NotificationCopy, name: string) {
    const value = (copy[field] ?? '') as string
    const start = focus?.field === field && focus.language === language ? focus.start : value.length
    const end = focus?.field === field && focus.language === language ? focus.end : value.length
    const next = insertVariable(value, `{{${name}}}`, start, end)
    updateField(field, next.value)
    setFocus({ language, field, start: next.cursor, end: next.cursor })
  }

  function insertSelected(field: keyof NotificationCopy, raw: string) {
    if (!raw) return
    insertToken(field, raw.replace(/[{}]/g, ''))
  }

  function issuesFor(field: keyof NotificationCopy): string[] {
    if (!issues) return []
    const messages: string[] = []
    for (const issue of issues.fields)
      if (issue.field === `${language}.${field}`) messages.push(issue.message)
    return messages
  }

  function unknownFor(field: keyof NotificationCopy, current: NotificationCopy): UnknownVariable[] {
    return unknownVariables(current, allowed).filter((issue) => issue.field === field)
  }

  async function save() {
    if (saving) return
    const nextIssues = validateTemplateDraft(template, en, zh, allowed)
    if (nextIssues.fields.length > 0 || nextIssues.unknown.length > 0) {
      setIssues(nextIssues)
      setError(t(locale, 'notification.errors.INVALID_INPUT'))
      return
    }
    setIssues(null)
    setSaving(true)
    setError(null)
    const result = await notificationsApi.updateTemplate(template.id, {
      en: cleanCopy(en),
      zh: cleanCopy(zh),
      expectedUpdatedAt: template.updatedAt,
    })
    setSaving(false)
    if (result.success) {
      setNotice(t(locale, 'notification.editor.saved'))
      onSaved()
      return
    }
    if (result.code === 'TEMPLATE_CONFLICT') {
      setConflict(true)
      return
    }
    setError(errorText(locale, result))
  }

  async function sendTest() {
    if (testing) return
    setTesting(true)
    setError(null)
    setNotice(null)
    const result = await notificationsApi.testTemplate(template.id, {
      channel,
      language,
      copy: { en: cleanCopy(en), zh: cleanCopy(zh) },
    })
    setTesting(false)
    if (result.success) {
      const key =
        channel === 'email'
          ? 'notification.editor.testSent'
          : 'notification.editor.testInAppSent'
      setNotice(t(locale, key, { email: employee.loginEmail }))
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
      noticeTimer.current = setTimeout(() => setNotice(null), 6000)
    } else {
      setError(errorText(locale, result))
    }
  }

  const fields: Array<keyof NotificationCopy> =
    channel === 'email'
      ? ['subject', 'emailBody', ...(templateHasEmailButton ? (['emailButtonText'] as const) : [])]
      : ['title', 'message', ...(templateHasButton ? (['buttonText'] as const) : [])]

  return (
    <div className="notificationEditor" data-testid="notification-editor">
      <div className="notificationBreadcrumb">
        <button type="button" className="notificationCrumbLink" onClick={leave}>
          {t(locale, 'notification.backToSettings')}
        </button>
        <span aria-hidden="true">/</span>
        <span>{template.name ?? template.en.title ?? template.id}</span>
      </div>

      <div className="notificationEditorHead">
        <div>
          <h1 className="notificationEditorTitle">{template.name ?? template.en.title ?? template.id}</h1>
          <div className="notificationEditorMeta">
            <span className="notificationIdInline">{template.id}</span>
            {template.category === 'subscription' ? (
              <span className="smPill smPillBlue">{t(locale, 'notification.transactional')}</span>
            ) : null}
            <span className="notificationStatusInline">
              <span className={template.enabled ? 'smSwitch smSwitchOn smSwitchStatic' : 'smSwitch smSwitchStatic'} />
              {template.locked ? (
                <span>
                  <LockIcon size={13} /> {t(locale, 'notification.alwaysOn')}
                </span>
              ) : template.enabled ? (
                t(locale, 'notification.on')
              ) : (
                t(locale, 'notification.off')
              )}
            </span>
            <span className="notificationLastEdited">
              {template.updatedAt
                ? t(locale, 'notification.lastEdited', {
                    date: formatHktDateTime(template.updatedAt, true),
                    name: template.updatedBy || '—',
                  })
                : t(locale, 'notification.systemDefault')}
            </span>
          </div>
        </div>
        <div className="notificationEditorActions">
          <button
            type="button"
            className="button buttonGhost buttonCompact"
            onClick={() => void sendTest()}
            disabled={testing}
          >
            {t(locale, 'notification.sendTestToMe')}
          </button>
          <button
            type="button"
            className="button buttonCompact"
            onClick={() => void save()}
            disabled={saving}
            data-testid="notification-save"
          >
            {saving ? t(locale, 'notification.saving') : t(locale, 'notification.save')}
          </button>
        </div>
      </div>

      <div className="notificationSystemBox">
        <div className="notificationSystemField">
          <span className="notificationSystemLabel">{t(locale, 'notification.editor.trigger')}</span>
          <span className="notificationSystemValue">{template.triggerText}</span>
        </div>
        <div className="notificationSystemField">
          <span className="notificationSystemLabel">{t(locale, 'notification.editor.recipient')}</span>
          <span className="notificationSystemValue">{template.recipientText}</span>
        </div>
        <div className="notificationSystemField">
          <span className="notificationSystemLabel">{t(locale, 'notification.editor.sends')}</span>
          <span className="notificationSystemValue">{template.sendsText}</span>
        </div>
        <span className="notificationSystemLocked">
          <LockIcon size={12} /> {t(locale, 'notification.editor.setBySystem')}
        </span>
      </div>

      {notice ? <div className="alert alertOk notificationToast" role="status">{notice}</div> : null}
      {error ? <div className="alert alertError" role="alert">{error}</div> : null}
      {conflict ? (
        <div className="alert alertError" role="alert" data-testid="notification-conflict">
          {t(locale, 'notification.editor.conflict')}{' '}
          <button
            type="button"
            className="linkButton"
            onClick={() => {
              onReload()
              onBack()
            }}
          >
            {t(locale, 'notification.editor.reload')}
          </button>
        </div>
      ) : null}

      <div className="notificationEditorGrid">
        <div className="notificationEditorForm">
          <div className="notificationChannelTabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={channel === 'in_app'}
              className={
                channel === 'in_app'
                  ? 'notificationTab notificationTabActive'
                  : 'notificationTab'
              }
              onClick={() => setChannel('in_app')}
            >
              {t(locale, 'notification.editor.inAppMessage')}
            </button>
            {template.channels.includes('email') ? (
              <button
                type="button"
                role="tab"
                aria-selected={channel === 'email'}
                className={
                  channel === 'email'
                    ? 'notificationTab notificationTabActive'
                    : 'notificationTab'
                }
                onClick={() => setChannel('email')}
              >
                {t(locale, 'notification.editor.email')}
              </button>
            ) : null}
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
                {Object.values(cleanCopy(zh)).length === 0 ? (
                  <span className="notificationLangNotSet">
                    {t(locale, 'notification.editor.notSet')}
                  </span>
                ) : null}
              </button>
            </span>
            <span className="notificationLanguageHint">
              {t(locale, 'notification.editor.languageHint')}
            </span>
          </div>

          {fields.map((field) => {
            const value = (copy[field] ?? '') as string
            const max = copyLimit(field)
            const fieldIssues = issuesFor(field)
            const unknown = language === 'en' ? unknownFor(field, en) : unknownFor(field, zh)
            const long = field === 'message' || field === 'emailBody'
            const labelKey =
              field === 'emailBody'
                ? 'notification.editor.emailBody'
                : field === 'subject'
                  ? 'notification.editor.subject'
                  : field === 'title'
                    ? 'notification.editor.title'
                    : field === 'message'
                      ? 'notification.editor.message'
                      : field === 'buttonText' || field === 'emailButtonText'
                        ? 'notification.editor.buttonText'
                        : field
            return (
              <label className="field notificationField" key={field}>
                <span className="notificationFieldHead">
                  <span className="fieldLabel">{t(locale, labelKey)}</span>
                  <span className={value.length > max ? 'notificationCounter notificationCounterOver' : 'notificationCounter'}>
                    {value.length} / {max}
                  </span>
                </span>
                <span className="notificationVariableTools">
                  <select
                    className="notificationVariableSelect"
                    value=""
                    aria-label={t(locale, 'notification.editor.insertVariable')}
                    onChange={(event) => insertSelected(field, event.target.value)}
                  >
                    <option value="">{'{ }'} {t(locale, 'notification.editor.insertVariable')}</option>
                    {allowed.map((name) => (
                      <option key={name} value={name}>{`{{${name}}}`}</option>
                    ))}
                  </select>
                </span>
                {long ? (
                  <textarea
                    className={
                      fieldIssues.length > 0 || unknown.length > 0
                        ? 'fieldInput notificationTextarea notificationFieldInvalid'
                        : 'fieldInput notificationTextarea'
                    }
                    value={value}
                    maxLength={max + 200}
                    onChange={(event) => updateField(field, event.target.value)}
                    onFocus={(event) =>
                      setFocus({
                        language,
                        field,
                        start: event.currentTarget.selectionStart ?? 0,
                        end: event.currentTarget.selectionEnd ?? 0,
                      })
                    }
                    onSelect={(event) =>
                      setFocus({
                        language,
                        field,
                        start: event.currentTarget.selectionStart ?? 0,
                        end: event.currentTarget.selectionEnd ?? 0,
                      })
                    }
                  />
                ) : (
                  <input
                    className={
                      fieldIssues.length > 0 || unknown.length > 0
                        ? 'fieldInput notificationFieldInvalid'
                        : 'fieldInput'
                    }
                    value={value}
                    maxLength={max + 200}
                    onChange={(event) => updateField(field, event.target.value)}
                    onFocus={(event) =>
                      setFocus({
                        language,
                        field,
                        start: event.currentTarget.selectionStart ?? 0,
                        end: event.currentTarget.selectionEnd ?? 0,
                      })
                    }
                    onSelect={(event) =>
                      setFocus({
                        language,
                        field,
                        start: event.currentTarget.selectionStart ?? 0,
                        end: event.currentTarget.selectionEnd ?? 0,
                      })
                    }
                  />
                )}
                {fieldIssues.map((message) => (
                  <span className="notificationFieldError" key={message}>{message}</span>
                ))}
                {unknown.map((issue) => (
                  <span className="notificationFieldError" key={`${issue.field}-${issue.name}`}>
                    {variableErrorMessage(issue)}
                  </span>
                ))}
              </label>
            )
          })}

          <label className="field notificationField">
            <span className="notificationFieldHead">
              <span className="fieldLabel">{t(locale, 'notification.editor.buttonLink')}</span>
            </span>
            <input
              className="fieldInput"
              value={template.buttonLink.replace(/^\{\{app_url\}\}/, '')}
              readOnly
              disabled
            />
            <span className="fieldHint">{t(locale, 'notification.editor.setBySystem')}</span>
          </label>

          <div className="notificationAvailableVariables">
            <span className="fieldHint">{t(locale, 'notification.editor.available')}</span>
            {allowed.map((name) => (
              <button
                type="button"
                key={name}
                className="notificationVariableChip"
                onClick={() => insertToken(fields.find((field) => field === 'message' || field === 'emailBody') ?? fields[0], name)}
              >
                {`{{${name}}}`}
              </button>
            ))}
          </div>
        </div>

        <NotificationPreview template={template} copy={copy} channel={channel} locale={locale} />
      </div>
    </div>
  )
}
