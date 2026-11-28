import { useEffect, useRef, useState } from 'react'
import { useActionLock } from '../../lib/useActionLock'
import { App, Button, Space, Tag } from '../ui'
import { TutorMarkdown } from '../ai/TutorMarkdown'
import { teachingCardsApi, type TeachingEntry } from '../../api/teachingCards'
import { referenceTransferLimits } from '../../api/referenceDownload'
import { useKText } from './i18n'
import { matchReference, normalizeCode, parseReferences, referenceDraft, type Candidate } from './referenceImport'
import { TeachingTransferFile, TeachingTransferSection, TeachingTransferStep, type TransferContentProps } from './TeachingTransferStep'

type ImportRow = Candidate & { checked: boolean }
type Props = TransferContentProps & { courseId: string; canCreate: boolean; kind: Candidate['kind']; saved: () => void }

function similar(row: Candidate, entries: TeachingEntry[]) {
  return entries.filter(e => e.draft.approvedPayload.refObjects?.[0]?.kind === row.kind &&
    ((row.names.zh && e.draft.bilingual.conceptLabel.zh === row.names.zh) ||
      (row.names.en && e.draft.bilingual.conceptLabel.en === row.names.en)))
}

export function ReferenceImport({ courseId, canCreate, kind, close, saved, stage, busy, setBusy, back, confirm }: Props) {
  const { text, locale } = useKText()
  const t = (key: string, vars?: Record<string, string | number>) => text('refImport.' + key, vars)
  const limits = referenceTransferLimits[kind]
  const format = t('format', { size: limits.mib })
  const { message } = App.useApp()
  const [rows, setRows] = useState<ImportRow[]>([])
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [previewedFiles, setPreviewedFiles] = useState<File[] | null>(null)
  const [entries, setEntries] = useState<TeachingEntry[]>([])
  const [deleted, setDeleted] = useState<string[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const actions = useActionLock()
  const [expanded, setExpanded] = useState<number | null>(null)
  const [usage, setUsage] = useState<Record<string, string[]>>({})
  const [inherited, setInherited] = useState<string[]>([])
  const tokens = useRef<string[]>([])
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    const pendingTokens = tokens.current
    return () => {
      mounted.current = false
      const pending = pendingTokens.splice(0)
      if (pending.length) void teachingCardsApi.finishReferenceDocuments(courseId, pending).catch(() => undefined)
    }
  },[courseId])
  const finish = async () => {
    const pending = tokens.current.splice(0)
    if (pending.length) await teachingCardsApi.finishReferenceDocuments(courseId, pending).catch(() => undefined)
  }
  const matches = rows.map(row => matchReference(row, entries, deleted))
  const keys = rows.map((row, index) => matches[index].target?.id ?? 'code:' + normalizeCode(row.code))
  const statuses = matches.map((match, i) => rows[i].kind !== kind ? 'wrongKind' :
    !match.target && inherited.includes(normalizeCode(rows[i].code)) ? 'conflict' :
    keys.indexOf(keys[i]) !== keys.lastIndexOf(keys[i]) ? 'duplicate' : match.status)
  const allowed = (i: number) => statuses[i] === 'update' || (canCreate && ['new', 'recreate'].includes(statuses[i]))
  const selected = rows.map((row, i) => row.checked && allowed(i) ? i : -1).filter(i => i !== -1)
  const newCount = selected.filter(i => !matches[i].target).length
  const updates = selected.filter(i => !!matches[i].target)
  const conflicts = statuses.filter(status => ['duplicate','conflict','wrongKind'].includes(status)).length
  const visible = rows.map((row, i) => [row.file, row.lesson, row.code, row.names.zh, row.names.en, t(statuses[i])].join(' ')
    .toLowerCase().includes(filter.trim().toLowerCase()) ? i : -1).filter(i => i !== -1)
  const change = (index: number, patch: Partial<ImportRow>) => setRows(current => current.map((r, i) => i === index ? { ...r, checked: false, ...patch } : r))

  const load = async (files: File[]) => {
    if (!files.length) return
    if (files.length > limits.rows) {
      setErrors([t('fileLimit', { count: limits.rows })])
      return
    }
    const unlock = actions.acquire()
    if (!unlock) return
    setBusy(true)
    setPreviewedFiles(null)
    setRows([])
    setFilter('')
    setExpanded(null)
    setErrors([])
    const warnings: string[] = []
    try {
      await finish()
      const [all, retired, catalogue] = await Promise.all([
        teachingCardsApi.list(courseId), teachingCardsApi.deletedReferenceCodes(courseId), teachingCardsApi.references(courseId),
      ])
      const current = all.filter(e => e.draft.type === 'ref_obj')
      setInherited(catalogue.filter(ref=>!current.some(entry=>entry.id===ref.id)).map(ref=>normalizeCode(ref.code??'')))
      setEntries(current)
      setDeleted(retired)
      const result: ImportRow[] = []
      const imageBytes = async (asset: string) => {
        const response = await fetch('/api/files/images/' + encodeURIComponent(courseId) + '/' + encodeURIComponent(asset))
        return response.ok ? new Uint8Array(await response.arrayBuffer()) : null
      }
      for (const file of files) {
        try {
          if (!/\.(md|docx)$/i.test(file.name) || file.size > limits.mib * 1024 * 1024) throw new Error(format)
          const preview = /\.md$/i.test(file.name) ? {markdown:new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())}
            : await teachingCardsApi.previewReferenceDocument(courseId,kind,file)
          if (preview.token) {
            if (!mounted.current) {
              void teachingCardsApi.finishReferenceDocuments(courseId,[preview.token]).catch(()=>undefined)
              return
            }
            tokens.current.push(preview.token)
          }
          const candidates: Candidate[] = preview.rows
            ? preview.rows.map((row,index)=>({...row,file:file.name,lesson:'',line:index+1,issue:row.value?undefined:'missingAsset'}))
            : parseReferences(preview.markdown ?? '', file.name, courseId)
          if (!candidates.length) throw new Error(t('noRows'))
          if (candidates.length + result.length > limits.rows) throw new Error(t('limit', { count: limits.rows }))
          const parsed: ImportRow[] = []
          for (const row of candidates) {
            const { target, status } = matchReference(row, current, retired)
            const old = target?.draft.approvedPayload.refObjects?.[0]
            if (status === 'update' && old?.kind === 'image' && old.value !== row.value) {
              const before = await imageBytes(old.value)
              const after = await imageBytes(row.value)
              if (!after) throw new Error(t('missingAsset'))
              if (before && before.length === after.length && before.every((byte, i) => byte === after[i])) row.value = old.value
            }
            parsed.push({ ...row, checked: row.kind === kind && status === 'new' && canCreate && !similar(row, current).length })
          }
          result.push(...parsed)
        } catch (e) { warnings.push(file.name + ' · ' + (e as Error).message) }
      }
      setRows(result)
      setErrors(warnings)
      if (result.length) {
        setPreviewedFiles(files)
        confirm()
      }
    } catch (e) { setErrors([(e as Error).message]) }
    finally { setBusy(false); unlock() }
  }

  const submit = async () => {
    if (busy || !selected.length) return
    const unlock = actions.acquire()
    if (!unlock) return
    setBusy(true)
    try {
      const items = selected.map(i => {
        const target = matches[i].target
        return { id: target?.id, revision: target?.revision, recreate: statuses[i] === 'recreate', draft: referenceDraft(rows[i], target) }
      })
      const result = await teachingCardsApi.importReferences(courseId, items)
      await finish()
      message.success(text('refImport.saved', { count: result.saved }))
      saved()
    } catch (e) {
      setErrors([(e as Error).message])
      if(tokens.current.length) { await finish(); setRows([]); setPreviewedFiles(null) }
      else setRows(current => current.map(row => ({ ...row, checked: false })))
      try {
        const latest = await teachingCardsApi.list(courseId)
        setEntries(latest.filter(entry => entry.draft.type === 'ref_obj'))
        setDeleted(await teachingCardsApi.deletedReferenceCodes(courseId))
      } catch (refreshError) {
        setErrors(current => [...current, (refreshError as Error).message])
      }
    } finally { setBusy(false); unlock() }
  }

  if (stage === 'prepare') return <TeachingTransferStep back={back} close={close} busy={busy}
    label={text('batchTeaching.stepPreview')} disabled={!selectedFiles.length} action={() => {
      if (previewedFiles === selectedFiles) confirm()
      else void load(selectedFiles)
    }}>
    <TeachingTransferSection title={text('batchTeaching.templateFormat')}
      actions={<Button size="small" href={teachingCardsApi.templateUrl(courseId, kind, locale)}>{text('batchTeaching.template')}</Button>}>
      <div className="teaching-transfer-inset">
        <p>{text('batchTeaching.fileFormat')} · {text('batchTeaching.wordFormat')}</p>
        <p>{text('batchTeaching.' + kind + 'Hint')}</p>
      </div>
    </TeachingTransferSection>
    <TeachingTransferSection title={text('batchTeaching.stepFile')}>
      <TeachingTransferFile label={t('files')} multiple accept=".md,.docx" busy={busy} files={selectedFiles} format={format}
        onSelect={files => { setSelectedFiles(files); setErrors([]) }}>
        {busy && <p role="status">{t('working')}</p>}
        {errors.map((e, i) => <p key={i} role="alert">{e}</p>)}
      </TeachingTransferFile>
    </TeachingTransferSection>
  </TeachingTransferStep>

  return <TeachingTransferStep back={back} close={close} busy={busy} disabled={!selected.length}
    label={text('refImport.confirm', { count: selected.length })} action={() => void submit()}>
    <TeachingTransferSection title={text('batchTeaching.importPreview')}
      actions={<span className="teaching-transfer-muted" role="status">{text('batchTeaching.importSelected', { count: selected.length })}</span>}>
      <fieldset disabled={busy} className="teaching-transfer-input">
        <div className="teaching-transfer-inset">
          {busy && <p role="status">{t('working')}</p>}
          {errors.map((e, i) => <p key={i} role="alert">{e}</p>)}
          {!!rows.length && <>
            <p>{text('batchTeaching.summary', {add:newCount,update:selected.length-newCount,skip:rows.length-selected.length-conflicts,conflicts})}</p>
            {!!updates.length && <p>{text('batchTeaching.referenceUpdateNotice')}</p>}
            <Space wrap>
              <input type="search" aria-label={t('filter')} placeholder={t('filter')} value={filter} onChange={e => setFilter(e.target.value)} />
              <Button disabled={busy} onClick={() => setRows(current => current.map((r, i) => ({ ...r, checked: visible.includes(i) && allowed(i) && statuses[i] !== 'recreate' })))}>
                {t('select')}
              </Button>
              <Button disabled={busy} onClick={() => setRows(current => current.map(r => ({ ...r, checked: false })))}>{t('clear')}</Button>
            </Space>
          </>}
        </div>
        {!!rows.length && <>
          <div>
            {visible.map(i => {
              const row = rows[i], target = matches[i].target
              const status = statuses[i]
              const statusColor = status === 'new' ? 'success' : status === 'update' ? 'processing' : ['conflict','duplicate','wrongKind'].includes(status) ? 'error' : undefined
              return <section key={i} className="teaching-transfer-row">
                <label className="teaching-transfer-choice"><input type="checkbox" disabled={!allowed(i)} checked={row.checked && allowed(i)}
                  onChange={e => change(i, { checked: e.target.checked })} />
                  <span>{[row.code, row.names.zh, row.names.en].filter(Boolean).join(' · ')}</span><Tag color={statusColor}>{t(status)}</Tag>
                </label>
                <div className="teaching-transfer-muted">{[row.file, row.lesson, '#' + row.line].filter(Boolean).join(' · ')}</div>
                {!target && similar(row, entries).length > 0 && <small>{t('suggestion')} · {similar(row, entries).map(e => e.draft.approvedPayload.code).join(', ')}</small>}
                {statuses[i] === 'duplicate' && <Button size="small" onClick={() => setRows(current => current.filter((_, k) => k !== i))}>{t('remove')}</Button>}
                {row.issue && <div>{t(row.issue)}</div>}
                <button type="button" aria-expanded={expanded === i} onClick={() => {
                  setExpanded(expanded === i ? null : i)
                  if(target && statuses[i]==='update' && !usage[target.id])
                    void teachingCardsApi.referenceUsage(courseId,target.id,target.revision)
                      .then(blockers=>setUsage(current=>({...current,[target.id]:[...new Set(blockers.map(row=>row.source))]})))
                      .catch((cause:Error)=>setErrors(current=>[...current,cause.message]))
                }}>{t('details')}</button>
                {expanded === i && <div>
                  {target && !!usage[target.id]?.length && <p>{text('batchTeaching.usedBy', {items:usage[target.id].join(' · ')})}</p>}
                  {target && <p>{[t('existing'), target.draft.approvedPayload.code, target.draft.bilingual.conceptLabel.zh, target.draft.bilingual.conceptLabel.en].filter(Boolean).join(' · ')}
                    <br />{target.draft.bilingual.summary.zh}<br />{target.draft.bilingual.summary.en}
                    {target.draft.approvedPayload.refObjects?.map(ref => ref.kind === 'image'
                      ? <img key={ref.id} src={'/api/files/images/' + encodeURIComponent(courseId) + '/' + encodeURIComponent(ref.value)} alt={ref.label} width={120} loading="lazy" />
                      : <code key={ref.id}>{ref.value}</code>)}</p>}
                  <label>{text('teaching.code')} <input list="import-reference-codes" value={row.code} onChange={e => change(i, { code: e.target.value })} /></label>
                  {(['zh', 'en'] as const).map(lang => <div key={lang}>
                    <label>{text('teaching.concept.' + lang)} <input value={row.names[lang]} onChange={e => change(i, { names: { ...row.names, [lang]: e.target.value } })} /></label>
                    <label>{text('teaching.summary.' + lang)} <textarea value={row.summary[lang]} onChange={e => change(i, { summary: { ...row.summary, [lang]: e.target.value } })} /></label>
                  </div>)}
                  {row.kind === 'latex' ? <>
                    <label>{text('teaching.formula')} <textarea value={row.value} onChange={e => change(i, { value: e.target.value, issue: undefined })} /></label>
                    <TutorMarkdown courseId={courseId} content={'$$\n' + row.value + '\n$$'} />
                  </> : row.value && <img loading="lazy" src={'/api/files/images/' + encodeURIComponent(courseId) + '/' + row.value} alt={row.names.zh || row.names.en} width={160} />}
                </div>}
              </section>
            })}
          </div>
          <datalist id="import-reference-codes">{entries.map(e => <option key={e.id} value={e.draft.approvedPayload.code}>{[e.draft.bilingual.conceptLabel.zh, e.draft.bilingual.conceptLabel.en].filter(Boolean).join(' · ')}</option>)}</datalist>
        </>}
      </fieldset>
    </TeachingTransferSection>
  </TeachingTransferStep>
}
