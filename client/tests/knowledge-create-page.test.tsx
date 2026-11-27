import './support/dom'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import { App } from '../src/components/ui'
import { CourseTree } from '../src/components/knowledge/CourseTree'
import { buildAccess, WorkspaceAccessContext } from '../src/backoffice/lib/workspaceAccessState'
import { useKnowledgeStore } from '../src/stores/knowledgeStore'
import { knowledgeApi } from '../src/api/knowledge'

const initial = useKnowledgeStore.getState()
const originalCreate = knowledgeApi.createPage
const originalDetail = knowledgeApi.getCourse
const course = { id: 'course', title: 'Test course', description: null, externalId: null, createdAt: '', updatedAt: '' }
const page = { id: 'page', title: 'Test page', contentMd: '', sectionTags: {}, sortOrder: 0, syncState: 'SYNCED' as const }

afterEach(() => {
  cleanup()
  useKnowledgeStore.setState(initial, true)
  knowledgeApi.createPage = originalCreate
  knowledgeApi.getCourse = originalDetail
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
  useKnowledgeStore.setState({ createPage: async () => { calls++; await pending } })
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
  let calls = 0
  useKnowledgeStore.setState({ createPage: async () => { if (++calls === 1) throw new Error('Create failed') } })
  await openCreate()
  fireEvent.click(screen.getByRole('button', { name: 'Create', exact: true }))
  await waitFor(() => assert.equal((screen.getByRole('button', { name: 'Create', exact: true }) as HTMLButtonElement).disabled, false))
  fireEvent.click(screen.getByRole('button', { name: 'Create', exact: true }))
  await waitFor(() => assert.ok(!screen.queryByRole('dialog')))
  assert.equal(calls, 2)
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
