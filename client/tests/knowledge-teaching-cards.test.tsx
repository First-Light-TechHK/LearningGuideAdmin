import './support/dom'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import { App } from '../src/components/ui'
import { useKnowledgeStore } from '../src/stores/knowledgeStore'
import { buildAccess, WorkspaceAccessContext } from '../src/backoffice/lib/workspaceAccessState'
import { TeachingCardsPanel } from '../src/components/knowledge/TeachingCardsPanel'
import { knowledgeApi } from '../src/api/knowledge'
import { teachingCardsApi, type TeachingEntry } from '../src/api/teachingCards'

const previous = useKnowledgeStore.getState()
const api = { ...teachingCardsApi }
const getCourse = knowledgeApi.getCourse
afterEach(() => {
  cleanup()
  useKnowledgeStore.setState(previous, true)
  Object.assign(teachingCardsApi, api)
  knowledgeApi.getCourse = getCourse
})

test('saves a course-scoped teaching entry ready for release in one action', async () => {
  useKnowledgeStore.setState({ courses: [
    { id: 'course-1', title: 'Modeling Life', description: null, externalId: null, createdAt: '', updatedAt: '' },
    { id: 'course-2', title: 'Second course', description: null, externalId: null, createdAt: '', updatedAt: '' },
  ] })
  knowledgeApi.getCourse = async () => ({ ...useKnowledgeStore.getState().courses[0], pages: [] })
  teachingCardsApi.list = async (courseId, onStamp) => {
    onStamp?.('workspace-at-open')
    assert.ok(['course-1', 'course-2'].includes(courseId))
    return []
  }
  let stored: TeachingEntry | undefined
  teachingCardsApi.create = async (courseId, draft, stamp) => {
    assert.equal(stamp, 'workspace-at-open')
    assert.equal(courseId, 'course-1')
    assert.equal(draft.approvedPayload.answerMd, 'A state is the condition of the system at a given time.')
    stored = { id: 'card-1', createdAt: '2026-11-26T00:00:00.000Z', additionPosition: 0, revision: 1, draft, approved: draft, approvedRevision: 1 }
    return stored
  }
  teachingCardsApi.update = async (courseId, cardId, revision, draft, stamp) => {
    assert.equal(stamp, 'workspace-at-open')
    assert.deepEqual([courseId, cardId, revision], ['course-1', 'card-1', 1])
    assert.equal(draft.approvedPayload.answerMd, 'Updated explanation.')
    stored = { id: cardId, createdAt: '2026-11-26T00:00:00.000Z', additionPosition: 0, revision: 2, draft, approved: draft, approvedRevision: 2 }
    return stored
  }
  render(<MemoryRouter initialEntries={['/en-GB/knowledge?tab=teaching']}><Routes>
    <Route path="/:locale/knowledge" element={<ConfigProvider virtual={false} theme={{ token: { motion: false } }}><App>
      <WorkspaceAccessContext.Provider value={buildAccess('ADMIN', 'knowledge')}>
        <TeachingCardsPanel />
      </WorkspaceAccessContext.Provider>
    </App></ConfigProvider>} />
  </Routes></MemoryRouter>)
  const add = await screen.findByRole('button', { name: 'Add entry' })
  await waitFor(() => assert.equal((add as HTMLButtonElement).disabled, false))
  await act(async () => { fireEvent.click(add) })
  assert.ok(screen.getByText('Unsaved', { selector: '.ant-tag' }))
  assert.ok(screen.getByRole('textbox', { name: 'Supplementary definition' }))
  assert.equal(screen.queryByRole('button', { name: 'Wiki draft review' }), null)
  const headings = Array.from(document.querySelectorAll('.teaching-group-toggle'), el => el.textContent?.replace(/[^A-Za-z &]/g, '').trim())
  assert.deepEqual(headings, ['Definition', 'Misconception', 'Professor Q&A', 'Reference object'])
  const kind = screen.getByRole('combobox', { name: 'Entry type' })
  fireEvent.mouseDown(kind)
  assert.deepEqual((await screen.findAllByRole('option')).map(option => option.textContent), [
    'Definition', 'Misconception', 'Professor Q&A', 'Reference object',
  ])
  fireEvent.click(screen.getByRole('option', { name: 'Definition' }))
  for (const name of ['Chinese concept label', 'Chinese summary', 'English summary', 'English concept label']) {
    assert.equal(screen.queryByRole('textbox', { name }), null)
  }
  for (const name of ['Linked passage', 'Concept name', 'Supplementary definition']) {
    assert.equal((screen.getByRole('textbox', { name }) as HTMLInputElement).required, true)
  }
  fireEvent.mouseDown(kind)
  fireEvent.click(await screen.findByRole('option', { name: 'Professor Q&A' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
  assert.equal(screen.queryByRole('combobox', { name: 'Answer mode' }), null)
  const warning = screen.getByRole('alert')
  assert.match(warning.textContent ?? '', /Student question/)
  assert.match(warning.textContent ?? '', /Professor answer/)
  assert.doesNotMatch(warning.textContent ?? '', /Key teaching point|source excerpt/i)
  assert.equal(stored, undefined)
  assert.equal(screen.queryByRole('textbox', { name: /keywords|variants|alternative phrasings/i }), null)
  fireEvent.change(screen.getByRole('textbox', { name: 'Student question' }), { target: { value: 'What is a state?' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Professor answer' }), {
    target: { value: 'A state is the condition of the system at a given time.' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
  assert.ok(await screen.findByText('Saved', { selector: '.ant-tag' }))
  assert.equal(screen.queryByRole('button', { name: /approve revision|withdraw approval/i }), null)
  const answer = screen.getByRole('textbox', { name: 'Professor answer' }) as HTMLTextAreaElement
  await waitFor(() => assert.equal(answer.disabled, false))
  fireEvent.change(answer, { target: { value: 'Updated explanation.' } })
  assert.ok(screen.getByText('Unsaved', { selector: '.ant-tag' }))
  const save = screen.getByRole('button', { name: 'Save draft' })
  await waitFor(() => assert.ok(!save.classList.contains('ant-btn-loading')))
  fireEvent.click(save)
  await waitFor(() => assert.equal(stored?.revision, 2))
  assert.ok(await screen.findByText('Saved', { selector: '.ant-tag' }))
  await act(async () => { fireEvent.click(add) })
  assert.equal((await screen.findByRole('textbox', { name: 'Student question' }) as HTMLInputElement).value, '')
  fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Course' }))
  fireEvent.click(await screen.findByRole('option', { name: 'Second course' }))
  const nextAdd = await screen.findByRole('button', { name: 'Add entry' })
  await waitFor(() => assert.equal((nextAdd as HTMLButtonElement).disabled, false))
  await act(async () => { fireEvent.click(nextAdd) })
  assert.ok(screen.getByRole('textbox', { name: 'Supplementary definition' }))
  assert.equal(screen.queryByRole('textbox', { name: 'Student question' }), null)
})

test('selects the script passage and inserts a course formula at the definition cursor', async () => {
  const course = { id: 'defs', title: 'Dynamics', description: null, externalId: null, createdAt: '', updatedAt: '' }
  const passage = '我们唯一关注的变量就是温度，其他都不考虑？'
  useKnowledgeStore.setState({ courses: [course] })
  knowledgeApi.getCourse = async () => ({ ...course, pages: [{ id: 'lesson', title: 'Lesson 1',
    contentMd: passage, sectionTags: null, sortOrder: 0, syncState: 'SYNCED' }] })
  teachingCardsApi.list = async () => []
  teachingCardsApi.references = async () => [{ id: 'temperature', label: 'Temp', kind: 'latex', value: 'T(t)', requires: [] }]
  let stored: TeachingEntry | undefined
  teachingCardsApi.create = async (_, draft) => {
    stored = { id: 'definition', createdAt: '', additionPosition: 0, revision: 1, draft, approved: draft, approvedRevision: 1 }
    return stored
  }
  render(<MemoryRouter initialEntries={['/en-GB/knowledge?tab=teaching&courseId=defs&draftId=new']}><Routes>
    <Route path="/:locale/knowledge" element={<ConfigProvider virtual={false} theme={{ token: { motion: false } }}><App>
      <WorkspaceAccessContext.Provider value={buildAccess('ADMIN', 'knowledge')}><TeachingCardsPanel /></WorkspaceAccessContext.Provider>
    </App></ConfigProvider>} />
  </Routes></MemoryRouter>)
  const save = await screen.findByRole('button', { name: 'Save draft' })
  fireEvent.click(save)
  assert.match(screen.getByRole('alert').textContent ?? '', /Linked passage.*Concept name.*Supplementary definition/)
  fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Source page' }))
  fireEvent.click(await screen.findByRole('option', { name: 'Lesson 1' }))
  const source = screen.getByRole('textbox', { name: 'Browse course sources' }) as HTMLTextAreaElement
  source.setSelectionRange(0, passage.length)
  fireEvent.click(screen.getByRole('button', { name: 'Use selected passage' }))
  assert.equal((screen.getByRole('textbox', { name: 'Linked passage' }) as HTMLTextAreaElement).value, passage)
  fireEvent.change(screen.getByRole('textbox', { name: 'Concept name' }), { target: { value: '状态变量' } })
  const body = screen.getByRole('textbox', { name: 'Supplementary definition' }) as HTMLTextAreaElement
  fireEvent.change(body, { target: { value: '温度反映系统的状态。' } })
  body.setSelectionRange(2, 2)
  fireEvent.click(screen.getByRole('button', { name: 'Insert reference' }))
  fireEvent.click(await screen.findByRole('radio'))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Insert reference' }))
  assert.equal((body as HTMLTextAreaElement).value, '温度[Temp](refobj:temperature)反映系统的状态。')
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
  await waitFor(() => assert.ok(stored, screen.queryByRole('alert')?.textContent ?? 'save'))
  assert.deepEqual(stored?.draft.evidence, [passage])
  assert.equal(stored?.draft.approvedPayload.sourcePageId, 'lesson')
  assert.equal(stored?.draft.approvedPayload.answerMd, '温度[Temp](refobj:temperature)反映系统的状态。')
})

test('previews a filtered batch and clears the editor after single deletion', async () => {
  useKnowledgeStore.setState({ courses: [
    { id: 'course-1', title: 'Modeling Life', description: null, externalId: null, createdAt: '', updatedAt: '' },
  ] })
  const draft = (question: string): TeachingEntry['draft'] => ({
    type: 'professor_qa', topic: '*', conceptId: '', canonicalPoint: question,
    bilingual: { conceptLabel: { en: question, zh: '' }, summary: { en: '', zh: '' }, triggers: { zh: [], en: [] } },
    approvedPayload: { question, answerMd: 'Answer' },
    links: [], useWhen: ['*'], doNotUseWhen: [], evidence: [], priority: 10,
  })
  let rows: TeachingEntry[] = ['Alpha', 'Beta', 'Gamma'].map(id => ({
    id, createdAt: null, additionPosition: 0, revision: 1, approved: null, approvedRevision: null, draft: draft(id),
  }))
  teachingCardsApi.list = async () => rows
  const previews: string[][] = []
  teachingCardsApi.deletionPreview = async (_, items) => {
    previews.push(items.map(i => i.id))
    return { blockers: [] }
  }
  let blockFirstCommit = true
  teachingCardsApi.deleteSelection = async (_, items) => {
    if (blockFirstCommit) {
      blockFirstCommit = false
      return { blockers: [{ id: 'Beta', kind: 'wiki', source: 'Lesson notes' }] }
    }
    rows = rows.filter(row => !items.some(item => item.id === row.id))
    return { blockers: [] }
  }
  render(<MemoryRouter initialEntries={['/en-GB/knowledge?tab=teaching']}><Routes>
    <Route path="/:locale/knowledge" element={<ConfigProvider theme={{ token: { motion: false } }}><App>
      <WorkspaceAccessContext.Provider value={buildAccess('ADMIN', 'knowledge')}><TeachingCardsPanel /></WorkspaceAccessContext.Provider>
    </App></ConfigProvider>} />
  </Routes></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: /Alpha/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Manage selection' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select all filtered entries' }))
  const search = screen.getByRole('textbox', { name: /search/i })
  const group = screen.getByRole('button', { name: /Professor Q&A 3/ })
  fireEvent.click(group)
  assert.equal(screen.queryByRole('checkbox', { name: 'Alpha' }), null)
  assert.equal((screen.getByRole('button', { name: /Delete selected/ }) as HTMLButtonElement).disabled, true)
  fireEvent.change(search, { target: { value: 'mm' } })
  assert.equal((screen.getByRole('button', { name: /Delete selected/ }) as HTMLButtonElement).disabled, true)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Gamma' }))
  fireEvent.change(search, { target: { value: '' } })
  assert.equal(screen.queryByRole('checkbox', { name: 'Gamma' }), null)
  fireEvent.click(group)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Gamma' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Beta' }))
  fireEvent.click(screen.getByRole('button', { name: /Delete selected/ }))
  const dialog = await screen.findByRole('dialog')
  assert.deepEqual(previews, [['Beta', 'Gamma']])
  assert.equal(rows.length, 3)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete entry' }))
  assert.ok(await within(dialog).findByText(/Lesson notes/))
  assert.equal(rows.length, 3)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Select only eligible entries' }))
  await waitFor(() => assert.deepEqual(previews.at(-1), ['Gamma']))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete entry' }))
  await waitFor(() => assert.ok(!screen.queryByRole('dialog')))
  assert.deepEqual(rows.map(row => row.id), ['Alpha', 'Beta'])
  fireEvent.click(screen.getByRole('checkbox', { name: 'Beta' }))
  fireEvent.click(screen.getByRole('button', { name: /Delete selected/ }))
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete entry' }))
  await waitFor(() => assert.ok(!screen.queryByRole('dialog')))
  assert.deepEqual(rows.map(row => row.id), ['Alpha'])
  fireEvent.click(screen.getByRole('button', { name: 'Delete entry' }))
  const single = await screen.findByRole('dialog')
  fireEvent.click(within(single).getByRole('button', { name: 'Delete entry' }))
  await waitFor(() => assert.ok(screen.getByText('There are no teaching entries for this course.')))
  assert.equal(screen.queryByRole('textbox', { name: 'Student question' }), null)
})

test('teaching entries distinguish a migration failure from an empty course and retry in place', async () => {
  useKnowledgeStore.setState({ courses: [
    { id: 'course-1', title: 'Modeling Life', description: null, externalId: null, createdAt: '', updatedAt: '' },
  ] })
  let calls = 0
  teachingCardsApi.list = async () => {
    if (calls++ === 0) throw new Error('The database schema is not ready.')
    return []
  }
  render(<MemoryRouter initialEntries={['/en-GB/knowledge?tab=teaching']}><Routes>
    <Route path="/:locale/knowledge" element={<ConfigProvider theme={{ token: { motion: false } }}><App>
      <WorkspaceAccessContext.Provider value={buildAccess('ADMIN', 'knowledge')}>
        <TeachingCardsPanel />
      </WorkspaceAccessContext.Provider>
    </App></ConfigProvider>} />
  </Routes></MemoryRouter>)
  assert.match((await screen.findByRole('alert')).textContent ?? '', /database schema is not ready/)
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  assert.ok(await screen.findByText('There are no teaching entries for this course.'))
  assert.equal(screen.queryByRole('alert'), null)
})
