import { BellIcon } from '../../components/icons'
import type {
  NotificationChannel,
  NotificationCopy,
  NotificationTemplate,
} from '../../contracts/notifications'
import type { Locale } from '../../lib/i18n/config'
import { t } from '../../lib/i18n/messages'
import { categoryLabel, previewContent } from '../../lib/notificationFormat'

/**
 * 右侧实时预览（B02/B03/B05、NTF-BO-018）：站内消息按 Notification Center 的样式，
 * 邮件按收件箱行 + 邮件正文的样式；样本值来自 PRD §13.2。
 * 广播没有变量，传 sample={false}：不显示样本值说明，提示改为“用户看到的样子”。
 */
export function NotificationPreview({
  template,
  copy,
  channel,
  label,
  locale,
  sample = true,
}: {
  template?: NotificationTemplate
  copy: NotificationCopy
  channel: NotificationChannel
  label?: string
  locale: Locale
  sample?: boolean
}) {
  const content = previewContent(copy, channel)
  const category = label ?? (template ? categoryLabel(template.category, locale) : t(locale, 'notification.title'))
  const head = (
    <div className="notificationPreviewHead">
      <span>{t(locale, 'notification.preview.title')}</span>
      <span className="notificationPreviewHint">
        {t(locale, sample ? 'notification.preview.sampleData' : 'notification.preview.asLearnersSee')}
      </span>
    </div>
  )
  if (channel === 'email') {
    return (
      <div className="notificationPreviewPanel" data-testid="notification-preview">
        {head}
        <div className="notificationMailInbox">
          <span className="notificationMailFrom">Learning Guide &lt;no-reply@…&gt;</span>
          <span className="notificationMailSubject">
            {content.subject || t(locale, 'notification.preview.subjectPlaceholder')}
          </span>
        </div>
        <div className="notificationMailBody">
          <div className="notificationMailBrand">
            <span className="notificationMailLogo">LG</span>
            <strong>Learning Guide</strong>
          </div>
          <p className="notificationMailText">
            {content.body || t(locale, 'notification.preview.emailBodyPlaceholder')}
          </p>
          {content.buttonText ? (
            <span className="notificationPreviewButton">{content.buttonText}</span>
          ) : null}
          <p className="notificationMailFooter">
            You're receiving this email because you have a Learning Guide subscription.
            Learning Guide Ltd · Privacy policy
          </p>
        </div>
      </div>
    )
  }
  return (
    <div className="notificationPreviewPanel" data-testid="notification-preview">
      {head}
      <div className="notificationCenterCard">
        <div className="notificationCenterHead">
          <BellIcon className="notificationBellIcon" size={16} />
          <strong>{t(locale, 'notification.preview.centerTitle')}</strong>
        </div>
        <div className="notificationCenterItem">
          <span className="notificationUnreadDot" aria-hidden="true" />
          <div className="notificationCenterItemBody">
            <span className="notificationCategoryLabel">{category.toUpperCase()}</span>
            <strong className="notificationCardTitle">
              {content.title || t(locale, 'notification.preview.titlePlaceholder')}
            </strong>
            <p className="notificationCardBody">
              {content.body || t(locale, 'notification.preview.messagePlaceholder')}
            </p>
            {content.buttonText ? (
              <span className="notificationCardLink">{content.buttonText} →</span>
            ) : null}
            <span className="notificationCardTime">{t(locale, 'notification.preview.justNow')}</span>
          </div>
        </div>
      </div>
      {sample ? (
        <p className="notificationPreviewSample">{t(locale, 'notification.preview.sampleValues')}</p>
      ) : null}
    </div>
  )
}
