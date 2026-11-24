import { useCallback, useEffect, useState } from 'react'

import '../../students.css'
import '../../notification.css'
import { SettingsSubNav } from '../../components/SettingsSubNav'
import type {
  NotificationBroadcast,
  NotificationTemplate,
} from '../../contracts/notifications'
import { useEmployee } from '../../employeeSession'
import { cachedAccountFeatures, cachedCapabilities } from '../../lib/capabilities'
import { t } from '../../lib/i18n/messages'
import { useLocale } from '../../lib/navigation'
import { notificationsApi } from '../../lib/notificationsApi'
import { notificationErrorText } from '../../lib/notificationFormat'
import { BroadcastEditor, BroadcastsTab } from './BroadcastsTab'
import { SendLogTab } from './SendLogTab'
import { NotificationEditor, SystemNotificationsTab } from './SystemNotificationsTab'

type Tab = 'system' | 'broadcasts' | 'sendLog'

type Subpage =
  | { kind: 'system' }
  | { kind: 'template'; id: string }
  | { kind: 'broadcasts' }
  | { kind: 'broadcast-new' }
  | { kind: 'broadcast-edit'; broadcast: NotificationBroadcast }
  | { kind: 'sendLog' }

/**
 * Settings › Notification Configuration（PRD §6–§8、Figma B01–B06）。
 *
 * 入口替换原占位页；页面只在 admin + settings 能力 + module.settings 生效时渲染。
 * 页面本体不滚动：表格/Tab 内容在卡片内部滚动（沿用 RWD 壳层）。
 */
export function NotificationConfigurationPage() {
  const locale = useLocale()
  const employee = useEmployee()
  const capabilities = cachedCapabilities()
  const features = cachedAccountFeatures()
  const capabilityOpen = capabilities.has('settings')
  const featureOpen = features === null || features.has('module.settings')
  const admin = employee.role === 'ADMIN'

  if (!admin || !capabilityOpen || !featureOpen) {
    return (
      <>
        <SettingsSubNav role={employee.role} />
        <section className="card cardGrow">
          <h1 className="cardTitle">{t(locale, 'forbidden.title')}</h1>
          <p className="cardBody">
            {admin
              ? t(locale, 'forbidden.description')
              : t(locale, 'notification.editor.notAdmin')}
          </p>
        </section>
      </>
    )
  }
  return (
    <>
      <SettingsSubNav role={employee.role} />
      <NotificationConfigurationInner />
    </>
  )
}

function NotificationConfigurationInner() {
  const locale = useLocale()
  const [subpage, setSubpage] = useState<Subpage>({ kind: 'system' })
  const [templates, setTemplates] = useState<NotificationTemplate[]>([])
  const [templateError, setTemplateError] = useState<string | null>(null)
  const [templateLoading, setTemplateLoading] = useState(true)
  const [broadcasts, setBroadcasts] = useState<NotificationBroadcast[]>([])
  const [refreshKey, setRefreshKey] = useState(0)
  const [pageNotice, setPageNotice] = useState<string | null>(null)

  const loadTemplates = useCallback(async () => {
    setTemplateLoading(true)
    const result = await notificationsApi.templates()
    setTemplateLoading(false)
    if (result.success) {
      setTemplates(result.data.templates)
      setTemplateError(null)
    } else {
      setTemplateError(
        notificationErrorText((key) => t(locale, key), result),
      )
    }
  }, [locale])

  const loadBroadcastOptions = useCallback(async () => {
    const result = await notificationsApi.broadcasts(1)
    if (result.success) setBroadcasts(result.data.broadcasts)
  }, [])

  useEffect(() => {
    void loadTemplates()
    void loadBroadcastOptions()
  }, [loadTemplates, loadBroadcastOptions])

  const tab: Tab =
    subpage.kind === 'broadcasts' ||
    subpage.kind === 'broadcast-new' ||
    subpage.kind === 'broadcast-edit'
      ? 'broadcasts'
      : subpage.kind === 'sendLog'
        ? 'sendLog'
        : 'system'

  function switchTab(next: Tab) {
    setPageNotice(null)
    setSubpage({ kind: next })
  }

  const editorTemplate =
    subpage.kind === 'template'
      ? templates.find((template) => template.id === subpage.id)
      : null

  if (subpage.kind === 'template') {
    if (!editorTemplate) {
      return (
        <section className="card cardGrow notificationPage">
          {templateLoading ? (
            <p className="smMuted">{t(locale, 'common.loading')}</p>
          ) : (
            <div className="alert alertError" role="alert">
              {templateError ?? t(locale, 'notification.errors.TEMPLATE_NOT_FOUND')}{' '}
              <button type="button" className="linkButton" onClick={() => setSubpage({ kind: 'system' })}>
                {t(locale, 'common.back')}
              </button>
            </div>
          )}
        </section>
      )
    }
    return (
      <section className="card cardGrow notificationPage">
        <NotificationEditor
          template={editorTemplate}
          onBack={() => setSubpage({ kind: 'system' })}
          onReload={() => void loadTemplates()}
          onSaved={() => {
            setPageNotice(t(locale, 'notification.editor.saved'))
            setSubpage({ kind: 'system' })
            void loadTemplates()
          }}
        />
      </section>
    )
  }

  if (subpage.kind === 'broadcast-new' || subpage.kind === 'broadcast-edit') {
    return (
      <section className="card cardGrow notificationPage">
        <BroadcastEditor
          {...(subpage.kind === 'broadcast-edit' ? { broadcast: subpage.broadcast } : {})}
          onBack={() => setSubpage({ kind: 'broadcasts' })}
          onSaved={(notice) => {
            setPageNotice(notice)
            setRefreshKey((value) => value + 1)
            setSubpage({ kind: 'broadcasts' })
            void loadBroadcastOptions()
          }}
        />
      </section>
    )
  }

  return (
    <section className="card cardGrow notificationPage" data-testid="notification-configuration-page">
      <div className="pageHead notificationPageHead">
        <div>
          <h1 className="cardTitle">{t(locale, 'notification.title')}</h1>
          <p className="cardSubtitle">{t(locale, `notification.subtitle.${tab}`)}</p>
        </div>
      </div>

      <nav className="notificationTabs" aria-label={t(locale, 'notification.title')}>
        <button
          type="button"
          className={tab === 'system' ? 'notificationTopTab notificationTopTabActive' : 'notificationTopTab'}
          onClick={() => switchTab('system')}
          aria-current={tab === 'system' ? 'page' : undefined}
        >
          {t(locale, 'notification.tabs.system')}
        </button>
        <button
          type="button"
          className={tab === 'broadcasts' ? 'notificationTopTab notificationTopTabActive' : 'notificationTopTab'}
          onClick={() => switchTab('broadcasts')}
          aria-current={tab === 'broadcasts' ? 'page' : undefined}
        >
          {t(locale, 'notification.tabs.broadcasts')}
        </button>
        <button
          type="button"
          className={tab === 'sendLog' ? 'notificationTopTab notificationTopTabActive' : 'notificationTopTab'}
          onClick={() => switchTab('sendLog')}
          aria-current={tab === 'sendLog' ? 'page' : undefined}
        >
          {t(locale, 'notification.tabs.sendLog')}
        </button>
      </nav>

      {pageNotice ? (
        <div className="alert alertOk" role="status">
          {pageNotice}
        </div>
      ) : null}

      {subpage.kind === 'system' ? (
        <SystemNotificationsTab
          templates={templates}
          loading={templateLoading}
          errorMessage={templateError}
          onReload={() => void loadTemplates()}
          onEdit={(id) => {
            setPageNotice(null)
            setSubpage({ kind: 'template', id })
          }}
        />
      ) : null}

      {subpage.kind === 'broadcasts' ? (
        <BroadcastsTab
          refreshKey={refreshKey}
          onNew={() => {
            setPageNotice(null)
            setSubpage({ kind: 'broadcast-new' })
          }}
          onEdit={(broadcast) => {
            setPageNotice(null)
            setSubpage({ kind: 'broadcast-edit', broadcast })
          }}
        />
      ) : null}

      {subpage.kind === 'sendLog' ? (
        <SendLogTab templates={templates} broadcasts={broadcasts} />
      ) : null}
    </section>
  )
}
