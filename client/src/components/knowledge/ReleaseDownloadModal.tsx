import { useState } from 'react'
import { useActionLock } from '../../lib/useActionLock'
import { Button, Modal, Space } from '../ui'
import { knowledgeApi, type ReleaseSummary } from '../../api/knowledge'
import { saveFileDownload } from '../../api/fileDownload'
import { formatDateTime } from '../../backoffice/lib/i18n/format'
import { useKText } from './i18n'
import { TeachingTransferProgress, TeachingTransferSection, TeachingTransferStep } from './TeachingTransferStep'
import './TeachingTransferModal.css'

const files = [
  { id: 'export', label: 'publish.readingDocuments', detail: 'publish.readingDocumentsHint', format: '.zip' },
  { id: 'package', label: 'publish.downloadPackage', detail: 'publish.downloadPackageHint', format: '.lgknowledge.zip' },
] as const

type VersionFile = typeof files[number]
type FileId = VersionFile['id']
type Result = { status: 'requested' } | { status: 'failed'; error: string }

export function ReleaseDownloadModal({ release, close }: { release: ReleaseSummary; close: () => void }) {
  const { locale, text } = useKText()
  const [confirming, setConfirming] = useState(false)
  const [selected, setSelected] = useState<FileId[]>([])
  const [busy, setBusy] = useState(false)
  const actions = useActionLock()
  const [results, setResults] = useState<Partial<Record<FileId, Result>>>({})
  const available = files.filter(file => file.id === 'export' || release.hasEditorSnapshot)
  const chosen = available.filter(file => selected.includes(file.id))
  const remaining = chosen.filter(file => results[file.id]?.status !== 'requested')
  const attempted = chosen.some(file => results[file.id])

  const download = async (items: readonly VersionFile[]) => {
    if (busy || !items.length) return
    const unlock = actions.acquire()
    if (!unlock) return
    setBusy(true)
    try {
      // Start each file separately and keep only its result so large ZIPs do not accumulate in memory.
      for (const { id } of items) {
        let result: Result
        try {
          saveFileDownload(await knowledgeApi.exportRelease(release.id, id))
          result = { status: 'requested' }
        } catch (cause) {
          result = { status: 'failed', error: cause instanceof Error && cause.message ? cause.message : text('publish.downloadFailed') }
        }
        setResults(current => ({ ...current, [id]: result }))
      }
    } finally {
      setBusy(false)
      unlock()
    }
  }

  const help = chosen.some(file => results[file.id]?.status === 'requested')
  return <Modal open width={600} title={text('publish.versionDownloadTitle')} footer={null}
    keyboard={!busy} closable={!busy} maskClosable={false} onCancel={() => { if (!busy) close() }}>
    <TeachingTransferProgress labels={[text('publish.chooseVersionFiles'), text('batchTeaching.stepDownloadConfirm')]} step={confirming ? 1 : 0} />
    <p className="teaching-transfer-course"><strong>{release.versionTag}</strong> {formatDateTime(locale, release.createdAt)}</p>
    {confirming ? <TeachingTransferStep back={() => setConfirming(false)} close={close} busy={busy}
      closeLabel={attempted ? text('common.close') : undefined}
      action={remaining.length ? () => void download(remaining) : undefined}
      label={text(attempted ? 'publish.downloadRemaining' : 'publish.downloadFileCount', { count: remaining.length })}>
      <TeachingTransferSection title={text('publish.filesToDownload')}
        actions={<span className="teaching-transfer-muted">{text('publish.individualFiles', { count: chosen.length })}</span>}>
        {chosen.map(file => {
          const result = results[file.id]
          return <div className="teaching-transfer-row teaching-transfer-result" key={file.id}>
            <div>{text(file.label)}</div>
            <Space size={6} wrap>
              <small className="teaching-transfer-muted">{file.format}</small>
              {result?.status === 'requested' &&
                <Button size="small" disabled={busy} onClick={() => void download([file])}>{text('publish.downloadAgain')}</Button>}
            </Space>
            {result?.status === 'failed' && <p role="alert">{result.error}</p>}
          </div>
        })}
      </TeachingTransferSection>
      {help && <p className="teaching-transfer-course" role="status">{text('publish.downloadAgainHint')}</p>}
    </TeachingTransferStep> : <TeachingTransferStep back={close} backLabel={text('publish.backToHistory')} close={close}
      action={() => setConfirming(true)} label={text('batchTeaching.stepNext')} disabled={!chosen.length}>
      <TeachingTransferSection title={text('publish.downloadableFiles')} actions={<Space wrap>
        <span className="teaching-transfer-muted" role="status">{text('publish.selectedVersionFiles', { count: chosen.length, total: available.length })}</span>
        <Button size="small" onClick={() => setSelected(available.map(file => file.id))}>{text('batchTeaching.selectAll')}</Button>
        <Button size="small" onClick={() => setSelected([])}>{text('refImport.clear')}</Button>
      </Space>}>
        <fieldset className="teaching-transfer-input" aria-label={text('publish.downloadableFiles')}>
          {files.map(file => <label className="teaching-transfer-row teaching-transfer-choice" key={file.id}>
            <input type="checkbox" checked={selected.includes(file.id)} disabled={file.id !== 'export' && !release.hasEditorSnapshot}
              onChange={event => {
                const checked = event.target.checked
                setSelected(current => checked ? [...current, file.id] : current.filter(id => id !== file.id))
              }} />
            <span>{text(file.label)}<small className="teaching-transfer-muted">{text(file.detail)}</small></span>
            <small className="teaching-transfer-muted teaching-transfer-format">{file.format}</small>
          </label>)}
        </fieldset>
        {!release.hasEditorSnapshot && <p className="teaching-transfer-inset teaching-transfer-muted">{text('publish.legacyPackage')}</p>}
      </TeachingTransferSection>
    </TeachingTransferStep>}
  </Modal>
}
