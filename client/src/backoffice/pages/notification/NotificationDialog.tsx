import type { ReactNode } from 'react'

import { CloseIcon } from '../../components/icons'

/** Notification Configuration 的确认弹窗；沿用 BackOffice 现有 modal 样式。 */
export function NotificationDialog({
  title,
  children,
  confirmLabel,
  danger,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string
  children?: ReactNode
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="modalBackdrop">
      <div className="modal smModal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modalHead">
          <h2 className="modalTitle">{title}</h2>
          <button type="button" className="modalClose" aria-label="Close" onClick={onCancel}>
            <CloseIcon size={16} />
          </button>
        </div>
        <div className="modalBody">
          {typeof children === 'string' ? <p className="cardBody">{children}</p> : children}
        </div>
        <div className="modalFooter">
          <button type="button" className="button buttonGhost" onClick={onCancel} disabled={busy}>
            Cancel
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

/** 固定 20 条分页（广播 / 发送日志）：只显示上一页、页码、下一页。 */
export function NotificationPager({
  page,
  total,
  pageSize,
  onChange,
}: {
  page: number
  total: number
  pageSize: number
  onChange: (page: number) => void
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const from = total > 0 ? (page - 1) * pageSize + 1 : 0
  const to = Math.min(page * pageSize, total)
  return (
    <div className="pagination">
      <span className="paginationSummary">
        {total === 0 ? 'No records' : `${from}–${to} of ${total}`}
      </span>
      <div className="paginationControls">
        <button
          type="button"
          className="pagerButton"
          disabled={page <= 1}
          onClick={() => onChange(Math.max(1, page - 1))}
          aria-label="Previous page"
        >
          ‹
        </button>
        <span className="pageOf">
          Page {page} of {totalPages}
        </span>
        <button
          type="button"
          className="pagerButton"
          disabled={page >= totalPages}
          onClick={() => onChange(Math.min(totalPages, page + 1))}
          aria-label="Next page"
        >
          ›
        </button>
      </div>
    </div>
  )
}
