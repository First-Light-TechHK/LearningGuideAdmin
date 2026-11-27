import './support/dom'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ConfigProvider } from 'antd'
import { MemoryRouter } from 'react-router-dom'
import { knowledgeApi } from '../src/api/knowledge'
import { buildAccess, WorkspaceAccessContext } from '../src/backoffice/lib/workspaceAccessState'
import { CourseTree } from '../src/components/knowledge/CourseTree'
import { App } from '../src/components/ui'
import { localDraftKey, useKnowledgeStore } from '../src/stores/knowledgeStore'

const initial = useKnowledgeStore.getState()
const originalClear = knowledgeApi.clearCoursePages
const originalDetail = knowledgeApi.getCourse
const course = { id: 'course', title: 'Test course', description: null, externalId: null, createdAt: '', updatedAt: '' }
const page = { id: 'page', title: 'Markdown page', contentMd: 'body', sectionTags: {}, sortOrder: 0, syncState: 'SYNCED' as const }
const emptyPage = { ...page, id: 'empty', title: 'Empty lesson', contentMd: '', sortOrder: 1 }

afterEach(() => {
  cleanup()
  useKnowledgeStore.setState(initial, true)
  knowledgeApi.clearCoursePages = originalClear
  knowledgeApi.getCourse = originalDetail
  for (const id of [page.id, emptyPage.id, 'other-page']) localStorage.removeItem(localDraftKey(id))
})

async function openCourseMenu(pages = [page, emptyPage], keyword = '') {
  useKnowledgeStore.setState({ courses: [course], details: { course: { ...course, pages } } })
  const view = render(
    <MemoryRouter>
      <ConfigProvider theme={{ token: { motion: false } }}>
        <App>
          <WorkspaceAccessContext.Provider value={buildAccess('ADMIN', 'knowledge')}>
            <CourseTree keyword={keyword} />
          </WorkspaceAccessContext.Provider>
        </App>
      </ConfigProvider>
    </MemoryRouter>,
  )
  fireEvent.click(view.container.querySelector('.anticon-more')!)
  return screen.findByRole('menuitem', { name: 'Clear files' })
}

for (const step of [1, 2]) {
  test(`cancelling confirmation ${step} never clears the course`, async () => {
    let calls = 0
    knowledgeApi.clearCoursePages = async () => { calls++; return { deletedPageIds: [] } }
    fireEvent.click(await openCourseMenu())
    let dialog = within(await screen.findByRole('dialog', { name: /clear files in/i }))
    if (step === 2) {
      fireEvent.click(dialog.getByRole('button', { name: 'Continue' }))
      dialog = within(await screen.findByRole('dialog', { name: /confirm clearing/i }))
    }
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => assert.equal(screen.queryByRole('dialog'), null))
    assert.equal(calls, 0)
  })
}

test('clears every draft page once after both confirmations, even under a search filter', async () => {
  const clear = await openCourseMenu([page, emptyPage], 'Markdown page')
  act(() => {
    useKnowledgeStore.setState({
      selectedCourseId: course.id,
      selectedPageId: page.id,
      draft: { pageId: page.id, title: page.title, contentMd: page.contentMd, sectionTags: {}, saveState: 'dirty' },
      lastPageIdByCourse: { course: page.id, other: 'other-page' },
    })
  })
  for (const id of [page.id, emptyPage.id, 'other-page']) localStorage.setItem(localDraftKey(id), 'draft')
  const calls: [string, string[]][] = []
  let resolveDelete!: (result: { deletedPageIds: string[] }) => void
  const pending = new Promise<{ deletedPageIds: string[] }>((resolve) => { resolveDelete = resolve })
  knowledgeApi.clearCoursePages = async (id, expected) => {
    calls.push([id, expected])
    return pending
  }
  knowledgeApi.getCourse = async () => { throw new Error('Refresh failed') }

  fireEvent.click(clear)
  const first = within(await screen.findByRole('dialog', { name: /clear files in.*Test course/i }))
  assert.ok(first.getByText(/all 2 draft pages/i))
  fireEvent.click(first.getByRole('button', { name: 'Continue' }))
  const final = within(await screen.findByRole('dialog', { name: /confirm clearing.*Test course/i }))
  assert.deepEqual(calls, [])
  const button = final.getByRole('button', { name: 'Clear files' })
  act(() => {
    fireEvent.click(button)
    fireEvent.click(button)
  })
  await waitFor(() => assert.deepEqual(calls, [[course.id, [page.id, emptyPage.id]]]))
  await act(async () => resolveDelete({ deletedPageIds: [page.id, emptyPage.id] }))

  const state = useKnowledgeStore.getState()
  assert.deepEqual(state.details.course.pages, [])
  assert.equal(state.selectedCourseId, course.id)
  assert.equal(state.selectedPageId, null)
  assert.equal(state.draft, null)
  assert.deepEqual(state.lastPageIdByCourse, { other: 'other-page' })
  assert.equal(localStorage.getItem(localDraftKey(page.id)), null)
  assert.equal(localStorage.getItem(localDraftKey(emptyPage.id)), null)
  assert.equal(localStorage.getItem(localDraftKey('other-page')), 'draft')
})

test('disables clearing an empty course', async () => {
  const clear = await openCourseMenu([])
  assert.equal(clear.getAttribute('aria-disabled'), 'true')
  fireEvent.click(clear)
  assert.equal(screen.queryByRole('dialog'), null)
})

test('refreshes the course on a conflict and keeps the local draft', async () => {
  useKnowledgeStore.setState({ details: { course: { ...course, pages: [page] } } })
  localStorage.setItem(localDraftKey(page.id), 'draft')
  knowledgeApi.clearCoursePages = async () => {
    throw Object.assign(new Error('Course pages have changed'), { code: 'CONFLICT' })
  }
  knowledgeApi.getCourse = async () => ({ ...course, pages: [page, emptyPage] })

  await assert.rejects(useKnowledgeStore.getState().clearCoursePages(course.id, [page.id]), /Course pages have changed/)
  assert.deepEqual(useKnowledgeStore.getState().details.course.pages, [page, emptyPage])
  assert.equal(localStorage.getItem(localDraftKey(page.id)), 'draft')
})
