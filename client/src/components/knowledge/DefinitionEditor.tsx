import { useEffect, useRef, useState, type ComponentRef } from 'react'
import { knowledgeApi, type PageNode } from '../../api/knowledge'
import { definitionBody, definitionFields, type TeachingDraft } from '../../api/teachingCards'
import { Alert, Button, Input, Select } from '../ui'
import { CourseReferencePicker } from './CourseReferencePicker'
import { useKText } from './i18n'

export function DefinitionEditor({ courseId, draft, disabled, missing, update }: {
  courseId: string; draft: TeachingDraft; disabled: boolean; missing: string[]; update: (patch: Partial<TeachingDraft>) => void
}) {
  const { text } = useKText()
  const label = (key: string) => text('teaching.' + key)
  const name = definitionFields(draft).definitionName
  const body = definitionBody(draft)
  const patch = (fields: Partial<TeachingDraft['approvedPayload']>) => ({
    ...draft.approvedPayload, definitionName: name, answerMd: body, ...fields,
  })
  const [pages, setPages] = useState<PageNode[]>([])
  const [error, setError] = useState('')
  const [attempt, retry] = useState(0)
  useEffect(() => {
    let active = true
    knowledgeApi.getCourse(courseId).then(course => {
      if (active) { setPages(course.pages.filter(page => page.syncState === 'SYNCED')); setError('') }
    }).catch((cause: Error) => { if (active) setError(cause.message) })
    return () => { active = false }
  }, [courseId, attempt])
  const excerpt = draft.evidence[0] ?? ''
  const bound = pages.find(page => draft.approvedPayload.sourcePageId
    ? page.id === draft.approvedPayload.sourcePageId : excerpt && page.contentMd.includes(excerpt))
  const [pageId, selectPage] = useState('')
  const page = pages.find(item => item.id === pageId) ?? bound
  const sourceInput = useRef<ComponentRef<typeof Input.TextArea>>(null)
  const bodyInput = useRef<ComponentRef<typeof Input.TextArea>>(null)
  const [invalid, setInvalid] = useState(false)
  const [picker, setPicker] = useState(false)
  const caret = useRef<[number, number] | null>(null)
  const attrs = (key: string) => ({ required: true, 'aria-label': label(key), 'aria-invalid': missing.includes(key) || undefined })
  return <>
    <label>{label('definitionName')} *
      <Input {...attrs('definitionName')} maxLength={100} value={name} disabled={disabled}
        onChange={event => update({ approvedPayload: patch({ definitionName: event.target.value }) })} />
    </label>
    <label>{label('definitionBody')} *
      <Input.TextArea ref={bodyInput} {...attrs('definitionBody')} rows={6} value={body} disabled={disabled} maxLength={12000}
        onChange={event => update({ approvedPayload: patch({ answerMd: event.target.value }) })} />
    </label>
    {!disabled && <Button onClick={() => {
      const el = bodyInput.current?.resizableTextArea?.textArea
      caret.current = el ? [el.selectionStart, el.selectionEnd] : null
      setPicker(true)
    }}>{label('insert')}</Button>}
    {picker && !disabled && <CourseReferencePicker courseId={courseId} onCancel={() => setPicker(false)} onInsert={item => {
      const [start, end] = caret.current ?? [body.length, body.length]
      const link = '[' + item.label + '](refobj:' + item.id + ')'
      update({ approvedPayload: patch({ answerMd: body.slice(0, start) + link + body.slice(end) }) })
      const position = start + link.length
      requestAnimationFrame(() => bodyInput.current?.resizableTextArea?.textArea.setSelectionRange(position, position))
      setPicker(false)
    }} />}
    <section aria-label={label('optionalSource')}>
      <h4>{label('optionalSource')}</h4>
      {error && <Alert type="error" message={error} action={<Button onClick={() => retry(value => value + 1)}>{text('common.retry')}</Button>} />}
      <label className="teaching-select-field">{label('sourcePage')}
        <Select aria-label={label('sourcePage')} value={page?.id} disabled={disabled} options={pages.map(item => ({ value: item.id, label: item.title }))}
          onChange={id => { selectPage(id); setInvalid(false) }} />
      </label>
      {page && !disabled && <>
        <Input.TextArea key={page.id} ref={sourceInput} readOnly rows={6} aria-label={label('browseSources')} value={page.contentMd} />
        <Button onClick={() => {
          const el = sourceInput.current?.resizableTextArea?.textArea
          const selection = el?.value.slice(el.selectionStart, el.selectionEnd).trim() ?? ''
          const matching = pages.filter(item => item.contentMd.includes(selection))
          if (!selection || selection.length > 3200 || matching.length !== 1 || matching[0].id !== page.id ||
            page.contentMd.indexOf(selection) !== page.contentMd.lastIndexOf(selection)) { setInvalid(true); return }
          update({ evidence: [selection, ...draft.evidence.slice(1)], approvedPayload: patch({ sourcePageId: page.id }) })
          setInvalid(false)
        }}>{label('useSelection')}</Button>
        {invalid && <Alert type="warning" message={label('uniquePassage')} />}
      </>}
      <label>{label('definitionExcerpt')}
        <Input.TextArea aria-label={label('definitionExcerpt')} readOnly rows={3} value={draft.evidence.join('\n\n')} />
      </label>
      {bound && <small>{label('passageSource')} · {bound.title}</small>}
      {excerpt && !disabled && <Button onClick={() => {
        selectPage('')
        setInvalid(false)
        update({ evidence: [], approvedPayload: patch({ sourcePageId: undefined }) })
      }}>{label('removeSource')}</Button>}
    </section>
  </>
}
