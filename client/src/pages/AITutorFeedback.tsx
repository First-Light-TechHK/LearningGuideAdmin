import { useContext, useState } from 'react'
import { Alert, App, Button, Drawer, Input, Select, Table, Tag, Tabs } from 'antd'
import { emptyFeedbackFilters, feedbackSource, filterFeedback, type FeedbackFilters, type FeedbackRecord } from '../api/feedback'
import { useAiText } from '../components/ai/i18n'
import { useLocale } from '../backoffice/lib/navigation'
import { tokens } from '../theme/tokens'

import { EmployeeContext } from '../backoffice/employeeSession'
import { WorkspaceAccessContext } from '../backoffice/lib/workspaceAccessState'
import { loadTriage, saveTriage, type TriageState, type TriageStore } from '../api/feedbackTriage'
import { FeedbackTriage } from '../components/ai/FeedbackTriage'

const statusColors = { New: 'blue', Triaged: 'gold', Applied: 'green', Dismissed: 'default' } as const

export function AITutorFeedback() {
  const employee = useContext(EmployeeContext)
  const access = useContext(WorkspaceAccessContext)
  return <FeedbackContent key={employee?.employeeId ?? 'readonly'} owner={employee?.employeeId ?? ''} canEdit={access?.canEdit ?? false} />
}

function FeedbackContent({ owner, canEdit }: { owner: string; canEdit: boolean }) {
  const { modal } = App.useApp()
  const { text } = useAiText()
  const locale = useLocale()
  const [loaded] = useState(() => { try { return { store: owner ? loadTriage(owner) : {}, error: false } } catch { return { store: {}, error: true } } })
  const [store, setStore] = useState<TriageStore>(loaded.store)
  const [dirty, setDirty] = useState(false)
  const [storageError, setStorageError] = useState(loaded.error)
  const records = feedbackSource.list().map((record) => store[record.id] ? { ...record, status: store[record.id].status, resolvedAt: store[record.id].resolvedAt } : record)
  const [filters, setFilters] = useState<FeedbackFilters>({ ...emptyFeedbackFilters })
  const [page, setPage] = useState(1)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = records.find((record) => record.id === selectedId) ?? null
  const close = () => { if (dirty) modal.confirm({ title: text('feedback.triage.unsaved'), onOk: () => { setDirty(false); setSelectedId(null) } }); else setSelectedId(null) }
  const save = (state: TriageState) => {
    if (!owner || !canEdit || storageError || !selected) throw new Error('storage')
    const next = { ...store, [selected.id]: state }
    try { saveTriage(owner, next) } catch { setStorageError(true); throw new Error('storage') }
    setStore(next)
  }
  const rows = filterFeedback(records, filters)
  const courses = [...new Map(records.map((record) => [record.courseId, record.course])).entries()]
  const update = (patch: Partial<FeedbackFilters>) => { setFilters((current) => ({ ...current, ...patch })); setPage(1) }
  const reset = () => { setFilters({ ...emptyFeedbackFilters }); setPage(1) }
  const options = (key: string, values: string[]) => [
    { value: '', label: text(`feedback.${key}.all`) },
    ...values.map((value) => ({ value, label: text(`feedback.${key}.${value}`) })),
  ]

  return (
    <section aria-label={text('feedback.title')} style={{ height: '100%', overflow: 'auto', padding: tokens.spacing.lg }}>
      <h1 style={{ margin: '0 0 8px', fontSize: tokens.fontSize['3xl'] }}>{text('feedback.title')}</h1>
      <p style={{ color: tokens.color.text.secondary }}>{text('feedback.description')}</p>
      <p style={{ color: tokens.color.text.secondary }}>{text('feedback.demo')}</p>
      {storageError && <Alert role="alert" type="error" message={text('feedback.triage.errors.storage')} />}
      <p>{text('feedback.triage.localOnly')}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing.md, margin: '24px 0' }}>
        <Select aria-label={text('feedback.course')} style={{ width: 180 }} value={filters.courseId}
          options={[{ value: '', label: text('feedback.allCourses') }, ...courses.map(([value, label]) => ({ value, label }))]}
          onChange={(courseId) => update({ courseId })} />
        <Select aria-label={text('feedback.type.label')} style={{ width: 155 }} value={filters.type}
          options={options('type', ['Student', 'Expert'])} onChange={(type) => update({ type })} />
        <Select aria-label={text('feedback.mode.label')} style={{ width: 155 }} value={filters.mode}
          options={options('mode', ['LECTURE', 'SOCRATIC'])} onChange={(mode) => update({ mode })} />
        <Select aria-label={text('feedback.status.label')} style={{ width: 155 }} value={filters.status}
          options={options('status', ['New', 'Triaged', 'Applied', 'Dismissed'])} onChange={(status) => update({ status })} />
        <Select aria-label={text('feedback.period')} style={{ width: 155 }} value={filters.days}
          options={[0, 7, 30].map((value) => ({ value, label: text(`feedback.days${value}`) }))} onChange={(days) => update({ days })} />
        <Input aria-label={text('feedback.search')} placeholder={text('feedback.search')} value={filters.search}
          style={{ flex: '1 1 260px' }} onChange={(event) => update({ search: event.target.value })} />
        <Button onClick={reset}>{text('feedback.reset')}</Button>
      </div>
      <div style={{ background: tokens.color.bg.container, border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.md, padding: tokens.spacing.lg }}>
        <h2 style={{ fontSize: tokens.fontSize.xl, marginTop: 0 }}>{text('feedback.records', { count: rows.length })}</h2>
        <Table<FeedbackRecord> rowKey="id" dataSource={rows} scroll={{ x: 1050 }}
          locale={{ emptyText: <div><p>{text('feedback.empty')}</p><Button onClick={reset}>{text('feedback.reset')}</Button></div> }}
          pagination={{ current: Math.min(page, Math.max(1, Math.ceil(rows.length / 5))), pageSize: 5, total: rows.length, showSizeChanger: false, onChange: setPage }}
          columns={[
            { title: text('feedback.id'), dataIndex: 'id', width: 115, render: (id: string, record) => <Button type="link" onClick={() => { setDirty(false); setSelectedId(record.id) }}>{id}</Button> },
            { title: text('feedback.type.label'), dataIndex: 'type', width: 100, render: (value: string) => <Tag color={value === 'Expert' ? 'purple' : 'blue'}>{text(`feedback.type.${value}`)}</Tag> },
            { title: text('feedback.courseLesson'), width: 185, render: (_, record) => <><div>{record.course}</div><small style={{ color: tokens.color.text.secondary }}>{record.lesson ?? text('feedback.noLesson')}</small></> },
            { title: text('feedback.message'), dataIndex: 'feedback', width: 330 },
            { title: text('feedback.reporter'), dataIndex: 'reportedBy', width: 145 },
            { title: text('feedback.submitted'), dataIndex: 'submittedAt', width: 170, render: (value: string) => new Date(value).toLocaleString(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) },
            { title: text('feedback.status.label'), dataIndex: 'status', width: 115, render: (value: FeedbackRecord['status']) => <Tag color={statusColors[value]}>{text(`feedback.status.${value}`)}</Tag> },
          ]} />
      </div>
      <Drawer title={selected ? `${text('feedback.details')} · ${selected.id}` : text('feedback.details')} open={selected !== null} onClose={close} width="min(960px, 100vw)" destroyOnHidden>
        {selected && <>
          <p>{text('feedback.demo')}</p>
          <p>{selected.course} / {selected.lesson ?? text('feedback.noLesson')} · {text(`feedback.mode.${selected.mode}`)} · {text(`feedback.status.${selected.status}`)}</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: 24 }}>
            <div>
              <h2>{text('feedback.conversation')}</h2>
              <h3>{text('feedback.context')}</h3><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{selected.context ?? text('feedback.notCaptured')}</p>
              <h3>{text('feedback.question')}</h3><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{selected.question}</p>
              <div style={{ background: '#FFFBE6', border: '1px solid #FFE58F', borderRadius: 8, padding: 16 }}><h3>{text('feedback.targetAnswer')}</h3><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{selected.answer}</p></div>
            </div>
            <div>
              <h2>{text('feedback.message')}</h2><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{selected.feedback}</p>
              <p>{text(`feedback.type.${selected.type}`)} · {selected.reportedBy}</p>
              <h3>{text('feedback.suggestion')}</h3><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{selected.suggestedAnswer ?? text('feedback.notProvided')}</p>
              <h3>{text('feedback.usage')}</h3><p>{selected.knowledgeUsage ?? text('feedback.notProvided')}</p>
              <FeedbackTriage key={selected.id} record={selected} state={store[selected.id]} actor={owner} canEdit={canEdit} disabled={storageError} save={save} dirty={setDirty} />
              <Tabs items={[{ key: 'trace', label: text('feedback.trace'), children: <p>{text('feedback.traceMissing')}</p> }]} />
            </div>
          </div>
        </>}
      </Drawer>
    </section>
  )
}
