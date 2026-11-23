import { useRef, type ReactNode } from 'react'

import { CloseIcon } from '../../components/icons'
import { useModal } from '../../helpdesk/useModal'
import type { Locale } from '../../lib/i18n/config'
import { t } from '../../lib/i18n/messages'

/** Notification Configuration 的确认弹窗；沿用 BackOffice 现有 modal 样式和键盘行为（Esc 关闭、Tab 不出弹窗）。 */
export function NotificationDialog({
  locale,
  title,
  children,
  confirmLabel,
  danger,
  busy,
  onCancel,
  onConfirm,
}: {
  locale: Locale
  title: string
  children?: ReactNode
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const modal = useRef<HTMLDivElement>(null)
  useModal(() => modal.current, onCancel)
  return (
    <div className="modalBackdrop">
      <div ref={modal} className="modal smModal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modalHead">
          <h2 className="modalTitle">{title}</h2>
          <button type="button" className="modalClose" aria-label={t(locale, 'common.close')} onClick={onCancel}>
            <CloseIcon size={16} />
          </button>
        </div>
        <div className="modalBody">
          {typeof children === 'string' ? <p className="cardBody">{children}</p> : children}
        </div>
        <div className="modalFooter">
          <button type="button" className="button buttonGhost" onClick={onCancel} disabled={busy}>
            {t(locale, 'common.cancel')}
          </button>
          <button
            type="button"
            className={danger ? 'button buttonDanger' : 'button'}
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
