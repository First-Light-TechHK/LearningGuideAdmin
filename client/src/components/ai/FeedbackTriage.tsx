import { useState } from 'react'
import { Alert, Button, Input, Select } from 'antd'
import type { FeedbackRecord, FeedbackStatus } from '../../api/feedback'
import { blankTriage, issues, outcomes, transitionTriage, type TriageDraft, type TriageState } from '../../api/feedbackTriage'
import { useAiText } from './i18n'

export function FeedbackTriage({ record, state, actor, canEdit, disabled, save, dirty }: {
  record: FeedbackRecord; state?: TriageState; actor: string; canEdit: boolean; disabled: boolean
  save: (state: TriageState) => void; dirty: (value: boolean) => void
}) {
  const { text } = useAiText()
  const [draft, setDraft] = useState<TriageDraft>({ ...blankTriage, ...state, note: ['Applied', 'Dismissed'].includes(state?.status ?? record.status) ? '' : state?.note ?? '' })
  const [error, setError] = useState('')
  const status = state?.status ?? record.status
  const closed = status === 'Applied' || status === 'Dismissed'
  const update = (patch: Partial<TriageDraft>) => { setDraft((current) => ({ ...current, ...patch })); dirty(true) }
  const submit = (target: FeedbackStatus) => {
    try {
      const next = transitionTriage(record, state, draft, target, actor)
      save(next)
      setDraft({ ...next, note: target === 'Applied' || target === 'Dismissed' ? '' : next.note }); dirty(false); setError('')
    } catch (cause) { setError(text(`feedback.triage.errors.${cause instanceof Error ? cause.message : 'storage'}`)) }
  }
  return <section>
    <h3>{text('feedback.triage.title')}</h3>
    {error && <Alert type="error" role="alert" message={error} />}
    {canEdit ? <>
      <label>{text('feedback.triage.issue')}<Select aria-label={text('feedback.triage.issue')} value={draft.issue || undefined} disabled={disabled || closed} style={{ width: '100%' }} options={issues.map((value, i) => ({ value, label: text(`feedback.triage.issue${i}`) }))} onChange={(issue) => update({ issue })} /></label>
      <label>{text('feedback.triage.outcome')}<Select aria-label={text('feedback.triage.outcome')} value={draft.outcome || undefined} disabled={disabled || closed} style={{ width: '100%' }} options={outcomes.map((value, i) => ({ value, label: text(`feedback.triage.outcome${i}`) }))} onChange={(outcome) => update({ outcome })} /></label>
      {(['note', 'change', 'verification'] as const).map((field) => <label key={field} style={{ display: 'block', marginTop: 12 }}>{text(`feedback.triage.${field}`)}<Input.TextArea aria-label={text(`feedback.triage.${field}`)} value={draft[field]} disabled={disabled} maxLength={5000} autoSize={{ minRows: 2, maxRows: 5 }} onChange={(e) => update({ [field]: e.target.value })} /></label>)}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
        {closed ? <Button disabled={disabled} onClick={() => submit('Triaged')}>{text('feedback.triage.reopen')}</Button> : <>
          <Button type="primary" disabled={disabled} onClick={() => submit('Triaged')}>{text('feedback.triage.save')}</Button>
          <Button disabled={disabled || status !== 'Triaged'} onClick={() => submit('Applied')}>{text('feedback.triage.apply')}</Button>
          <Button disabled={disabled} onClick={() => submit('Dismissed')}>{text('feedback.triage.dismiss')}</Button>
        </>}
      </div>
    </> : <p>{text('feedback.triage.readOnly')}</p>}
    <h3>{text('feedback.triage.history')}</h3>
    {!(state?.history.length) && <p>{text('feedback.triage.noHistory')}</p>}
    {[...(state?.history ?? [])].reverse().map((event, i) => <div key={i} style={{ borderTop: '1px solid #E8EDF5', padding: '12px 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      <p>{event.at} · {event.actor} · {text(`feedback.status.${event.from}`)} → {text(`feedback.status.${event.to}`)}</p>
      <p>{issues.includes(event.draft.issue as typeof issues[number]) ? text(`feedback.triage.issue${issues.indexOf(event.draft.issue as typeof issues[number])}`) : event.draft.issue} / {outcomes.includes(event.draft.outcome as typeof outcomes[number]) ? text(`feedback.triage.outcome${outcomes.indexOf(event.draft.outcome as typeof outcomes[number])}`) : event.draft.outcome}</p><p>{event.draft.note}</p><p>{event.draft.change}</p><p>{event.draft.verification}</p>
    </div>)}
  </section>
}
