import { useRef, type ReactNode } from 'react'
import { Button, Space } from '../ui'
import { useKText } from './i18n'

export type TransferContentProps = {
  stage: 'prepare' | 'confirm'
  busy: boolean
  setBusy: (busy: boolean) => void
  confirm: () => void
  back: () => void
  close: () => void
}

export const TEACHING_TRANSFER_PAGE_SIZE = 20

export function TeachingTransferPagination({ page, total, setPage }: { page: number; total: number; setPage: (page: number) => void }) {
  const { text } = useKText()
  const pages = Math.max(1, Math.ceil(total / TEACHING_TRANSFER_PAGE_SIZE))
  return <div className="teaching-download-controls teaching-download-pagination">
    <small role="status">{text('batchTeaching.pageCount', { page, pages, total })}</small>
    <Space wrap>
      <Button size="small" disabled={page === 1} onClick={() => setPage(page - 1)}>{text('batchTeaching.previousPage')}</Button>
      <Button size="small" disabled={page === pages} onClick={() => setPage(page + 1)}>{text('batchTeaching.nextPage')}</Button>
    </Space>
  </div>
}

export function TeachingTransferSection({ title, actions, children }: {
  title: string
  actions?: ReactNode
  children: ReactNode
}) {
  return <section className="teaching-transfer-section">
    <div className="teaching-transfer-section-heading">
      <h3>{title}</h3>
      {actions}
    </div>
    {children}
  </section>
}

export function TeachingTransferProgress({ labels, step }: { labels: string[]; step: number }) {
  const { text } = useKText()
  return <ol className="teaching-transfer-steps" aria-label={text('batchTeaching.stepProgress')}>
    {labels.map((label, index) => <li key={label} aria-current={step === index ? 'step' : undefined}
      data-complete={step > index || undefined}>{index > 0 && <span aria-hidden="true">→</span>}{label}</li>)}
  </ol>
}

export function TeachingTransferFile({ label, accept, multiple, busy, files, format, onSelect, children }: {
  label: string
  accept: string
  multiple?: boolean
  busy: boolean
  files: File[]
  format: string
  onSelect: (files: File[]) => void
  children?: ReactNode
}) {
  const input = useRef<HTMLInputElement>(null)
  const { text } = useKText()
  return <div className="teaching-transfer-inset teaching-transfer-file">
    <div className="teaching-transfer-file-control">
      <div>
        <div>{files.length ? files.map(file => file.name).join(' · ') : text('common.noFileSelected')}</div>
        <small className="teaching-transfer-muted">{format}</small>
      </div>
      <input ref={input} type="file" accept={accept} multiple={multiple} disabled={busy} hidden aria-label={label}
        onChange={event => {
          const selected = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (selected.length) onSelect(selected)
        }} />
      <Button size="small" disabled={busy} onClick={() => input.current?.click()}>{text('common.chooseFile')}</Button>
    </div>
    {children}
  </div>
}

export function TeachingTransferStep({ children, back, backLabel, close, closeLabel, busy, action, label, disabled, scrollBody = true }: {
  children: ReactNode
  back?: () => void
  backLabel?: string
  close: () => void
  closeLabel?: string
  busy?: boolean
  action?: () => void
  label?: string
  disabled?: boolean
  scrollBody?: boolean
}) {
  const { text } = useKText()
  return <>
    <div className={scrollBody ? 'teaching-transfer-scroll' : undefined}>{children}</div>
    <div className="teaching-transfer-footer">
      {back && <Button disabled={busy} onClick={back}>{backLabel ?? text('batchTeaching.stepBack')}</Button>}
      <Space wrap>
        <Button disabled={busy} onClick={close}>{closeLabel ?? text('common.cancel')}</Button>
        {action && <Button type="primary" loading={busy} disabled={disabled || busy} onClick={action}>{label}</Button>}
      </Space>
    </div>
  </>
}
