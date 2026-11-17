import './support/dom'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { feedbackSource } from '../src/api/feedback'
import { blankTriage, transitionTriage, type TriageState } from '../src/api/feedbackTriage'
import { FeedbackTriage } from '../src/components/ai/FeedbackTriage'

afterEach(cleanup)
const record = feedbackSource.list()[0]
const classified = { ...blankTriage, issue: 'Knowledge gap', outcome: 'Classified only', note: 'Investigate example' }

function mount(options: { canEdit?: boolean; disabled?: boolean; state?: TriageState; fail?: boolean } = {}) {
  const saved: TriageState[] = [], dirty: boolean[] = []
  const save = (value: TriageState) => { if (options.fail) throw new Error('storage'); saved.push(value) }
  const props = { record, actor: 'employee-one', canEdit: options.canEdit ?? true, disabled: options.disabled ?? false, state: options.state, save, dirty: (value: boolean) => dirty.push(value) }
  const view = render(<MemoryRouter><FeedbackTriage {...props} /></MemoryRouter>)
  return { saved, dirty, rerender: (state: TriageState) => view.rerender(<MemoryRouter><FeedbackTriage {...props} state={state} /></MemoryRouter>) }
}
function choose(name: string, label: string) {
  fireEvent.mouseDown(screen.getByRole('combobox', { name }))
  fireEvent.click(screen.getByText(label, { selector: '.ant-select-item-option-content' }))
}

test('VIEW renders history without write fields or buttons', () => {
  const state = transitionTriage(record, undefined, classified, 'Triaged', 'employee-one', '2026-11-13T01:00:00Z')
  mount({ canEdit: false, state })
  assert.ok(screen.getByText('Read-only access'))
  assert.ok(screen.getByText('Investigate example'))
  assert.equal(screen.queryAllByRole('textbox').length, 0)
  assert.equal(screen.queryAllByRole('combobox').length, 0)
  assert.equal(screen.queryAllByRole('button').length, 0)
})

test('missing classification is rejected; valid selectors save Triaged and append on repeat', () => {
  const view = mount()
  fireEvent.click(screen.getByRole('button', { name: 'Save triage' }))
  assert.ok(screen.getByText('Select a likely issue and resolution.'))
  assert.equal(view.saved.length, 0)
  choose('Likely issue', 'Knowledge gap')
  choose('Resolution', 'Classified only')
  fireEvent.change(screen.getByRole('textbox', { name: 'Internal note / reason' }), { target: { value: 'Investigate example' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save triage' }))
  assert.equal(view.saved[0].status, 'Triaged')
  assert.equal(view.saved[0].history.length, 1)
  assert.equal(view.dirty.at(-1), false)
  view.rerender(view.saved[0])
  fireEvent.change(screen.getByRole('textbox', { name: 'Internal note / reason' }), { target: { value: 'Second diagnosis' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save triage' }))
  assert.equal(view.saved.length, 2)
  assert.equal(view.saved[1].history.length, 2)
  assert.equal(view.saved[1].history[0].draft.note, 'Investigate example')
  assert.equal(view.saved[1].history[1].draft.note, 'Second diagnosis')
})

test('storage failure preserves draft and dirty state without reporting a successful save', () => {
  const state = transitionTriage(record, undefined, classified, 'Triaged', 'employee-one')
  const view = mount({ state, fail: true })
  const note = screen.getByRole('textbox', { name: 'Internal note / reason' }) as HTMLTextAreaElement
  fireEvent.change(note, { target: { value: 'Unsaved diagnosis' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save triage' }))
  assert.ok(screen.getByText(/Browser storage is unavailable/))
  assert.equal(note.value, 'Unsaved diagnosis')
  assert.equal(view.dirty.at(-1), true)
  assert.equal(view.saved.length, 0)
})

test('closed record can be reopened with reason and closure is cleared', () => {
  const state = transitionTriage(record, undefined, { ...classified, outcome: 'No action needed', note: 'No issue found' }, 'Dismissed', 'employee-one')
  const view = mount({ state })
  assert.equal(screen.queryByRole('button', { name: 'Save triage' }), null)
  fireEvent.change(screen.getByRole('textbox', { name: 'Internal note / reason' }), { target: { value: 'New evidence received' } })
  fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
  assert.equal(view.saved.length, 1)
  assert.equal(view.saved[0].status, 'Triaged')
  assert.equal(view.saved[0].resolvedAt, null)
  assert.equal(view.saved[0].history.at(-1)?.draft.note, 'New evidence received')
})

test('storage-disabled view disables all mutation controls', () => {
  mount({ disabled: true })
  for (const button of screen.getAllByRole('button')) assert.equal((button as HTMLButtonElement).disabled, true)
  for (const textbox of screen.getAllByRole('textbox')) assert.equal((textbox as HTMLTextAreaElement).disabled, true)
})

test('dismiss and reopen in the same drawer requires a fresh reason', () => {
  const view = mount()
  choose('Likely issue', 'No issue')
  choose('Resolution', 'No action needed')
  const note = screen.getByRole('textbox', { name: 'Internal note / reason' }) as HTMLTextAreaElement
  fireEvent.change(note, { target: { value: 'No change needed' } })
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  assert.equal(view.saved.length, 1)
  view.rerender(view.saved[0])
  assert.equal(note.value, '')
  fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
  assert.equal(view.saved.length, 1)
  assert.ok(screen.getByText('Enter a reason. Dismissal also requires No action needed.'))
  fireEvent.change(note, { target: { value: 'New evidence to review' } })
  fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
  assert.equal(view.saved.length, 2)
  assert.equal(view.saved[1].history.length, 2)
  assert.equal(view.saved[1].history[0].draft.note, 'No change needed')
  assert.equal(view.saved[1].history[1].draft.note, 'New evidence to review')
})
