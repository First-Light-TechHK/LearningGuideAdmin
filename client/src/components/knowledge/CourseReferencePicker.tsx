import { useEffect, useRef, useState, type ComponentRef } from 'react'
import { teachingCardsApi, type TeachingRef } from '../../api/teachingCards'
import { Alert, Button, Empty, Input, Modal, Spin, Tag } from '../ui'
import { KnowledgeMarkdown } from './KnowledgeMarkdown'
import { useKText } from './i18n'
import './CourseReferencePicker.css'

export function CourseReferencePicker({ courseId, onCancel, onInsert }: {
  courseId: string; onCancel: () => void; onInsert: (item: TeachingRef) => void
}) {
  const { text } = useKText()
  const [items, setItems] = useState<TeachingRef[]>()
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const search = useRef<ComponentRef<typeof Input>>(null)
  useEffect(() => {
    const controller = new AbortController()
    teachingCardsApi.references(courseId, controller.signal).then(rows => {
      if (!controller.signal.aborted) setItems(rows)
    }).catch((cause: Error) => {
      if (!controller.signal.aborted) setError(cause.message)
    })
    return () => controller.abort()
  }, [courseId, attempt])

  const matches = (item: TeachingRef, value: string) =>
    [item.label, item.code].some(part => part?.toLowerCase().includes(value.trim().toLowerCase()))
  const visible = items?.filter(item => matches(item, query)) ?? []
  const selected = visible.find(item => item.id === selectedId)
  const changeQuery = (value: string) => {
    if (selected && !matches(selected, value)) setSelectedId('')
    setQuery(value)
  }
  return <Modal open centered width={640} className="course-reference-picker"
    title={text('teaching.insert')} okText={text('teaching.insert')} cancelText={text('common.cancel')}
    afterOpenChange={open => { if (open) search.current?.focus() }}
    okButtonProps={{ disabled: !selected }} onOk={() => { if (selected) onInsert(selected) }} onCancel={onCancel}>
    <Input ref={search} autoFocus allowClear value={query} aria-label={text('teaching.searchReferences')}
      placeholder={text('teaching.searchReferences')} onChange={event => changeQuery(event.target.value)} />
    <div className="course-reference-results">{error ? <Alert type="error" showIcon message={error} action={<Button size="small" onClick={() => {
      setError(''); setAttempt(n => n + 1)
    }}>{text('common.retry')}</Button>} /> : !items ? <Spin /> : !items.length
      ? <Empty description={text('teaching.refEmpty')} />
      : !visible.length ? <Empty description={text('teaching.noMatches')}>
        <Button onClick={() => { changeQuery(''); search.current?.focus() }}>{text('teaching.clearSearch')}</Button>
      </Empty> : <div role="radiogroup" aria-label={text('teaching.ref')} className="course-reference-list">
        {visible.map(item => <label key={item.id} className="course-reference-row" title={item.label}>
          <input type="radio" name="course-reference" value={item.id} checked={item.id === selectedId}
            onChange={() => setSelectedId(item.id)} />
          <span className="course-reference-name">{item.label}</span>
          {item.code && !item.label.includes(item.code) && <small>{item.code}</small>}
          <Tag>{text(item.kind === 'image' ? 'teaching.image' : 'teaching.formula')}</Tag>
        </label>)}
      </div>}</div>
    {selected && <section className="course-reference-preview" data-color-mode="light" aria-label={text('editor.preview')}>
      <KnowledgeMarkdown source={`[${selected.label}](refobj:${selected.id})`} courseId={courseId} references={[selected]} />
    </section>}
  </Modal>
}
