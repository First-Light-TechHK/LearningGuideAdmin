import './support/dom'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import { App } from '../src/components/ui'
import { CourseTree } from '../src/components/knowledge/CourseTree'
import { UploadDocumentModal } from '../src/components/knowledge/UploadDocumentModal'
import { buildAccess, WorkspaceAccessContext } from '../src/backoffice/lib/workspaceAccessState'
import { useKnowledgeStore } from '../src/stores/knowledgeStore'
import { knowledgeApi } from '../src/api/knowledge'

const initial = useKnowledgeStore.getState()
const originalCreate = knowledgeApi.createPage
const originalDetail = knowledgeApi.getCourse
const originalConvert = knowledgeApi.convertFile
const course = { id: 'course', title: 'Test course', description: null, externalId: null, createdAt: '', updatedAt: '' }
const page = { id: 'page', title: 'Test page', contentMd: '', sectionTags: {}, sortOrder: 0, syncState: 'SYNCED' as const }

afterEach(() => {
  cleanup()
  useKnowledgeStore.setState(initial, true)
  knowledgeApi.createPage = originalCreate
  knowledgeApi.getCourse = originalDetail
  knowledgeApi.convertFile = originalConvert
})

function setup() {
  useKnowledgeStore.setState({ courses: [course], details: { course: { ...course, pages: [] } } })
}

async function openCreate() {
  const view = render(<MemoryRouter><ConfigProvider theme={{ token: { motion: false } }}><App><WorkspaceAccessContext.Provider value={buildAccess('ADMIN', 'knowledge')}>
    <CourseTree keyword="" />
  </WorkspaceAccessContext.Provider></App></ConfigProvider></MemoryRouter>)
  fireEvent.click(view.container.querySelector('.anticon-more')!)
  fireEvent.click(await screen.findByText('New page'))
  const dialog = await screen.findByRole('dialog')
  const input = dialog.querySelector('input')!
  fireEvent.change(input, { target: { value: 'Test page' } })
  return input
}

test('repeated Enter and create clicks issue one request while creation is pending', async () => {
  setup()
  let release!: () => void
  let calls = 0
  const pending = new Promise<void>((resolve) => { release = resolve })
  useKnowledgeStore.setState({ createPage: async () => { calls++; await pending; return page } })
  const input = await openCreate()
  const button = screen.getByRole('button', { name: 'Create', exact: true }) as HTMLButtonElement
  act(() => {
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13 })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13 })
    fireEvent.click(button)
  })
  assert.equal(calls, 1)
  assert.equal(button.disabled, true)
  assert.equal((input as HTMLInputElement).disabled, true)
  await act(async () => release())
  await waitFor(() => assert.ok(!screen.queryByRole('dialog')))
})

test('a failed create unlocks the dialog so the user can retry', async () => {
  setup()
  const requestIds: Array<string | undefined> = []
  useKnowledgeStore.setState({ createPage: async (_course, _title, id) => {
    requestIds.push(id)
    if (requestIds.length === 1) throw new Error('Create failed')
    return page
  } })
  await openCreate()
  fireEvent.click(screen.getByRole('button', { name: 'Create', exact: true }))
  await waitFor(() => assert.equal((screen.getByRole('button', { name: 'Create', exact: true }) as HTMLButtonElement).disabled, false))
  fireEvent.click(screen.getByRole('button', { name: 'Create', exact: true }))
  await waitFor(() => assert.ok(!screen.queryByRole('dialog')))
  assert.equal(requestIds.length, 2)
  assert.ok(requestIds[0])
  assert.equal(requestIds[0], requestIds[1])
})

test('a successful POST remains successful when directory refresh fails and keeps the returned page', async () => {
  setup()
  let calls = 0
  knowledgeApi.createPage = async () => { calls++; return page }
  knowledgeApi.getCourse = async () => { throw new Error('Refresh failed') }
  await useKnowledgeStore.getState().createPage('course', 'Test page')
  assert.equal(calls, 1)
  assert.deepEqual(useKnowledgeStore.getState().details.course.pages, [page])
})

test('a failed POST rejects without adding a blank page', async () => {
  setup()
  knowledgeApi.createPage = async () => { throw new Error('Create failed') }
  await assert.rejects(useKnowledgeStore.getState().createPage('course', 'Test page'), /Create failed/)
  assert.deepEqual(useKnowledgeStore.getState().details.course.pages, [])
})

test('document import keeps and opens the created page when the directory refresh fails', async () => {
  setup()
  const imported = { ...page, contentMd: 'Imported content' }
  knowledgeApi.createPage = async (_courseId, body) => {
    assert.equal(body.requestId, 'same-request')
    return imported
  }
  knowledgeApi.getCourse = async () => { throw new Error('Refresh failed') }
  await useKnowledgeStore.getState().importDocument('course', {
    title: imported.title, contentMd: imported.contentMd, requestId: 'same-request',
  })
  assert.deepEqual(useKnowledgeStore.getState().details.course.pages, [imported])
  assert.equal(useKnowledgeStore.getState().draft?.pageId, imported.id)
})

test('document import blocks repeated confirmation and closing until the write completes', async () => {
  knowledgeApi.convertFile = async () => ({ title: page.title, markdown: 'Imported content' })
  let closeCalls = 0
  let finish!: () => void
  const requests: Array<string | undefined> = []
  useKnowledgeStore.setState({ importDocument: async (_courseId, doc) => {
    requests.push(doc.requestId)
    await new Promise<void>((resolve) => { finish = resolve })
  } })
  render(<ConfigProvider theme={{ token: { motion: false } }}><App>
    <UploadDocumentModal target={{ courseId: 'course', courseTitle: course.title }} onClose={() => closeCalls++} />
  </App></ConfigProvider>)
  const dialog = await screen.findByRole('dialog')
  await act(async () => {
    fireEvent.change(dialog.querySelector('input[type=file]')!, {
      target: { files: [new File(['Imported content'], 'lesson.md')] },
    })
  })
  fireEvent.click(screen.getByRole('button', { name: /^Next/ }))
  const button = await screen.findByRole('button', { name: 'Import' })
  const cancel = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement
  act(() => { fireEvent.click(button); fireEvent.click(button); fireEvent.click(cancel) })
  assert.equal(requests.length, 1)
  assert.ok(requests[0])
  assert.equal(cancel.disabled, true)
  assert.equal(closeCalls, 0)
  await act(async () => finish())
  assert.equal(closeCalls, 1)
})

test('page reorder sends only the newest queued order after an in-flight write', async () => {
  const reorder = knowledgeApi.reorderPages
  let finish!: () => void
  const calls: string[][] = []
  knowledgeApi.reorderPages = async (_id, ids) => {
    calls.push(ids)
    if (calls.length === 1) await new Promise<void>((resolve) => { finish = resolve })
    return { orderedIds: ids }
  }
  try {
    const store = useKnowledgeStore.getState()
    const first = store.reorderPages('course', ['a', 'b', 'c'])
    await Promise.resolve()
    const second = store.reorderPages('course', ['a', 'c', 'b'])
    const last = store.reorderPages('course', ['c', 'b', 'a'])
    assert.deepEqual(calls, [['a', 'b', 'c']])
    finish()
    await Promise.all([first, second, last])
    assert.deepEqual(calls, [['a', 'b', 'c'], ['c', 'b', 'a']])
  } finally {
    knowledgeApi.reorderPages = reorder
  }
})
