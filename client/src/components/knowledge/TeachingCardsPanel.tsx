import { useStore } from 'zustand'
import { useContext, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { DownloadOutlined, UploadOutlined } from '@ant-design/icons'
import { Alert, App, Button, Empty, Input, Modal, Panel, Select, Space, Spin, Tag, Tooltip, Typography } from '../ui'
import { useWorkspace, useWorkspaceScroll, useWorkspaceValue } from '../../stores/workspaceSession'
import { useKnowledgeStore } from '../../stores/knowledgeStore'
import { useActionLock } from '../../lib/useActionLock'
import { useWorkspaceAccess } from '../../backoffice/lib/workspaceAccessState'
import { EmployeeContext } from '../../backoffice/employeeSession'
import { knowledgeApi, type PageNode } from '../../api/knowledge'
import { definitionBody, definitionFields, referenceNamePreview, teachingCardsApi, type DeleteBlocker, type TeachingDraft, type TeachingEntry, type TeachingRef } from '../../api/teachingCards'
import { TutorMarkdown } from '../ai/TutorMarkdown'
import { useKText } from './i18n'
import { DefinitionEditor } from './DefinitionEditor'
import { CourseReferencePicker } from './CourseReferencePicker'
import { TeachingTransferModal } from './TeachingTransferModal'
import type { TeachingImportKind } from '../../api/teachingCards'

import { color } from '../../theme/tokens'
import './TeachingCardsPanel.css'

const types = ['concept', 'misreading', 'professor_qa', 'ref_obj']
const categories = ['*', 'factual_recall', 'concept_framework', 'interpretive_application']

type CreationType = { type: string; kind?: TeachingRef['kind'] }

function blankDraft({ type, kind }: CreationType = { type: 'concept' }): TeachingDraft {
  return {
    type, topic: '*', conceptId: '', canonicalPoint: '',
    bilingual: { conceptLabel: { en: '', zh: '' }, summary: { en: '', zh: '' }, triggers: { en: [], zh: [] } },
    approvedPayload: { answerMd: '', ...(type === 'professor_qa' ? { question: '' } : {}),
      refObjects: type === 'ref_obj' ? [{ id: '', label: '', kind: kind ?? 'latex', value: '', requires: [] }] : [] },
    useWhen: ['*'], doNotUseWhen: [], evidence: [''], links: [], priority: 10,
  }
}

const splitLines = (value: string) => value.split('\n')

function listGroup({ draft }: TeachingEntry) {
  if (draft.type === 'ref_obj') {
    const kind = draft.approvedPayload.refObjects?.[0]?.kind
    return kind === 'image' || kind === 'latex' ? kind : 'ref_obj'
  }
  return types.includes(draft.type) ? draft.type : 'concept'
}

function entryTitle(draft: TeachingDraft, locale: string) {
  if (draft.type === 'concept' && draft.approvedPayload.definitionName) return draft.approvedPayload.definitionName
  if (draft.type === 'ref_obj') return draft.approvedPayload.refObjects?.[0]?.label ||
    referenceNamePreview(draft.approvedPayload.code ?? '', draft.bilingual.conceptLabel.en || draft.bilingual.conceptLabel.zh)
  if (draft.type === 'professor_qa') {
    const qa = editableDraft(draft)
    if (qa.approvedPayload.question) return qa.approvedPayload.question
  }
  const { zh, en } = draft.bilingual.conceptLabel
  return (locale === 'zh-CN' ? zh || en : en || zh) || draft.conceptId
}

function editableDraft(next: TeachingDraft): TeachingDraft {
  if (next.type !== 'professor_qa' || next.approvedPayload.question !== undefined) return next
  const questions = [...next.bilingual.triggers.zh, ...next.bilingual.triggers.en]
  return { ...next, approvedPayload: { ...next.approvedPayload, question: questions[0] ?? '' } }
}

function requiredFields(draft: TeachingDraft): Record<string, string> {
  if (draft.type === 'concept') return definitionFields(draft)
  const data = draft.approvedPayload
  if (draft.type === 'ref_obj') return {
    code: data.code ?? '', referenceName: draft.bilingual.conceptLabel.en,
    referenceSummary: draft.bilingual.summary.en,
    [data.refObjects?.[0]?.kind === 'image' ? 'image' : 'formula']: data.refObjects?.[0]?.value ?? '',
  }
  if (draft.type === 'professor_qa') return { studentQuestion: data.question ?? '', professorAnswer: data.answerMd }
  const fields: Record<string, string> = {
    kind: draft.type,
    useWhen: draft.useWhen.join(''),
    topic: draft.topic,
    conceptId: draft.conceptId,
    'concept.en': draft.bilingual.conceptLabel.en,
    'summary.en': draft.bilingual.summary.en,
    canonicalPoint: draft.canonicalPoint,
    evidence: draft.evidence.join('').trim(),
  }

  return fields
}

function EntryButton({ title, selected, disabled, onSelect, detail, unsaved, status }: {
  title: string; selected: boolean; disabled: boolean; onSelect: () => void; detail?: string; unsaved: boolean; status: string
}) {
  const titleElement = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  return <Tooltip title={title} placement="right" trigger={['hover', 'focus']} open={open}
    mouseEnterDelay={0.45} mouseLeaveDelay={0} getPopupContainer={trigger => trigger.ownerDocument.body}
    styles={{ root: { position: 'fixed', pointerEvents: 'none', maxWidth: 'min(320px, calc(100vw - 24px))' } }}
    onOpenChange={requested => {
      const el = titleElement.current
      setOpen(!!(requested && el && (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)))
    }}>
    <Button type={selected ? 'primary' : 'default'} aria-pressed={selected} disabled={disabled}
      onKeyDown={event => { if (event.key === 'Escape') setOpen(false) }}
      onClick={() => { setOpen(false); onSelect() }} className="teaching-list-entry">
      <span className="teaching-entry-text">
        <span ref={titleElement} className="teaching-entry-title">{title}</span>
        {detail && <small>{detail}</small>}
      </span>
      <Tag color={unsaved ? 'orange' : 'green'}>{status}</Tag>
    </Button>
  </Tooltip>
}

export function TeachingCardsPanel() {
  const session = useWorkspace()
  const [params, setParams] = useSearchParams()
  const courses = useKnowledgeStore(state => state.courses)
  const requested = params.get('courseId') ?? session.read<string>('teaching.course')
  const courseId = courses.find(course => course.id === requested)?.id ?? (params.has('courseId') ? '' : courses[0]?.id ?? '')
  const changeCourse = (id: string) => {
    session.write('teaching.course', id)
    setParams({ tab: 'teaching', courseId: id })
  }
  return <CourseTeachingPanel key={courseId} courseId={courseId} changeCourse={changeCourse} session={session} />
}

type WorkingCopy = { stamp?: string; draft: TeachingDraft; revision: number | null }

function hasUnsavedChanges(entry: TeachingEntry | null, copy: WorkingCopy | undefined) {
  return !!copy && (!entry || copy.revision !== entry.revision ||
    JSON.stringify(copy.draft) !== JSON.stringify(editableDraft(entry.draft)))
}
function CourseTeachingPanel({ courseId, changeCourse, session }: {
  courseId: string; changeCourse: (id: string) => void; session: ReturnType<typeof useWorkspace>
}) {
  const { locale, text } = useKText()
  const label = (key: string) => text(`teaching.${key}`)
  const { message } = App.useApp()
  const access = useWorkspaceAccess()
  const [params, setParams] = useSearchParams()
  const courses = useKnowledgeStore((state) => state.courses)
  const scope = 'teaching.' + courseId + '.'
  const owner = useContext(EmployeeContext)?.employeeId
  const preferenceKey = owner && 'teaching.newType.' + JSON.stringify([owner, courseId])
  function lastCreationType(): CreationType {
    let pref = session.read<CreationType>(scope + 'newType')
    try {
      if (preferenceKey) pref = JSON.parse(localStorage.getItem(preferenceKey) ?? 'null') ?? pref
    } catch { /* The workspace preference also works without browser storage. */ }
    return pref && types.includes(pref.type) ? { type: pref.type, kind: pref.kind === 'image' ? 'image' : 'latex' } : { type: 'concept' }
  }
  const savedPrefix = scope + 'saved.'
  const previousSlots = new Map<string, string[]>()
  for (const [name, value] of Object.entries(session.store.getState())) {
    if (name.startsWith(savedPrefix) && typeof value === 'string') {
      const entrySlots = previousSlots.get(value) ?? []
      entrySlots.push(name.slice(savedPrefix.length))
      previousSlots.set(value, entrySlots)
    }
  }
  const workingSlots = (id: string) => ['entry:' + id, ...(previousSlots.get(id) ?? [])]
  const remembered = session.read<string>(scope + 'selection')
  const slot = params.get('entryId') ? 'entry:' + params.get('entryId')
    : params.get('draftId') ? 'new:' + params.get('draftId') : remembered ?? ''
  const savedId = useWorkspaceValue<string>(session, scope + 'saved.' + slot)
  const entryId = savedId ?? (slot.startsWith('entry:') ? slot.slice(6) : null)
  // The URL can still point to the creation draft when the new entry is already editable.
  const copySlot = entryId
    ? workingSlots(entryId).find(candidate => session.read<WorkingCopy>(scope + 'copy.' + candidate)) ?? 'entry:' + entryId
    : slot
  const key = scope + 'copy.' + copySlot
  const localCopy = useWorkspaceValue<WorkingCopy>(session, key)
  const copy = (entryId ? access.canEdit : access.canCreate) ? localCopy : undefined
  const [stamp, setStamp] = useState<string>()
  const [entries, setEntries] = useState<TeachingEntry[]>([])
  const [transferMode, setTransferMode] = useState<'import' | 'download' | null>(null)
  const [batchMode, setBatchMode] = useState(false)
  const [checked, setChecked] = useState<string[]>([])
  const [deletion, setDeletion] = useState<{ rows: TeachingEntry[]; blockers: DeleteBlocker[] } | null>(null)
  const selected = entries.find(row => row.id === entryId) ?? null
  const [latestSlot, setLatestSlot] = useState('')
  const conflict = !!(copy && ((stamp && copy.stamp !== stamp) || (selected && copy.revision !== selected.revision)))
  const showLatest = conflict && latestSlot === slot
  const hasForm = courseId && (selected || (!entryId && slot && access.canCreate))
  const draft = hasForm ? ((!showLatest && copy?.draft) || (selected ? editableDraft(selected.draft) : blankDraft(lastCreationType()))) : null
  const setDraft = (next: TeachingDraft | ((current: TeachingDraft | null) => TeachingDraft | null)) => {
    const value = typeof next === 'function' ? next(draft) : next
    if (slot && value) session.write(key, { draft: value, stamp: copy ? copy.stamp : stamp, revision: copy?.revision ?? selected?.revision ?? null })
  }
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; session.flush() }
  }, [session])
  const [reference, setReference] = useState<TeachingRef | null>(null)
  const [showMissing, setShowMissing] = useState(false)
  const required = draft ? requiredFields(draft) : {}
  const missing = Object.keys(required).filter((key) => !required[key]?.trim())
  const [operating, setBusy] = useState(false)
  const actions = useActionLock()
  const pendingSave = useStore(session.saving, state => state[key] === true)
  const busy = operating || pendingSave
  const [listResult, setListResult] = useState<{ courseId: string; error?: string } | null>(null)
  const [listRetry, setListRetry] = useState(0)
  const loading = !!courseId && listResult?.courseId !== courseId
  const loadError = loading ? undefined : listResult?.error
  const [pages, setPages] = useState<PageNode[]>([])
  const [sourcePageId, setSourcePageId] = useState('')

  useEffect(() => {
    if (courseId) session.write('teaching.course', courseId)
    if (courseId && slot) session.write(scope + 'selection', slot)
  }, [session, courseId, slot, scope])

  useEffect(() => {
    if (!courseId) return
    let active = true
    teachingCardsApi.list(courseId, value => { if (active) setStamp(value) }).then((rows) => {
      if (!active) return
      setEntries(rows)
      setListResult({ courseId })
    }).catch((error: Error) => {
      if (active) setListResult({ courseId, error: error.message })
    })
    return () => { active = false }
  }, [courseId, listRetry])

  const loadSourcePages = async () => {
    const unlock = actions.acquire()
    if (!unlock) return
    setBusy(true)
    try { setPages((await knowledgeApi.getCourse(courseId)).pages) }
    catch (error) { message.error((error as Error).message) }
    finally { setBusy(false); unlock() }
  }

  const selectEntry = (entry: TeachingEntry | null) => {
    setShowMissing(false)
    setLatestSlot('')
    if (entry) {
      setParams({ tab: 'teaching', courseId, entryId: entry.id })
    } else {
      const id = session.read<string>(scope + 'newId') ?? crypto.randomUUID()
      session.write(scope + 'newId', id)
      const newKey = scope + 'copy.new:' + id
      if (!session.read(newKey)) session.write(newKey, { draft: blankDraft(lastCreationType()), stamp, revision: null })
      setParams({ tab: 'teaching', courseId, draftId: id })
    }
  }

  const receiveEntry = (entry: TeachingEntry) => {
    session.write(key, undefined)
    if (!selected) {
      if (slot.startsWith('new:')) {
        const type = entry.draft.type
        const pref: CreationType = type === 'ref_obj' ? { type, kind: entry.draft.approvedPayload.refObjects?.[0]?.kind } : { type }
        session.write(scope + 'newType', pref)
        try { if (preferenceKey) localStorage.setItem(preferenceKey, JSON.stringify(pref)) } catch { /* session fallback */ }
      }
      const group = listGroup(entry)
      const folded = session.read<string[]>(scope + 'collapsed') ?? []
      session.write(scope + 'collapsed', folded.filter(item => item !== group && !(entry.draft.type === 'ref_obj' && item === 'ref_obj')))
      session.write(scope + 'search', '')
      session.write(scope + 'saved.' + slot, entry.id)
      if (slot === 'new:' + session.read<string>(scope + 'newId')) session.write(scope + 'newId', undefined)
    }
    if (session.read(scope + 'selection') === slot) session.write(scope + 'selection', 'entry:' + entry.id)
    if (!mounted.current) return
    setEntries(rows => rows.some(row => row.id === entry.id) ? rows.map(row => row.id === entry.id ? entry : row) : [entry, ...rows].sort((a, b) =>
      (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.additionPosition - b.additionPosition || a.id.localeCompare(b.id)))
    const current = session.read(scope + 'selection')
    if (!current || current === slot || current === 'entry:' + entry.id)
      setParams({ tab: 'teaching', courseId, entryId: entry.id }, { replace: true })
  }

  const update = (patch: Partial<TeachingDraft>) => {
    setDraft((value) => value ? { ...value, ...patch } : null)
  }

  const save = async () => {
    if (!courseId || !draft || busy || actions.isLocked() || session.saving.getState()[key] || conflict || loading || loadError) return
    if (missing.length) {
      setShowMissing(true)
      return
    }
    const items = (lines: string[]) => lines.map((line) => line.trim()).filter(Boolean)
    const prepared: TeachingDraft = {
      ...draft,
      approvedPayload: draft.type === 'professor_qa' ? {
        question: draft.approvedPayload.question, answerMd: draft.approvedPayload.answerMd, refObjects: draft.approvedPayload.refObjects,
      } : draft.type === 'concept' ? { ...draft.approvedPayload, definitionName: required.definitionName,
        answerMd: definitionBody(draft),
      } : draft.approvedPayload,
      evidence: items(draft.evidence),
      doNotUseWhen: items(draft.doNotUseWhen),
      bilingual: {
        ...draft.bilingual,
        triggers: { en: items(draft.bilingual.triggers.en), zh: items(draft.bilingual.triggers.zh) },
      },
    }
    if (draft.type === 'ref_obj') {
      prepared.approvedPayload = { ...draft.approvedPayload }
      delete prepared.approvedPayload.displayName
    }
    session.saving.setState({ [key]: true })
    try {
      receiveEntry(selected
        ? await teachingCardsApi.update(courseId, selected.id, selected.revision, prepared, stamp)
        : await teachingCardsApi.create(courseId, prepared, stamp))
      message.success(label('saved'))
    } catch (error) {
      if ((error as { code?: string }).code === 'CONFLICT' || (error as { code?: string }).code === 'TEACHING_CARD_REVISION_CHANGED') setListRetry(value => value + 1)
      message.error((error as Error).message)
    } finally { session.saving.setState({ [key]: false }) }
  }

  const search = useWorkspaceValue<string>(session, scope + 'search') ?? ''
  const listScroll = useWorkspaceScroll(session, scope + 'listScroll', !loading && !loadError)
  const editorScroll = useWorkspaceScroll(session, scope + 'scroll.' + slot, !!draft && !loading && !loadError)
  const [pickerSlot, setPickerSlot] = useState<string | null>(null)
  const payload = draft?.approvedPayload
  const asset = payload?.refObjects?.[0]
  const setPayload = (patch: Partial<TeachingDraft['approvedPayload']>) =>
    setDraft((current) => current && ({ ...current, approvedPayload: { ...current.approvedPayload, ...patch } }))
  const setAsset = (patch: Partial<TeachingRef>) => setPayload({ refObjects: [{
    id: '', label: '', kind: 'latex', value: '', requires: [], ...asset, ...patch,
  }] })
  const dirty = hasUnsavedChanges(selected, copy)
  const needsResave = selected && (selected.approvedRevision == null || selected.revision > selected.approvedRevision + 1)
  const editable = !showLatest && (selected ? access.canEdit : access.canCreate)
  const caption = (key: string, mandatory = true) => <span>{label(key)}{mandatory && (
    <span aria-hidden="true" style={{ color: color.error, marginInlineStart: 3 }}>*</span>
  )}</span>
  const field = (key: string, value: string, change: (value: string) => void, rows?: number, instance = key) => {
    const mandatory = key === 'evidence' ? draft?.evidence.length === 1
      : Object.hasOwn(required, key) || key === 'formula' || key === 'referenceLabel'
    const invalid = showMissing && (missing.includes(key))
    const attrs = { 'aria-label': label(key), required: mandatory, 'aria-invalid': invalid || undefined, status: invalid ? 'error' as const : undefined }
    return (
    <label key={instance} style={{ display: 'grid', gap: 4 }}>
      {caption(key, mandatory)}
      {key === 'formula' && <Typography.Text type="secondary" id="teaching-formula-hint">{label('formulaHint')}</Typography.Text>}
      {rows ? <Input.TextArea {...attrs} aria-describedby={key === 'formula' ? 'teaching-formula-hint' : undefined} rows={rows} value={value} onChange={(event) => change(event.target.value)} disabled={!editable || busy} />
        : <Input {...attrs} value={value} onChange={(event) => change(event.target.value)} disabled={!editable || busy} />}
    </label>
    )
  }

  const insertReference = () => {
    if (!draft || !reference || !reference.label.trim() || !reference.value.trim()) return
    const objects = draft.approvedPayload.refObjects ?? []
    update({ approvedPayload: {
      ...draft.approvedPayload,
      answerMd: `${draft.approvedPayload.answerMd}\n\n[${reference.label}](refobj:${reference.id})`,
      refObjects: [...objects, { ...reference, requires: reference.requires.filter((term) => term.trim()) }],
    } })
    setReference(null)
  }

  const clearEditor = () => {
    session.write(scope + 'selection', undefined)
    setParams({ tab: 'teaching', courseId }, { replace: true })
  }
  const deleteRows = async (rows: TeachingEntry[], commit = false) => {
    if (!access.canDelete || busy || !rows.length) return
    const unlock = actions.acquire()
    if (!unlock) return
    setBusy(true)
    try {
      const items = rows.map(({ id, revision }) => ({ id, revision }))
      const { blockers } = await (commit ? teachingCardsApi.deleteSelection : teachingCardsApi.deletionPreview)(courseId, items, stamp)
      if (!mounted.current) return
      if (!commit || blockers.length) {
        setDeletion({ rows, blockers })
        if (blockers.some(block => block.kind === 'changed')) setListRetry(n => n + 1)
        return
      }
      const removed = new Set(rows.map(row => row.id))
      for (const id of removed) {
        for (const workingSlot of workingSlots(id)) {
          session.write(scope + 'copy.' + workingSlot, undefined)
          session.write(scope + 'saved.' + workingSlot, undefined)
        }
      }
      if (entryId && removed.has(entryId)) clearEditor()
      setEntries(current => current.filter(row => !removed.has(row.id)))
      setChecked([])
      setDeletion(null)
      setListRetry(n => n + 1)
      message.success(label('deleted'))
    } catch (error) {
      message.error((error as Error).message)
    } finally { if (mounted.current) setBusy(false); unlock() }
  }
  const eligible = deletion?.rows.filter(row => !deletion.blockers.some(block => block.id === row.id)) ?? []
  const collapsed = useWorkspaceValue<string[]>(session, scope + 'collapsed') ?? []
  const searching = !!search.trim()
  const isOpen = (group: string) => searching || !collapsed.includes(group)
  const matching = entries.filter(({ draft: row }) => [
    entryTitle(row, locale), row.bilingual.conceptLabel.zh, row.bilingual.conceptLabel.en, row.approvedPayload.code,
    ...(row.approvedPayload.aliases ?? []),
  ].join(' ').toLowerCase().includes(search.trim().toLowerCase()))
  const groups = new Map<string, TeachingEntry[]>()
  for (const row of matching) {
    const key = listGroup(row)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(row)
  }
  const visibleEntries = matching.filter(row => isOpen(listGroup(row)) && (row.draft.type !== 'ref_obj' || isOpen('ref_obj')))
  const selectedRows = visibleEntries.filter(row => checked.includes(row.id))
  function renderEntry(entry: TeachingEntry) {
    const row = entry.draft
    const title = entryTitle(row, locale)
    const unsaved = access.canEdit && workingSlots(entry.id).some(workingSlot =>
      hasUnsavedChanges(entry, session.read<WorkingCopy>(scope + 'copy.' + workingSlot)))
    if (batchMode && access.canDelete) return <label key={entry.id} className="teaching-batch-entry">
      <input type="checkbox" checked={checked.includes(entry.id)} disabled={busy}
        onChange={event => setChecked(event.target.checked ? [...checked, entry.id] : checked.filter(id => id !== entry.id))} />
      <span>{title}</span>
    </label>
    return <EntryButton key={entry.id} title={title} selected={selected?.id === entry.id} disabled={busy}
      onSelect={() => selectEntry(entry)} detail={types.includes(row.type) ? undefined : label('type.' + row.type)}
      unsaved={unsaved} status={label(unsaved ? 'statusUnsaved' : 'statusSaved')} />
  }
  const courseTitle = courses.find(course => course.id === courseId)?.title ?? ''
  const entriesForTransfer = (kind: TeachingImportKind) => entries.filter(({ draft: row }) =>
    kind === 'concept' || kind === 'professor_qa'
      ? row.type === kind
      : row.type === 'ref_obj' && row.approvedPayload.refObjects?.[0]?.kind === kind,
  ).map(entry => ({ id: entry.id, title: entryTitle(entry.draft, locale) }))
  const closeTransfer = () => setTransferMode(null)
  const refreshAfterImport = () => {
    closeTransfer()
    setListRetry(value => value + 1)
  }

  function renderGroup(key: string, title: string, rows: TeachingEntry[], children?: React.ReactNode) {
    if (searching && !rows.length) return null
    const open = isOpen(key)
    return <section key={key} className="teaching-group">
      <button type="button" className="teaching-group-toggle" aria-expanded={open} disabled={busy || searching || !rows.length}
        onClick={() => {
          session.write(scope + 'collapsed', open ? [...collapsed, key] : collapsed.filter(item => item !== key))
          if (open) {
            const hidden = new Set(rows.map(row => row.id))
            setChecked(ids => ids.filter(id => !hidden.has(id)))
          }
        }}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> {title} <small>{rows.length}</small>
      </button>
      {open && rows.length > 0 && <div className="teaching-group-content">{children ?? rows.map(renderEntry)}</div>}
    </section>
  }
  return <div className="teaching-workspace"><div className="teaching-columns">
    <Panel className="teaching-sidebar">
      <div style={{display:'flex',flexWrap:'wrap',alignItems:'center',justifyContent:'space-between',gap:4}}>
        {caption('course')}
        <Space size={4} wrap>
          {access.canEdit && <Tooltip title={text('batchTeaching.importAction')}>
            <Button type="text" size="small" aria-label={text('batchTeaching.importAction')} icon={<UploadOutlined />}
              disabled={!courseId || busy || loading || !!loadError} onClick={() => setTransferMode('import')} />
          </Tooltip>}
          <Tooltip title={text('batchTeaching.downloadAction')}>
            <Button type="text" size="small" aria-label={text('batchTeaching.downloadAction')} icon={<DownloadOutlined />}
              disabled={!courseId || busy || loading || !!loadError} onClick={() => setTransferMode('download')} />
          </Tooltip>
        </Space>
      </div>
      <Select aria-required aria-label={label('course')} value={courseId || undefined}
        disabled={busy} options={courses.map((course) => ({ value: course.id, label: course.title }))}
        onChange={changeCourse} />
      <Input aria-label={label('searchEntries')} placeholder={label('searchEntries')} value={search} disabled={busy} onChange={(e) => { setChecked([]); session.write(scope + 'search', e.target.value) }} />
      {batchMode && access.canDelete && <Space wrap>
        <label><input type="checkbox" disabled={busy || !visibleEntries.length}
          checked={visibleEntries.length > 0 && visibleEntries.every(row => checked.includes(row.id))}
          onChange={event => setChecked(event.target.checked ? visibleEntries.map(row => row.id) : [])} />{label('selectVisible')}</label>
        <Button danger disabled={busy || !selectedRows.length} onClick={() => void deleteRows(selectedRows)}>
          {text('teaching.deleteSelected', { count: selectedRows.length })}
        </Button>
      </Space>}
      <div ref={listScroll} aria-busy={loading} className="teaching-list">
        {loading ? <Spin /> : loadError ? <Alert type="error" showIcon message={loadError}
          action={<Button size="small" onClick={() => {
            setListResult(null)
            setListRetry((value) => value + 1)
          }}>{text('common.retry')}</Button>} />
          : !matching.length && search.trim()
          ? <Empty description={label('noMatches')}><Button onClick={() => session.write(scope + 'search', '')}>{label('clearSearch')}</Button></Empty>
          : types.map(type => {
            if (type !== 'ref_obj') return renderGroup(type, label('type.' + type), groups.get(type) ?? [])
            const refs = matching.filter(row => row.draft.type === 'ref_obj')
            return renderGroup(type, label('type.ref_obj'), refs, <>
              {(['image', 'latex'] as const).map(kind => {
                const items = groups.get(kind)
                return items && renderGroup(kind, label(kind === 'image' ? 'image' : 'formula'), items)
              })}
              {groups.get('ref_obj')?.map(renderEntry)}
            </>)
          })}
        {!loading && !loadError && courseId && !entries.length && !searching && <Empty description={label('entriesEmpty')} />}
      </div>
    </Panel>
    <Panel className="teaching-editor">
      <header className="teaching-header">
        <Typography.Title level={4} style={{ margin: 0 }}>{label('title')}</Typography.Title>
        <Space wrap>
          {access.canCreate && <Button type="primary" disabled={!courseId || busy || loading || !!loadError} onClick={() => selectEntry(null)}>{label('add')}</Button>}
          {access.canDelete && <Button disabled={busy || loading || !!loadError || !courseId} onClick={() => { setChecked([]); setBatchMode(!batchMode) }}>
            {label(batchMode ? 'endBatch' : 'batchManage')}
          </Button>}
        </Space>
      </header>
      {batchMode && access.canDelete && selectedRows.length > 0 && <details open className="teaching-selected-entries">
        <summary>{text('teaching.selectedEntries', { count: selectedRows.length })}</summary>
        <ul>{selectedRows.map(row => <li key={row.id}>{entryTitle(row.draft, locale)}</li>)}</ul>
      </details>}
      <div ref={editorScroll} className="teaching-editor-body">
      {!draft && <Empty description={label('selectEntry')} />}
      {entryId && !selected && !loading && !loadError && <Alert type="warning" message={label('entryUnavailable')} />}
      {conflict && <Alert type="warning" showIcon message={label('localConflict')} action={<Space wrap>
        <Button onClick={() => setLatestSlot(showLatest ? '' : slot)}>{label(showLatest ? 'viewLocal' : 'viewLatest')}</Button>
        {showLatest && <Button onClick={() => { session.write(key, undefined); setLatestSlot('') }}>{label('discardLocal')}</Button>}
      </Space>} />}
      {draft && !loading && !loadError && <div className="teaching-form">
        {editable && needsResave && <Alert type="info" showIcon message={label('resaveForRelease')} />}
        <div className="teaching-select-row">
          <label style={{ display: 'grid', gap: 4 }}>{caption('kind')}
          <Select aria-required aria-label={label('kind')} value={draft.type} disabled={!editable || busy || selected?.draft.type === 'ref_obj'}
            labelRender={() => label(`type.${draft.type}`)}
            onChange={(type) => { if (selected) update({ type }); else setDraft(blankDraft({ type, kind: type === 'ref_obj' ? lastCreationType().kind : undefined })) }} options={types.filter(type => type !== 'ref_obj' || !selected || selected.draft.type === type).map((type) => ({ value: type, label: label(`type.${type}`) }))} /></label>
          {draft.type !== 'concept' && draft.type !== 'professor_qa' && draft.type !== 'ref_obj' && <label style={{ display: 'grid', gap: 4 }}>{caption('useWhen')}
          <Select aria-required status={showMissing && missing.includes('useWhen') ? 'error' : undefined} aria-label={label('useWhen')} mode="multiple" value={draft.useWhen} disabled={!editable || busy}
            onChange={(useWhen) => update({ useWhen })} options={categories.map((value) => ({ value, label: label(`category.${value}`) }))} /></label>}
        </div>
        {draft.type === 'concept' ? <DefinitionEditor key={slot} courseId={courseId} draft={draft}
          disabled={!editable || busy} missing={showMissing ? missing : []} update={update} />
          : draft.type === 'professor_qa' ? <>
          {field('studentQuestion', payload?.question ?? '', question => setPayload({ question }))}
          {field('professorAnswer', payload?.answerMd ?? '', answerMd => setPayload({ answerMd }), 5)}
          {editable && <Button className="teaching-answer-insert" disabled={busy} onClick={() => setPickerSlot(slot)}>{label('insert')}</Button>}
        </> : draft.type === 'ref_obj' ? <>
          <div>
            <Typography.Text type="secondary" id="teaching-reference-preview">{label('referenceNamePreview')}</Typography.Text>
            <br />
            <output aria-labelledby="teaching-reference-preview">{referenceNamePreview(payload?.code ?? '', draft.bilingual.conceptLabel.en) || '—'}</output>
          </div>
          {field('code', payload?.code ?? '', code => setPayload({ code }))}
          {field('referenceName', draft.bilingual.conceptLabel.en, en =>
            update({ bilingual: { ...draft.bilingual, conceptLabel: { ...draft.bilingual.conceptLabel, en } } }))}
          {field('referenceSummary', draft.bilingual.summary.en, en =>
            update({ bilingual: { ...draft.bilingual, summary: { ...draft.bilingual.summary, en } } }), 2)}
          <label className="teaching-select-field">{caption('referenceType')} <Select aria-label={label('referenceType')} disabled={!editable || busy}
            value={asset?.kind ?? 'latex'} options={['latex','image'].map(kind => ({ value: kind, label: label(kind === 'latex' ? 'formula' : 'image') }))}
            onChange={kind => setAsset({ kind: kind as TeachingRef['kind'], value: '' })} /></label>
          {asset?.kind === 'image' ? <label>{caption('image')} <input aria-label={label('image')} type="file" disabled={!editable || busy}
            accept="image/png,image/jpeg,image/gif,image/webp" onChange={async event => {
              const file = event.target.files?.[0]
              if (!file) return
              const unlock = actions.acquire()
              if (!unlock) return
              setBusy(true)
              try { const uploaded = await knowledgeApi.uploadImage(file, courseId); setAsset({ value: uploaded.url.split('/').at(-1) ?? '' }) }
              catch (error) { message.error((error as Error).message) }
              finally { setBusy(false); unlock() }
            }} /></label> : field('formula', asset?.value ?? '', value => setAsset({ value }), 3)}
          {asset?.value && <TutorMarkdown courseId={courseId} content={asset.kind === 'latex'
            ? `$$\n${asset.value}\n$$` : `![${asset.label}](/api/files/images/${courseId}/${asset.value})`} />}
        </> : <>
        {field('topic', draft.topic, (topic) => update({ topic }))}
        {field('conceptId', draft.conceptId, (conceptId) => update({ conceptId }))}
        {(['zh', 'en'] as const).map((lang) => field(`concept.${lang}`, draft.bilingual.conceptLabel[lang], (value) =>
          update({ bilingual: { ...draft.bilingual, conceptLabel: { ...draft.bilingual.conceptLabel, [lang]: value } } })))}
        {(['zh', 'en'] as const).map((lang) => field(`summary.${lang}`, draft.bilingual.summary[lang], (value) =>
          update({ bilingual: { ...draft.bilingual, summary: { ...draft.bilingual.summary, [lang]: value } } }), 2))}
        {(['zh', 'en'] as const).map((lang) => field(`triggers.${lang}`, draft.bilingual.triggers[lang].join('\n'), (value) =>
          update({ bilingual: { ...draft.bilingual, triggers: { ...draft.bilingual.triggers, [lang]: splitLines(value) } } }), 3))}
        {field('canonicalPoint', draft.canonicalPoint, (canonicalPoint) => update({ canonicalPoint }))}
        {field('answer', draft.approvedPayload.answerMd, (answerMd) => update({ approvedPayload: { ...draft.approvedPayload, answerMd } }), 5)}
        {editable && <Space wrap>
          <Button disabled={busy} onClick={() => setReference({ id: crypto.randomUUID(), kind: 'latex', label: '', value: '', requires: [] })}>{label('addRef')}</Button>
          {(draft.approvedPayload.refObjects ?? []).map((object) => (
            <Tag key={object.id} closable={!busy} onClose={() => update({ approvedPayload: {
              ...draft.approvedPayload,
              answerMd: draft.approvedPayload.answerMd.replaceAll(`[${object.label}](refobj:${object.id})`, ''),
              refObjects: (draft.approvedPayload.refObjects ?? []).filter((ref) => ref.id !== object.id),
            } })}>{object.label}</Tag>
          ))}
        </Space>}
        {field('excluded', draft.doNotUseWhen.join('\n'), (value) => update({ doNotUseWhen: splitLines(value) }), 2)}
        {editable && <Space wrap>
          <Button disabled={busy} onClick={() => void loadSourcePages()}>{label('browseSources')}</Button>
          {pages.length > 0 && <Select aria-label={label('sourcePage')} style={{ minWidth: 220 }}
            value={sourcePageId || undefined} onChange={setSourcePageId}
            options={pages.map((page) => ({ value: page.id, label: page.title }))} />}
        </Space>}
        {sourcePageId && <Input.TextArea readOnly rows={5} aria-label={label('sourcePage')}
          value={pages.find((page) => page.id === sourcePageId)?.contentMd ?? ''} />}
        {draft.evidence.length > 1 && caption('evidenceGroup')}
        {draft.evidence.map((excerpt, index) => field(`evidence`, excerpt, (value) =>
          update({ evidence: draft.evidence.map((item, current) => current === index ? value : item) }), 3, `evidence-${index}`))}
        {editable && draft.evidence.length < 8 && <Button disabled={busy} onClick={() => update({ evidence: [...draft.evidence, ''] })}>{label('addEvidence')}</Button>}
        <Select aria-label={label('links')} mode="multiple" value={draft.links} disabled={!editable || busy}
          onChange={(links) => update({ links })}
          options={entries.filter((entry) => entry.id !== selected?.id).map((entry) => ({
            value: entry.id, label: entryTitle(entry.draft, locale),
          }))} />
        </>}
        {showMissing && missing.length > 0 && <Alert type="error" showIcon
          message={text('teaching.missingFields', { fields: new Intl.ListFormat(locale).format(missing.map(label)) })} />}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          {!selected && <Tag color="orange">{label('statusUnsaved')}</Tag>}
          {dirty && <Typography.Text type="secondary">{label('localDraft')}</Typography.Text>}
          {editable && <Button type="primary" disabled={conflict} loading={busy} onClick={() => void save()}>{label('save')}</Button>}
          {!selected && editable && <Button disabled={busy} onClick={() => {
            session.write(key, undefined)
            session.write(scope + 'newId', undefined)
            clearEditor()
          }}>{label('discardDraft')}</Button>}
          {selected && access.canDelete && <Button danger style={{ marginInlineStart: 'auto' }} disabled={busy}
            onClick={() => void deleteRows([selected])}>{label('deleteEntry')}</Button>}
        </div>
      </div>}
      </div>
    </Panel>
    </div>
    {pickerSlot === slot && editable && draft?.type === 'professor_qa' && payload &&
      <CourseReferencePicker courseId={courseId} onCancel={() => setPickerSlot(null)} onInsert={item => {
        setPayload({ answerMd: [payload.answerMd, `[${item.label}](refobj:${item.id})`].filter(Boolean).join('\n\n') })
        setPickerSlot(null)
      }} />}
    {courseId && transferMode && (access.canEdit || transferMode === 'download') &&
      <TeachingTransferModal key={courseId + transferMode} mode={transferMode} courseId={courseId} courseTitle={courseTitle}
        canCreate={access.canCreate} entriesFor={entriesForTransfer} close={closeTransfer} saved={refreshAfterImport} />}
    <Modal open={!!deletion} title={label('confirmDelete')} cancelText={text('common.cancel')} okText={label('deleteEntry')}
      confirmLoading={busy} okButtonProps={{ danger: true, disabled: !deletion || !!deletion.blockers.length }}
      onCancel={() => { if (!busy && !actions.isLocked()) setDeletion(null) }} onOk={() => deletion && void deleteRows(deletion.rows, true)}>
      <ul>{deletion?.rows.map(row => {
        const title = entryTitle(row.draft, locale)
        const code = row.draft.approvedPayload.code
        return <li key={row.id}>
        {title} {code && !title.includes(code) && code}
        {workingSlots(row.id).some(s => session.read(scope + 'copy.' + s)) && <strong> · {label('discardLocalHint')}</strong>}
        {deletion.blockers.filter(block => block.id === row.id).map((block, index) =>
          <div key={index}>{label('block_' + block.kind)} · {block.source}</div>)}
      </li>})}</ul>
      {deletion?.rows.some(row => row.approved) && <p>{label('deletePublishHint')}</p>}
      {!!deletion?.blockers.length && !!eligible.length && <Button disabled={busy} onClick={() => void deleteRows(eligible)}>{label('selectEligible')}</Button>}
    </Modal>
    <Modal open={!!reference} title={label('addRef')} okText={label('insert')} okButtonProps={{ disabled: busy || !reference?.label.trim() || !reference.value.trim() }} onOk={insertReference}
      onCancel={() => { if (!actions.isLocked()) setReference(null) }}>
      {reference && <div style={{ display: 'grid', gap: 12 }}>
        <label style={{ display: 'grid', gap: 4 }}>{caption('referenceType')}
          <Select aria-required aria-label={label('referenceType')} value={reference.kind} options={[
          { value: 'latex', label: label('formula') }, { value: 'image', label: label('image') },
        ]} onChange={(kind) => setReference({ ...reference, kind, value: '' })} /></label>
        {field('referenceLabel', reference.label, (value) => setReference({ ...reference, label: value }))}
        {reference.kind === 'latex' ? field('formula', reference.value, (value) => setReference({ ...reference, value }), 3)
          : <label>{caption('image')} <input required type="file" aria-label={label('image')} accept="image/png,image/jpeg,image/gif,image/webp"
              onChange={async (event) => {
                const file = event.target.files?.[0]
                if (!file) return
                const unlock = actions.acquire()
                if (!unlock) return
                setBusy(true)
                try {
                  const asset = await knowledgeApi.uploadImage(file, courseId)
                  setReference((value) => value?.id === reference.id ? { ...value, value: asset.url.split('/').at(-1) ?? '' } : value)
                } catch (error) { message.error((error as Error).message) }
                finally { setBusy(false); unlock() }
              }} /></label>}
        {reference.value && <TutorMarkdown courseId={courseId} content={reference.kind === 'latex'
          ? `$$\n${reference.value}\n$$` : `![${reference.label}](/api/files/images/${courseId}/${reference.value})`} />}
        {field('requires', reference.requires.join('\n'), (value) => setReference({ ...reference, requires: splitLines(value) }), 2)}
      </div>}
    </Modal>
  </div>
}
