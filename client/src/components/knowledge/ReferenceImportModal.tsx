import { useState } from 'react'
import { App, Button, Modal, Space } from '../ui'
import { TutorMarkdown } from '../ai/TutorMarkdown'
import { knowledgeApi } from '../../api/knowledge'
import { teachingCardsApi, type TeachingEntry } from '../../api/teachingCards'
import { useKText } from './i18n'
import { matchReference, normalizeCode, parseReferences, referenceDraft, type Candidate } from './referenceImport'

type ImportRow = Candidate & { checked: boolean }
type Props = { courseId: string; canCreate: boolean; close: () => void; saved: () => void }

function similar(row: Candidate, entries: TeachingEntry[]) {
  return entries.filter(e => e.draft.approvedPayload.refObjects?.[0]?.kind === row.kind &&
    ((row.names.zh && e.draft.bilingual.conceptLabel.zh === row.names.zh) ||
      (row.names.en && e.draft.bilingual.conceptLabel.en === row.names.en)))
}

export function ReferenceImportModal({ courseId, canCreate, close, saved }: Props) {
  const { text } = useKText()
  const t = (key: string) => text('refImport.' + key)
  const { message } = App.useApp()
  const [rows, setRows] = useState<ImportRow[]>([])
  const [entries, setEntries] = useState<TeachingEntry[]>([])
  const [deleted, setDeleted] = useState<string[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)
  const matches = rows.map(row => matchReference(row, entries, deleted))
  const keys = rows.map((row, index) => matches[index].target?.id ?? 'code:' + normalizeCode(row.code))
  const statuses = matches.map((match, i) => keys.indexOf(keys[i]) !== keys.lastIndexOf(keys[i]) ? 'duplicate' : match.status)
  const allowed = (i: number) => statuses[i] === 'update' || (canCreate && ['new', 'recreate'].includes(statuses[i]))
  const selected = rows.map((row, i) => row.checked && allowed(i) ? i : -1).filter(i => i !== -1)
  const visible = rows.map((row, i) => [row.file, row.lesson, row.code, row.names.zh, row.names.en, t(statuses[i])].join(' ')
    .toLowerCase().includes(filter.trim().toLowerCase()) ? i : -1).filter(i => i !== -1)
  const change = (index: number, patch: Partial<ImportRow>) => setRows(current => current.map((r, i) => i === index ? { ...r, checked: false, ...patch } : r))

  const load = async (files: File[]) => {
    if (!files.length) return
    setBusy(true)
    setRows([])
    setFilter('')
    setExpanded(null)
    setErrors([])
    const warnings: string[] = []
    try {
      const current = (await teachingCardsApi.list(courseId)).filter(e => e.draft.type === 'ref_obj')
      const retired = await teachingCardsApi.deletedReferenceCodes(courseId)
      setEntries(current)
      setDeleted(retired)
      const result: ImportRow[] = []
      const imageBytes = async (asset: string) => {
        const response = await fetch('/api/files/images/' + encodeURIComponent(courseId) + '/' + encodeURIComponent(asset))
        if (!response.ok) throw new Error(t('missingAsset'))
        return new Uint8Array(await response.arrayBuffer())
      }
      for (const file of files) {
        try {
          if (!/\.(md|docx)$/i.test(file.name) || file.size > 15 * 1024 * 1024) throw new Error(t('format'))
          const markdown = /\.md$/i.test(file.name) ? new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
            : (await knowledgeApi.convertFile(file, courseId)).markdown
          const candidates = parseReferences(markdown, file.name, courseId)
          if (!candidates.length) throw new Error(t('noRows'))
          if (candidates.length + result.length > 200) throw new Error(t('limit'))
          const parsed: ImportRow[] = []
          for (const row of candidates) {
            const { target, status } = matchReference(row, current, retired)
            const old = target?.draft.approvedPayload.refObjects?.[0]
            if (status === 'update' && old?.kind === 'image' && old.value !== row.value) {
              const before = await imageBytes(old.value)
              const after = await imageBytes(row.value)
              if (before.length === after.length && before.every((byte, i) => byte === after[i])) row.value = old.value
            }
            parsed.push({ ...row, checked: status === 'new' && canCreate && !similar(row, current).length })
          }
          result.push(...parsed)
        } catch (e) { warnings.push(file.name + ' · ' + (e as Error).message) }
      }
      setRows(result)
      setErrors(warnings)
    } catch (e) { setErrors([(e as Error).message]) }
    finally { setBusy(false) }
  }

  const submit = async () => {
    if (busy || !selected.length) return
    setBusy(true)
    try {
      const items = selected.map(i => {
        const target = matches[i].target
        return { id: target?.id, revision: target?.revision, recreate: statuses[i] === 'recreate', draft: referenceDraft(rows[i], target) }
      })
      const result = await teachingCardsApi.importReferences(courseId, items)
      message.success(text('refImport.saved', { count: result.saved }))
      saved()
    } catch (e) {
      setErrors([(e as Error).message])
      setRows(current => current.map(row => ({ ...row, checked: false })))
      try {
        const latest = await teachingCardsApi.list(courseId)
        setEntries(latest.filter(entry => entry.draft.type === 'ref_obj'))
        setDeleted(await teachingCardsApi.deletedReferenceCodes(courseId))
      } catch (refreshError) {
        setErrors(current => [...current, (refreshError as Error).message])
      }
    } finally { setBusy(false) }
  }

  return <Modal open width={880} title={t('title')} onCancel={() => { if (!busy) close() }}
    okText={text('refImport.confirm', { count: selected.length })} cancelText={text('common.cancel')}
    confirmLoading={busy} okButtonProps={{ disabled: !selected.length || busy }} onOk={() => void submit()}>
    <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
      <label>{t('files')} <input type="file" multiple accept=".md,.docx" onChange={e => {
        const files = Array.from(e.target.files ?? [])
        e.target.value = ''
        void load(files)
      }} /></label>
      {busy && <p role="status">{t('working')}</p>}
      {errors.map((e, i) => <p key={i} role="alert">{e}</p>)}
      {!!rows.length && <>
        <p>{text('refImport.total', { count: rows.length })}</p>
        <Space wrap>
          <input type="search" aria-label={t('filter')} placeholder={t('filter')} value={filter} onChange={e => setFilter(e.target.value)} />
          <Button disabled={busy} onClick={() => setRows(current => current.map((r, i) => ({ ...r, checked: visible.includes(i) && allowed(i) && statuses[i] !== 'recreate' })))}>
            {t('select')}
          </Button>
          <Button disabled={busy} onClick={() => setRows(current => current.map(r => ({ ...r, checked: false })))}>{t('clear')}</Button>
        </Space>
        <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
          {visible.map(i => {
            const row = rows[i], target = matches[i].target
            return <section key={i} style={{ paddingBlock: 8, borderBottom: '1px solid #ddd' }}>
              <label><input type="checkbox" disabled={!allowed(i)} checked={row.checked && allowed(i)}
                onChange={e => change(i, { checked: e.target.checked })} /> {[row.code, row.names.zh, row.names.en].filter(Boolean).join(' · ')}</label>
              <div>{row.file} · {row.lesson} · #{row.line} · <strong>{t(statuses[i])}</strong></div>
              {!target && similar(row, entries).length > 0 && <small>{t('suggestion')} · {similar(row, entries).map(e => e.draft.approvedPayload.code).join(', ')}</small>}
              {statuses[i] === 'duplicate' && <Button size="small" onClick={() => setRows(current => current.filter((_, k) => k !== i))}>{t('remove')}</Button>}
              {row.issue && <div>{t(row.issue)}</div>}
              <button type="button" aria-expanded={expanded === i} onClick={() => setExpanded(expanded === i ? null : i)}>{t('details')}</button>
              {expanded === i && <div>
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
  </Modal>
}
