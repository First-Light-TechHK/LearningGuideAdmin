import './support/dom'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import { knowledgeApi, type ReleaseSummary } from '../src/api/knowledge'
import { buildAccess, WorkspaceAccessContext } from '../src/backoffice/lib/workspaceAccessState'
import { PublishPanel } from '../src/components/knowledge/PublishPanel'
import { App } from '../src/components/ui'
import { useKnowledgeStore } from '../src/stores/knowledgeStore'

const initial = useKnowledgeStore.getState()
const originalList = knowledgeApi.listReleases
const originalRebuild = knowledgeApi.rebuildReleaseIndex
const originalPublish = knowledgeApi.publish
const originalPackageImport = knowledgeApi.importReleasePackage

afterEach(() => {
  cleanup()
  useKnowledgeStore.setState(initial, true)
  knowledgeApi.listReleases = originalList
  knowledgeApi.rebuildReleaseIndex = originalRebuild
  knowledgeApi.publish = originalPublish
  knowledgeApi.importReleasePackage = originalPackageImport
})

test('previews the selected package before importing into an unpublished course', async () => {
  useKnowledgeStore.setState({ courses: [{ id:'target',title:'Target',description:null,externalId:null,createdAt:'',updatedAt:'' }] })
  knowledgeApi.listReleases = async () => []
  const file = new File(['zip'], 'v1.lgknowledge.zip')
  const actions: string[] = []
  knowledgeApi.importReleasePackage = async (id, selected, action) => {
    assert.equal(id,'target')
    assert.equal(selected,file)
    actions.push(action)
    return {id:action==='apply'?'v1':null,versionTag:'V1',sourceCourse:'A',pages:1,cards:4,images:1,duplicate:false,conflicts:['F1'],types:[{type:'concept',count:4}]}
  }
  render(<MemoryRouter initialEntries={['/en-GB']}><Routes><Route path="/:locale" element={
    <ConfigProvider theme={{ token: { motion: false } }}><App>
      <WorkspaceAccessContext.Provider value={buildAccess('ADMIN', 'knowledge')}><PublishPanel /></WorkspaceAccessContext.Provider>
    </App></ConfigProvider>
  } /></Routes></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button',{name:'Version history'}))
  const dialog=within(await screen.findByRole('dialog'))
  await act(async()=> fireEvent.change(dialog.getByLabelText('Upload version package'),{target:{files:[file]}}))
  assert.deepEqual(actions,['preview'])
  assert.ok(dialog.getByText(/4 teaching entries/))
  assert.ok(dialog.getByText(/F1/))
  await act(async()=>fireEvent.click(dialog.getByRole('button',{name:'Add this version'})))
  assert.deepEqual(actions,['preview','apply'])
})

test('submits the reviewed teaching package with the selected course release', async () => {
  useKnowledgeStore.setState({ courses: [{ id: 'c1', title: 'Course 1', description: null, externalId: null, createdAt: '', updatedAt: '' }] })
  knowledgeApi.listReleases = async () => []
  const calls: Parameters<typeof knowledgeApi.publish>[] = []
  knowledgeApi.publish = async (...args) => {
    calls.push(args)
    return {} as Awaited<ReturnType<typeof knowledgeApi.publish>>
  }
  render(<MemoryRouter initialEntries={['/en-GB']}><Routes><Route path="/:locale" element={
    <ConfigProvider theme={{ token: { motion: false } }}><App>
      <WorkspaceAccessContext.Provider value={buildAccess('ADMIN', 'knowledge')}>
        <PublishPanel />
      </WorkspaceAccessContext.Provider>
    </App></ConfigProvider>
  } /></Routes></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: 'Create Release' }))
  const dialog = within(await screen.findByRole('dialog'))
  fireEvent.change(dialog.getByPlaceholderText('Revision Notes (required)'), { target: { value: 'Reviewed' } })
  fireEvent.change(dialog.getByRole('textbox', { name: 'Reviewed teaching package JSON' }), { target: { value: '{"cards":[],"glossary":[]}' } })
  await act(async () => fireEvent.click(dialog.getByRole('button', { name: 'Publish' })))
  assert.deepEqual(calls, [['c1', 'Reviewed', { cards: [], glossary: [] }]])
})

test('shows the failed release index and refreshes its status after rebuilding', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  useKnowledgeStore.setState({ courses: [{ id: 'c1', title: 'Course 1', description: null, externalId: null, createdAt: '', updatedAt: '' }] })
  const release: ReleaseSummary = {
    id: 'r1', versionTag: 'Release 1', revisionNotes: '', createdAt: '2026-11-23T03:00:00Z',
    isActive: false, isEditing: true, isTestSelected: true, indexStatus: 'failed', indexChunkCount: 0,
  }
  let lists = 0
  knowledgeApi.listReleases = async () => {
    lists++
    return [release]
  }
  const rebuilt: string[] = []
  knowledgeApi.rebuildReleaseIndex = async (id) => {
    rebuilt.push(id)
    return { id }
  }

  render(<MemoryRouter initialEntries={['/en-GB']}><Routes><Route path="/:locale" element={
    <ConfigProvider theme={{ token: { motion: false } }}><App>
      <WorkspaceAccessContext.Provider value={buildAccess('ADMIN', 'knowledge')}>
        <PublishPanel />
      </WorkspaceAccessContext.Provider>
    </App></ConfigProvider>
  } /></Routes></MemoryRouter>)
  assert.ok(await screen.findByText('Index build failed'))
  fireEvent.click(screen.getByText('Release 1'))
  const history = within(await screen.findByRole('dialog'))
  assert.ok(history.getByText('Index build failed'))

  await act(async () => fireEvent.click(history.getByRole('button', { name: 'Rebuild index' })))
  assert.deepEqual(rebuilt, ['r1'])
  assert.ok(history.getByText('Building index'))
  release.indexStatus = 'ready'
  release.indexChunkCount = 42
  await act(async () => t.mock.timers.tick(3000))
  assert.ok(history.getByText('Index ready (42 chunks)'))
  await act(async () => t.mock.timers.tick(3000))
  assert.equal(lists, 2)
})
