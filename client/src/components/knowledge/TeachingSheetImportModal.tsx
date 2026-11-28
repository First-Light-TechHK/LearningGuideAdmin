import { useState } from 'react'
import { useActionLock } from '../../lib/useActionLock'
import { App, Button, Select, Space, Tag } from '../ui'
import { teachingCardsApi, type SheetPick, type TeachingSheetKind, type TeachingWorkbookReview } from '../../api/teachingCards'
import { useKText } from './i18n'
import { KnowledgeMarkdown } from './KnowledgeMarkdown'
import { TEACHING_TRANSFER_PAGE_SIZE, TeachingTransferFile, TeachingTransferPagination, TeachingTransferSection, TeachingTransferStep, type TransferContentProps } from './TeachingTransferStep'

type Props = TransferContentProps & {
  courseId: string
  canCreate: boolean
  saved: () => void
}

export function TeachingSheetImport({ courseId, canCreate, close, saved, stage, busy, setBusy, back, confirm }: Props) {
  const { text, locale } = useKText()
  const { message } = App.useApp()
  const t = (key: string, values?: Record<string, string | number>) => text('batchTeaching.' + key, values)
  const [pending, setPending] = useState<{ file: File; review: TeachingWorkbookReview } | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [targets, setTargets] = useState<Record<string, string>>({})
  const [checked, setChecked] = useState<string[]>([])
  const [pages, setPages] = useState<Partial<Record<TeachingSheetKind, number>>>({})
  const [error, setError] = useState('')
  const actions = useActionLock()
  const sheets = pending?.review.sheets ?? []
  const selectedKeys = new Set(checked)
  const picks = sheets.flatMap(({ kind, rows, targets: choices }) => rows.flatMap<SheetPick>(row => {
    const key = kind + ':' + row.row
    if (!selectedKeys.has(key)) return []
    const target = choices.find(item => item.id === targets[key])
    const pick = { kind, row: row.row, ...(row.binding ? { binding: row.binding } : {}) }
    if (target) return [{ ...pick, id: target.id, revision: target.revision }]
    return (row.status === 'new' || row.status === 'rename') && canCreate ? [pick] : []
  }))
  const duplicated = picks.some((pick, index) => pick.id && picks.findIndex(item => item.id === pick.id) !== index)

  const preview = async (file: File) => {
    const unlock = actions.acquire()
    if (!unlock) return
    setBusy(true)
    setError('')
    setPending(null)
    setChecked([])
    setPages({})
    try {
      const review = await teachingCardsApi.previewWorkbook(courseId, file)
      setPending({ file, review })
      setTargets(Object.fromEntries(review.sheets.flatMap(({ kind, rows }) => rows.map(row => [kind + ':' + row.row, row.targetId ?? '']))))
      setChecked(canCreate ? review.sheets.flatMap(({ kind, rows }) =>
        rows.filter(row => row.status === 'new').map(row => kind + ':' + row.row)) : [])
      confirm()
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
      unlock()
    }
  }

  const apply = async () => {
    if (!pending || !picks.length || busy || duplicated) return
    const unlock = actions.acquire()
    if (!unlock) return
    setBusy(true)
    setError('')
    try {
      const result = await teachingCardsApi.applyWorkbook(courseId, pending.file, picks, pending.review.stamp)
      message.success(t('saved', { count: result.saved }))
      saved()
    } catch (cause) {
      setError((cause as Error).message)
      setChecked([])
    } finally {
      setBusy(false)
      unlock()
    }
  }

  if (stage === 'prepare') return <TeachingTransferStep back={back} close={close} busy={busy}
    label={t('stepPreview')} disabled={!file} action={() => {
      if (file && pending?.file === file) confirm()
      else if (file) void preview(file)
    }}>
    <TeachingTransferSection title={t('templateFormat')}
      actions={<Button size="small" href={teachingCardsApi.templateUrl(courseId, 'workbook', locale)}>{t('template')}</Button>}>
      <div className="teaching-transfer-inset">
        <p>{t('fileFormat')} · {t('excelFormat')}</p>
        <p>{t('workbookHint')}</p>
        <p>{t('referenceHint', { example: '{{ref:L3-F01}}' })}</p>
      </div>
    </TeachingTransferSection>
    <TeachingTransferSection title={t('stepFile')}>
      <TeachingTransferFile label={t('file')} accept=".xlsx" busy={busy} files={file ? [file] : []} format={t('excelFormat')}
        onSelect={([selected]) => { setFile(selected); setError('') }}>
        {error && <p role="alert">{error}</p>}
      </TeachingTransferFile>
    </TeachingTransferSection>
  </TeachingTransferStep>

  return <TeachingTransferStep back={back} close={close} busy={busy} action={() => void apply()}
    label={t('confirm', { count: picks.length })} disabled={!picks.length || duplicated}>
    <TeachingTransferSection title={t('importPreview')}
      actions={<span className="teaching-transfer-muted" role="status">{t('importSelected', { count: picks.length })}</span>}>
      <fieldset disabled={busy} className="teaching-transfer-input">
        <div className="teaching-transfer-inset">
          {file && <Space wrap>{file.name}<Button size="small" onClick={() => void preview(file)}>{t('refresh')}</Button></Space>}
          {busy && <p role="status">{text('refImport.working')}</p>}
          {error && <p role="alert">{error}</p>}
          {duplicated && <p role="alert">{t('duplicateTarget')}</p>}
          {!!pending?.review.skippedSheets.length && <p role="status">{t('skippedSheets', { names: pending.review.skippedSheets.join(' · ') })}</p>}
        </div>
      </fieldset>
    </TeachingTransferSection>
    {sheets.map(({ kind, name, invalid, rows, targets: choices }) => {
      const columns = kind === 'concept'
        ? ['definitionName', 'definitionExcerpt', 'definitionBody']
        : ['studentQuestion', 'professorAnswer']
      const selected = picks.filter(pick => pick.kind === kind)
      const add = selected.filter(pick => !pick.id).length
      const conflicts = rows.filter(row => row.status === 'invalid' || row.status === 'duplicate').length
      const page = pages[kind] ?? 1
      const visible = rows.slice((page - 1) * TEACHING_TRANSFER_PAGE_SIZE, page * TEACHING_TRANSFER_PAGE_SIZE)
      const options = choices.map(item => ({ value: item.id, label: `${item.title} · ${item.id.slice(0, 8)}` }))
      return <TeachingTransferSection key={kind} title={name}>
        <fieldset disabled={busy} className="teaching-transfer-input">
          <div className="teaching-transfer-inset">
            {invalid ? <p role="alert">{t('invalidSheet')}</p> : rows.length
              ? <p>{t('summary', { add, update: selected.length - add, skip: rows.length - selected.length - conflicts, conflicts })}</p>
              : <p>{t('empty')}</p>}
          </div>
          {visible.map(row => {
            const key = kind + ':' + row.row
            const selectable = ['new', 'update', 'choose','rename'].includes(row.status)
            const target = choices.find(item => item.id === targets[key])
            const canAdd = ['new','rename'].includes(row.status) && canCreate
            const status = target && ['new','rename'].includes(row.status) ? 'update' : row.status
            const statusColor = status === 'new' ? 'success' : status === 'update' ? 'processing' : status === 'invalid' || status === 'duplicate' ? 'error' : undefined
            return <section key={key} className="teaching-transfer-row">
              <label className="teaching-transfer-choice"><input type="checkbox" checked={selectedKeys.has(key)} disabled={!selectable || (!target && !canAdd)} onChange={event => {
                const selected = event.target.checked
                setChecked(current => selected ? [...current, key] : current.filter(value => value !== key))
              }} /><span>{t('row', { row: row.row })} · {row.values[0]}</span><Tag color={statusColor}>{t(status)}</Tag></label>
              {row.sourcePage && <div>{text('teaching.sourcePage')} · {row.sourcePage}</div>}
              {row.issues.map((issue, index) => <div key={index} role="alert">
                {text('teaching.' + columns[issue.column])} · {t(issue.code, { detail: issue.detail ?? '' })}
              </div>)}
              {selectable && !!choices.length && <Space wrap>
                <span>{t('target')}</span>
                <Select<string> className="teaching-import-target" aria-label={t('target')} disabled={busy} size="small" showSearch
                  optionFilterProp="label" value={target?.id ?? ''} onChange={id => {
                  setTargets(current => ({ ...current, [key]: id }))
                  setChecked(current => current.filter(value => value !== key))
                }} options={[
                  { value: '', label: t(canAdd ? 'new' : 'choose'), disabled: !canAdd },
                  ...options.map(option => row.suggestedIds?.includes(option.value)
                    ? { ...option, label: option.label + ' · ' + t('suggestedTarget') } : option),
                ]} />
              </Space>}
              <details>
                <summary>{text('refImport.details')}</summary>
                {!!row.references?.length && <>
                  <strong>{t('resolvedReferences')}</strong>
                  <KnowledgeMarkdown courseId={courseId} references={row.references}
                    source={row.references.map(ref=>'['+ref.label+'](refobj:'+ref.id+')').join('\n\n')} />
                </>}
                {row.values.map((value, column) => <div key={column}>
                  <strong>{text('teaching.' + columns[column])}</strong>
                  {target && target.values[column] !== value && <p style={{ whiteSpace: 'pre-wrap' }}>{text('refImport.existing')} · {target.values[column]}</p>}
                  <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{value}</p>
                </div>)}
              </details>
            </section>
          })}
        </fieldset>
        {rows.length > TEACHING_TRANSFER_PAGE_SIZE && <TeachingTransferPagination page={page} total={rows.length}
          setPage={page => setPages(current => ({ ...current, [kind]: page }))} />}
      </TeachingTransferSection>
    })}
  </TeachingTransferStep>
}
