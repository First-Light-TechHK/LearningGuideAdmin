import { useState } from 'react'
import { useActionLock } from '../../lib/useActionLock'
import { Button, Input, Space, Tabs } from '../ui'
import { teachingCardsApi, teachingSheetNames, type TeachingImportKind, type TeachingTransferKind } from '../../api/teachingCards'
import { saveFileDownload } from '../../api/fileDownload'
import { referenceDownloadParts, referenceTransferLimits } from '../../api/referenceDownload'
import { useKText } from './i18n'
import { TEACHING_TRANSFER_PAGE_SIZE, TeachingTransferPagination, TeachingTransferSection, TeachingTransferStep, type TransferContentProps } from './TeachingTransferStep'

type EntryGroup = { kind: TeachingImportKind; entries: { id: string; title: string }[] }
type Props = TransferContentProps & { courseId: string; kind: TeachingTransferKind; groups: EntryGroup[] }
type Part = { offset: number; count: number; filename: string }

export function TeachingDownload({ courseId, kind, groups, close, stage, busy, setBusy, back, confirm }: Props) {
  const { text, locale } = useKText()
  const entries = groups.flatMap(group => group.entries)
  const [selected, setSelected] = useState(() => new Set(entries.map(entry => entry.id)))
  const [parts, setParts] = useState<Part[]>([])
  const [error, setError] = useState('')
  const [activeKind, setActiveKind] = useState<TeachingImportKind | undefined>(() => (groups.find(group => group.entries.length) ?? groups[0])?.kind)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const actions = useActionLock()
  const selectedEntries = entries.filter(entry => selected.has(entry.id))
  const group = groups.find(group => group.kind === activeKind)
  const groupEntries = group?.entries ?? []
  const query = search.trim().normalize('NFKC').toLocaleLowerCase(locale)
  const filtered = groupEntries.filter(entry => entry.title.normalize('NFKC').toLocaleLowerCase(locale).includes(query))
  const pageCount = Math.max(1, Math.ceil(filtered.length / TEACHING_TRANSFER_PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const visible = filtered.slice((currentPage - 1) * TEACHING_TRANSFER_PAGE_SIZE, currentPage * TEACHING_TRANSFER_PAGE_SIZE)
  const sheets = groups.flatMap(({ kind, entries }) => {
    if (kind === 'latex' || kind === 'image') return []
    const ids = entries.filter(entry => selected.has(entry.id)).map(entry => entry.id)
    return ids.length ? [{ kind, ids }] : []
  })

  function resetFiles() {
    setError('')
    setParts([])
  }

  function changeSelection(ids: string[], checked: boolean) {
    resetFiles()
    setSelected(current => {
      const next = new Set(current)
      for (const id of ids) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  async function download() {
    if (!selectedEntries.length || busy) return
    const unlock = actions.acquire()
    if (!unlock) return
    setBusy(true)
    setError('')
    setParts([])
    try {
      if (kind === 'workbook') {
        saveFileDownload(await teachingCardsApi.downloadWorkbook(courseId, sheets))
        close()
        return
      }
      const ids = selectedEntries.map(entry => entry.id)
      for await (const { offset, count, split, file } of referenceDownloadParts(ids.length, referenceTransferLimits[kind].rows,
        (offset, count) => teachingCardsApi.download(courseId, kind, ids.slice(offset, offset + count), locale))) {
        const filename = file.filename
        saveFileDownload(file)
        if (split) setParts(current => [...current, { offset, count, filename }])
        else close()
      }
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
      unlock()
    }
  }

  async function downloadPart(part: Part) {
    if (kind === 'workbook') return
    const unlock = actions.acquire()
    if (!unlock) return
    setBusy(true)
    setError('')
    try {
      const ids = selectedEntries.slice(part.offset, part.offset + part.count).map(entry => entry.id)
      const file = await teachingCardsApi.download(courseId, kind, ids, locale)
      if (!file) throw new Error(text('publish.downloadFailed'))
      saveFileDownload({ ...file, filename: part.filename })
    } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false); unlock() }
  }

  if (stage === 'prepare') return <TeachingTransferStep back={back} close={close} scrollBody={kind !== 'workbook'}
    action={confirm} disabled={!selectedEntries.length} label={text('batchTeaching.stepNext')}>
    <TeachingTransferSection title={text('batchTeaching.downloadableEntries')} actions={entries.length > 0 && <Space wrap>
      <span className="teaching-transfer-muted" role="status">{text('batchTeaching.selectedEntries', { count: selectedEntries.length, total: entries.length })}</span>
      <Button size="small" onClick={() => { setSelected(new Set(entries.map(entry => entry.id))); resetFiles() }}>{text('batchTeaching.selectAll')}</Button>
      <Button size="small" onClick={() => { setSelected(new Set()); resetFiles() }}>{text('refImport.clear')}</Button>
    </Space>}>
      {entries.length ? kind === 'workbook' ? <Tabs className="teaching-download-tabs" activeKey={activeKind}
        onChange={key => {
          setActiveKind(groups.find(group => group.kind === key)?.kind)
          setPage(1)
          setSearch('')
        }} items={groups.map(({ kind: groupKind, entries }) => ({
          key: groupKind,
          label: `${text('batchTeaching.kind.' + groupKind)} (${entries.filter(entry => selected.has(entry.id)).length}/${entries.length})`,
          children: groupKind === activeKind && <>
            {groupEntries.length ? <>
              <div className="teaching-download-controls">
                <Input allowClear value={search} aria-label={text('batchTeaching.search.' + groupKind)}
                  placeholder={text('batchTeaching.search.' + groupKind)} onChange={event => { setSearch(event.target.value); setPage(1) }} />
                <Space wrap>
                  <Button size="small" onClick={() => changeSelection(groupEntries.map(entry => entry.id), true)}>{text('batchTeaching.selectCategory')}</Button>
                  {query && <Button size="small" disabled={!filtered.length} onClick={() => changeSelection(filtered.map(entry => entry.id), true)}>{text('batchTeaching.selectMatches')}</Button>}
                  <Button size="small" onClick={() => changeSelection(groupEntries.map(entry => entry.id), false)}>{text('batchTeaching.clearCategory')}</Button>
                </Space>
              </div>
              <fieldset key={currentPage + ':' + query} className="teaching-transfer-input teaching-download-list"
                aria-label={text('batchTeaching.kind.' + groupKind)}>
                {visible.map(entry => <label key={entry.id} className="teaching-transfer-row teaching-transfer-choice">
                  <input type="checkbox" checked={selected.has(entry.id)} onChange={event => changeSelection([entry.id], event.target.checked)} />
                  <span>{entry.title}</span>
                </label>)}
                {!visible.length && <p className="teaching-transfer-inset">{text('batchTeaching.noMatches')}</p>}
              </fieldset>
              {pageCount > 1 && <TeachingTransferPagination page={currentPage} total={filtered.length} setPage={setPage} />}
            </> : <p className="teaching-transfer-inset">{text('batchTeaching.noSavedEntries')}</p>}
          </>,
        }))} /> : <fieldset className="teaching-transfer-input" aria-label={text('batchTeaching.downloadableEntries')}>
          {entries.map(entry => <label key={entry.id} className="teaching-transfer-row teaching-transfer-choice">
            <input type="checkbox" checked={selected.has(entry.id)} onChange={event => changeSelection([entry.id], event.target.checked)} />
            <span>{entry.title}</span>
          </label>)}
        </fieldset> : <p className="teaching-transfer-inset">{text('batchTeaching.noSavedEntries')}</p>}
    </TeachingTransferSection>
  </TeachingTransferStep>

  const format = text(kind === 'image' || kind === 'latex' ? 'batchTeaching.wordFormat' : 'batchTeaching.excelFormat')
  return <TeachingTransferStep back={back} close={close} busy={busy} action={!parts.length || error ? () => void download() : undefined}
    label={text('batchTeaching.downloadCount', { count: selectedEntries.length })} disabled={!selectedEntries.length}>
    <TeachingTransferSection title={text('batchTeaching.downloadContent')}>
      <dl className="teaching-transfer-inset teaching-transfer-summary">
        <div><dt className="teaching-transfer-muted">{text('batchTeaching.entryType')}</dt><dd>{text('batchTeaching.kind.' + kind)}</dd></div>
        <div><dt className="teaching-transfer-muted">{text('batchTeaching.fileFormat')}</dt><dd>{format}</dd></div>
        <div><dt className="teaching-transfer-muted">{text('batchTeaching.entryCount')}</dt><dd>{selectedEntries.length}</dd></div>
      </dl>
      {!!sheets.length && <div className="teaching-transfer-inset">
        <p>{text('batchTeaching.workbookFileCount', { count: sheets.length })}</p>
        <ul>{sheets.map(({ kind, ids }) => <li key={kind}>{teachingSheetNames[kind]} · {text('batchTeaching.sheetRows', { count: ids.length })}</li>)}</ul>
      </div>}
      {error && <p className="teaching-transfer-inset" role="alert">{error}</p>}
      {!!parts.length && <div className="teaching-transfer-inset"><Space wrap>{parts.map(part => <Button key={part.offset} disabled={busy} onClick={() => void downloadPart(part)}>
        {part.filename}
      </Button>)}</Space></div>}
    </TeachingTransferSection>
  </TeachingTransferStep>
}
