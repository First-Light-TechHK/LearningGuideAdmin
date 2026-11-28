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

test('previews the primary reference name and saves a single name and summary', async () => {
  const course = { id: 'references', title: 'References', description: null, externalId: null, createdAt: '', updatedAt: '' }
  useKnowledgeStore.setState({ courses: [course] })
  knowledgeApi.getCourse = async () => ({ ...course, pages: [] })
  const draft: TeachingEntry['draft'] = {
    type: 'ref_obj', topic: '*', conceptId: 'formula-1', canonicalPoint: 'A vector norm',
    bilingual: { conceptLabel: { en: 'Vector norm', zh: '向量范数' }, summary: { en: 'A vector norm', zh: '向量的范数' }, triggers: { en: [], zh: [] } },
    approvedPayload: { answerMd: '', code: 'F-01', displayName: 'Old label', refObjects: [{ id: 'formula-1', kind: 'latex', label: 'Old label', value: 'x^2', requires: [] }] },
    useWhen: ['*'], doNotUseWhen: [], links: [], evidence: [], priority: 10,
  }
  const entry: TeachingEntry = { id: 'formula-1', revision: 1, createdAt: null, additionPosition: 0, draft, approved: draft, approvedRevision: 1 }
  teachingCardsApi.list = async () => [entry]
  const saved: TeachingEntry['draft'][] = []
  teachingCardsApi.update = async (_, id, revision, next) => {
    assert.deepEqual([id, revision], [entry.id, 1])
    saved.push(next)
    return { ...entry, revision: 2, draft: next, approved: next, approvedRevision: 2 }
  }
  render(<MemoryRouter initialEntries={['/en-GB/knowledge?tab=teaching&courseId=references&entryId=formula-1']}><Routes>
    <Route path="/:locale/knowledge" element={<ConfigProvider virtual={false} theme={{ token: { motion: false } }}><App>
      <WorkspaceAccessContext.Provider value={buildAccess('ADMIN', 'knowledge')}>
        <TeachingCardsPanel />
      </WorkspaceAccessContext.Provider>
    </App></ConfigProvider>} />
  </Routes></MemoryRouter>)
  const name = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Name' })
  const summary = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Summary' })
  const preview = screen.getByRole('status', { name: 'Name preview' })
  assert.equal(name.value, 'Vector norm')
  assert.equal(summary.value, 'A vector norm')
  assert.equal(preview.textContent, 'F-01 · Vector norm')
  assert.equal(screen.queryByRole('textbox', { name: /chinese|english|display name/i }), null)
  fireEvent.change(name, { target: { value: '向量公式' } })
  fireEvent.change(summary, { target: { value: '计算向量长度。' } })
  assert.equal(preview.textContent, 'F-01 · 向量公式')
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
  await waitFor(() => assert.equal(saved.length, 1))
  assert.deepEqual(saved[0].bilingual.conceptLabel, { en: '向量公式', zh: '向量范数' })
  assert.deepEqual(saved[0].bilingual.summary, { en: '计算向量长度。', zh: '向量的范数' })
  assert.equal(Object.hasOwn(saved[0].approvedPayload, 'displayName'), false)
})

test('previews and imports selected Excel rows in a single three-step dialog', async () => {
  const course = { id: 'lesson', title: 'Lesson 3', description: null, externalId: null, createdAt: '', updatedAt: '' }
  useKnowledgeStore.setState({ courses: [course] })
  knowledgeApi.getCourse = async () => ({ ...course, pages: [] })
  teachingCardsApi.list = async () => []
  const file = new File(['sheet'], 'definitions.xlsx')
  let previews = 0
  teachingCardsApi.previewWorkbook = async (...args) => {
    previews += 1
    assert.deepEqual(args, ['lesson', file])
    return { stamp: 'stamp', skippedSheets: ['Notes'], sheets: [
      { kind: 'concept', name: 'Definitions', targets: [], rows: [
        { row: 2, values: ['Vector field', 'Excerpt', 'Explanation'], status: 'new', sourcePage: 'Vector Fields', issues: [], targetId: null },
        { row: 3, values: ['Trajectory', 'Missing excerpt', 'Explanation'], status: 'invalid', sourcePage: null,
          issues: [{ column: 1, code: 'missingPassage' }], targetId: null },
      ] },
      { kind: 'professor_qa', name: 'Professor Q&A', targets: [], rows: [
        { row: 2, values: ['What is a state?', 'A quantity describing a system.'], status: 'new', sourcePage: null, issues: [], targetId: null },
      ] },
    ] }
  }
  const writes: unknown[][] = []
  teachingCardsApi.applyWorkbook = async (...args) => {
    writes.push(args)
    return { saved: 2 }
  }
  render(<MemoryRouter initialEntries={['/en-GB/knowledge?tab=teaching']}><Routes>
    <Route path="/:locale/knowledge" element={<ConfigProvider virtual={false} theme={{ token: { motion: false } }}><App>
      <WorkspaceAccessContext.Provider value={buildAccess('ADMIN', 'knowledge')}><TeachingCardsPanel /></WorkspaceAccessContext.Provider>
    </App></ConfigProvider>} />
  </Routes></MemoryRouter>)
  const openImport = await screen.findByRole('button', { name: 'Import' })
  assert.ok(screen.getByRole('button', { name: 'Download' }))
  await waitFor(() => assert.equal((openImport as HTMLButtonElement).disabled, false))
  fireEvent.click(openImport)
  const modal = await screen.findByRole('dialog', { name: 'Import teaching entries' })
  const dialog = within(modal)
  assert.equal(dialog.getByText('Choose type').getAttribute('aria-current'), 'step')
  assert.ok(dialog.getByRole('radio', { name: /Formula references/ }))
  assert.ok(dialog.getByRole('radio', { name: /Image references/ }))
  fireEvent.click(dialog.getByRole('radio', { name: /Definitions and Professor Q&A/ }))
  fireEvent.click(dialog.getByRole('button', { name: 'Next' }))
  assert.equal(within(dialog.getByRole('list', { name: 'Transfer progress' })).getByText('Upload file').getAttribute('aria-current'), 'step')
  assert.ok(dialog.getByRole('heading', { name: 'Template and format' }))
  assert.ok(dialog.getByRole('heading', { name: 'Upload file' }))
  assert.match(dialog.getByRole('link', { name: 'Download template' }).getAttribute('href') ?? '', /templates\/workbook/)
  await act(async () => fireEvent.change(dialog.getByLabelText('Excel file'), { target: { files: [file] } }))
  assert.equal(previews, 0)
  await act(async () => fireEvent.click(dialog.getByRole('button', { name: 'Preview file' })))
  assert.equal(dialog.getByText('Review and import').getAttribute('aria-current'), 'step')
  assert.ok(dialog.getByRole('heading', { name: 'Import preview' }))
  assert.ok(dialog.getByRole('heading', { name: 'Definitions' }))
  assert.ok(dialog.getByRole('heading', { name: 'Professor Q&A' }))
  assert.ok(dialog.getByText('Skipped sheets: Notes'))
  assert.ok(dialog.getByText(/Vector Fields/))
  assert.ok(dialog.getByText(/excerpt could not be found/i))
  assert.equal(writes.length, 0)
  fireEvent.click(dialog.getByRole('button', { name: 'Back' }))
  await act(async () => fireEvent.click(dialog.getByRole('button', { name: 'Preview file' })))
  assert.equal(previews, 1)
  assert.deepEqual(screen.getAllByRole('dialog'), [modal])
  await act(async () => fireEvent.click(dialog.getByRole('button', { name: 'Import 2 entries' })))
  assert.deepEqual(writes, [['lesson', file, [{ kind: 'concept', row: 2 }, { kind: 'professor_qa', row: 2 }], 'stamp']])
})

test('downloads the selected sheets and keeps selections across search, tabs, and pages', async (t) => {
  const course = { id: 'lesson', title: 'Lesson 3', description: null, externalId: null, createdAt: '', updatedAt: '' }
  useKnowledgeStore.setState({ courses: [course] })
  knowledgeApi.getCourse = async () => ({ ...course, pages: [] })
  teachingCardsApi.list = async () => ['Vector field', ...Array.from({ length: 100 }, (_, i) => 'Definition ' + (i + 1)), 'Trajectory'].map((name, index): TeachingEntry => ({
    id: 'card-' + index, createdAt: null, additionPosition: index, revision: 1, approved: null, approvedRevision: null,
    draft: {
      type: 'concept', topic: '*', conceptId: name, canonicalPoint: name,
      approvedPayload: { definitionName: name, answerMd: 'Explanation.' },
      bilingual: { conceptLabel: { en: name, zh: '' }, summary: { en: '', zh: '' }, triggers: { en: [], zh: [] } },
      evidence: ['Excerpt'], useWhen: ['*'], doNotUseWhen: [], links: [], priority: 10,
    },
  })).concat({
    id: 'question', createdAt: null, additionPosition: 102, revision: 1, approved: null, approvedRevision: null,
    draft: {
      type: 'professor_qa', topic: '*', conceptId: '', canonicalPoint: 'Explanation.',
      approvedPayload: { question: 'How does a vector change?', answerMd: 'Explanation.' },
      bilingual: { conceptLabel: { en: '', zh: '' }, summary: { en: '', zh: '' }, triggers: { en: [], zh: [] } },
      evidence: [], useWhen: ['*'], doNotUseWhen: [], links: [], priority: 10,
    },
  })
  const calls: unknown[][] = []
  teachingCardsApi.downloadWorkbook = async (...args) => {
    calls.push(args)
    return { blob: new Blob(['sheet']), filename: 'Lesson 3_Definitions.xlsx' }
  }
  t.mock.method(URL, 'createObjectURL', () => 'blob:teaching-transfer-test')
  t.mock.method(HTMLAnchorElement.prototype, 'click', () => undefined)
  render(<MemoryRouter initialEntries={['/en-GB/knowledge?tab=teaching']}><Routes>
    <Route path="/:locale/knowledge" element={<ConfigProvider virtual={false} theme={{ token: { motion: false } }}><App>
      <WorkspaceAccessContext.Provider value={buildAccess('ADMIN', 'knowledge')}><TeachingCardsPanel /></WorkspaceAccessContext.Provider>
    </App></ConfigProvider>} />
  </Routes></MemoryRouter>)
  const download = await screen.findByRole('button', { name: 'Download' })
  await waitFor(() => assert.equal((download as HTMLButtonElement).disabled, false))
  fireEvent.click(download)
  const dialog = within(await screen.findByRole('dialog', { name: 'Download teaching entries' }))
  fireEvent.click(dialog.getByRole('radio', { name: /Definitions and Professor Q&A/ }))
  fireEvent.click(dialog.getByRole('button', { name: 'Next' }))
  fireEvent.click(dialog.getByRole('button', { name: 'Clear selection' }))
  assert.equal(dialog.getByRole<HTMLButtonElement>('button', { name: 'Next' }).disabled, true)
  assert.ok(dialog.getByText('0 of 103 entries selected'))
  fireEvent.click(dialog.getByRole('button', { name: 'Select all' }))
  assert.ok(dialog.getByText('103 of 103 entries selected'))
  fireEvent.click(dialog.getByRole('button', { name: 'Clear this category' }))
  assert.equal(dialog.getAllByRole('checkbox').length, 20)
  fireEvent.click(dialog.getByRole('checkbox', { name: 'Vector field' }))
  fireEvent.click(dialog.getByRole('button', { name: 'Next page' }))
  assert.ok(dialog.getByText('Page 2 of 6 · 102 entries'))
  fireEvent.change(dialog.getByRole('textbox', { name: 'Search definition names' }), { target: { value: 'trajectory' } })
  assert.equal(dialog.getAllByRole('checkbox').length, 1)
  fireEvent.click(dialog.getByRole('button', { name: 'Select search results' }))
  fireEvent.click(dialog.getByRole('tab', { name: 'Professor Q&A (1/1)' }))
  assert.equal(dialog.getByRole<HTMLInputElement>('checkbox', { name: 'How does a vector change?' }).checked, true)
  fireEvent.click(dialog.getByRole('button', { name: 'Next' }))
  assert.equal(dialog.getByText('Confirm download').getAttribute('aria-current'), 'step')
  assert.ok(dialog.getByText('Definitions · 2 entries'))
  assert.ok(dialog.getByText('Professor Q&A · 1 entries'))
  assert.equal(calls.length, 0)
  fireEvent.click(dialog.getByRole('button', { name: 'Back' }))
  fireEvent.click(dialog.getByRole('tab', { name: 'Definitions (2/102)' }))
  assert.equal(dialog.getByRole<HTMLInputElement>('checkbox', { name: 'Vector field' }).checked, true)
  fireEvent.click(dialog.getByRole('button', { name: 'Next' }))
  await act(async () => fireEvent.click(dialog.getByRole('button', { name: 'Download 3 entries' })))
  assert.deepEqual(calls, [['lesson', [{ kind: 'concept', ids: ['card-0', 'card-101'] }, { kind: 'professor_qa', ids: ['question'] }]]])
})

test('cleans up the Word preview when switching to a different import type', async () => {
  const course = { id: 'lesson', title: 'Lesson 3', description: null, externalId: null, createdAt: '', updatedAt: '' }
  useKnowledgeStore.setState({ courses: [course] })
  knowledgeApi.getCourse = async () => ({ ...course, pages: [] })
  teachingCardsApi.list = async () => []
  teachingCardsApi.deletedReferenceCodes = async () => []
  teachingCardsApi.references = async () => []
  const file = new File(['document'], 'images.docx')
  teachingCardsApi.previewReferenceDocument = async (...args) => {
    assert.deepEqual(args, ['lesson', 'image', file])
    return { token: 'staged-image', rows: [{
      code: 'L3-I01', names: { en: 'Vector diagram', zh: '' }, summary: { en: '', zh: '' },
      kind: 'image', value: 'diagram.png',
    }] }
  }
  const finished: unknown[][] = []
  teachingCardsApi.finishReferenceDocuments = async (...args) => { finished.push(args) }
  render(<MemoryRouter initialEntries={['/en-GB/knowledge?tab=teaching']}><Routes>
    <Route path="/:locale/knowledge" element={<ConfigProvider virtual={false} theme={{ token: { motion: false } }}><App>
      <WorkspaceAccessContext.Provider value={buildAccess('ADMIN', 'knowledge')}><TeachingCardsPanel /></WorkspaceAccessContext.Provider>
    </App></ConfigProvider>} />
  </Routes></MemoryRouter>)
  const openImport = await screen.findByRole('button', { name: 'Import' })
  await waitFor(() => assert.equal((openImport as HTMLButtonElement).disabled, false))
  fireEvent.click(openImport)
  const dialog = within(await screen.findByRole('dialog', { name: 'Import teaching entries' }))
  fireEvent.click(dialog.getByRole('radio', { name: /Image references/ }))
  fireEvent.click(dialog.getByRole('button', { name: 'Next' }))
  fireEvent.change(dialog.getByLabelText('Choose formula cards or exhibit notes'), { target: { files: [file] } })
  await act(async () => fireEvent.click(dialog.getByRole('button', { name: 'Preview file' })))
  assert.ok(dialog.getByRole('checkbox', { name: /Vector diagram/ }))
  fireEvent.click(dialog.getByRole('button', { name: 'Back' }))
  fireEvent.click(dialog.getByRole('button', { name: 'Back' }))
  assert.equal(finished.length, 0)
  fireEvent.click(dialog.getByRole('radio', { name: /Definitions and Professor Q&A/ }))
  assert.deepEqual(finished, [['lesson', ['staged-image']]])
  fireEvent.click(dialog.getByRole('button', { name: 'Next' }))
  assert.equal((dialog.getByRole('button', { name: 'Preview file' }) as HTMLButtonElement).disabled, true)
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
  for (const name of ['Concept name', 'Supplementary definition']) {
    assert.equal((screen.getByRole('textbox', { name }) as HTMLInputElement).required, true)
  }
  assert.equal((screen.getByRole('textbox', { name: 'Linked passage' }) as HTMLTextAreaElement).required, false)
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
  assert.match(screen.getByRole('alert').textContent ?? '', /Concept name.*Supplementary definition/)
  assert.doesNotMatch(screen.getByRole('alert').textContent ?? '', /Linked passage/)
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
