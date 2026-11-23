import type {
  NotificationChannel,
  NotificationCopy,
  NotificationTemplate,
} from '../../contracts/notifications'
import { categoryLabel, previewContent } from '../../lib/notificationFormat'

/**
 * 右侧实时预览（B02/B03/B05、NTF-BO-018）：站内消息按 Notification Center 的样式，
 * 邮件按收件箱行 + 邮件正文的样式；样本值来自 PRD §13.2。
 */
export function NotificationPreview({
  template,
  copy,
  channel,
  label,
}: {
  template?: NotificationTemplate
  copy: NotificationCopy
  channel: NotificationChannel
  label?: string
}) {
  const content = previewContent(copy, channel)
  const category = label ?? (template ? categoryLabel(template.category) : 'Notification')
  if (channel === 'email') {
    return (
      <div className="notificationPreviewPanel" data-testid="notification-preview">
        <div className="notificationPreviewHead">
          <span>Preview</span>
          <span className="notificationPreviewHint">Sample data</span>
        </div>
        <div className="notificationMailInbox">
          <span className="notificationMailFrom">Learning Guide &lt;no-reply@…&gt;</span>
          <span className="notificationMailSubject">{content.subject || 'Subject'}</span>
        </div>
        <div className="notificationMailBody">
          <div className="notificationMailBrand">
            <span className="notificationMailLogo">LG</span>
            <strong>Learning Guide</strong>
          </div>
          <p className="notificationMailText">{content.body || 'Email body'}</p>
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
      <div className="notificationPreviewHead">
        <span>Preview</span>
        <span className="notificationPreviewHint">Sample data</span>
      </div>
      <div className="notificationCenterCard">
        <div className="notificationCenterHead">
          <span className="notificationBellIcon" aria-hidden="true">◔</span>
          <strong>Notifications</strong>
        </div>
        <div className="notificationCenterItem">
          <span className="notificationUnreadDot" aria-hidden="true" />
          <div className="notificationCenterItemBody">
            <span className="notificationCategoryLabel">{category.toUpperCase()}</span>
            <strong className="notificationCardTitle">{content.title || 'Title'}</strong>
            <p className="notificationCardBody">{content.body || 'Message'}</p>
            {content.buttonText ? (
              <span className="notificationCardLink">{content.buttonText} →</span>
            ) : null}
            <span className="notificationCardTime">Just now</span>
          </div>
        </div>
      </div>
      <p className="notificationPreviewSample">
        Sample values; plan = Everything · 12 months, renewal date = 16 Nov 2026,
        amount = US$149.00
      </p>
    </div>
  )
}
