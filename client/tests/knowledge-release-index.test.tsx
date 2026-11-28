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

test('requires revision notes and submits only those notes for the selected course', async () => {
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
  const notes = dialog.getByRole('textbox')
  const publish = dialog.getByRole<HTMLButtonElement>('button', { name: 'Publish' })
  fireEvent.change(notes, { target: { value: '   ' } })
  assert.equal(publish.disabled, true)
  fireEvent.change(notes, { target: { value: ' Reviewed ' } })
  await act(async () => fireEvent.click(publish))
  assert.deepEqual(calls, [['c1', 'Reviewed']])
})

test('shows the failed release index and refreshes its status after rebuilding', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  useKnowledgeStore.setState({ courses: [{ id: 'c1', title: 'Course 1', description: null, externalId: null, createdAt: '', updatedAt: '' }] })
  const release: ReleaseSummary = {
    id: 'r1', versionTag: 'Release 1', revisionNotes: '', createdAt: '2026-11-23T03:00:00Z',
    isActive: false, isEditing: true, isTestSelected: true, indexStatus: 'failed', indexChunkCount: 0, hasEditorSnapshot: true,
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
  assert.ok(history.getByRole('button', { name: 'Download files for Release 1' }))
  assert.equal(history.queryByRole('button', { name: 'Delete version Release 1' }), null)
  assert.equal(history.queryByRole('button', { name: 'Switch to this version' }), null)

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

const releaseForDownload: ReleaseSummary = {
  id: 'current', versionTag: 'V2', revisionNotes: 'Teaching entries updated', createdAt: '2026-11-27T08:00:00Z',
  isActive: true, isEditing: true, isTestSelected: true, hasEditorSnapshot: true,
}

async function openDownloadHistory(role: 'ADMIN' | 'COURSE_CREATOR') {
  useKnowledgeStore.setState({ courses: [{ id: 'c1', title: 'Course 1', description: null, externalId: null, createdAt: '', updatedAt: '' }] })
  knowledgeApi.listReleases = async () => [releaseForDownload, {
    ...releaseForDownload, id: 'old', versionTag: 'V1', isActive: false, isEditing: false, isTestSelected: false, hasEditorSnapshot: false,
  }]
  render(<MemoryRouter initialEntries={['/en-GB']}><Routes><Route path="/:locale" element={
    <ConfigProvider theme={{ token: { motion: false } }}><App>
      <WorkspaceAccessContext.Provider value={buildAccess(role, 'knowledge')}><PublishPanel /></WorkspaceAccessContext.Provider>
    </App></ConfigProvider>
  } /></Routes></MemoryRouter>)
  fireEvent.click(await screen.findByText('V2'))
  return within(await screen.findByRole('dialog', { name: 'Version history' }))
}

test('keeps preview controls outside the focusable page content', async (t) => {
  t.mock.method(knowledgeApi, 'getRelease', async (id: string) => {
    assert.equal(id, 'current')
    return {
      ...releaseForDownload,
      courseId: 'c1',
      snapshotData: { pages: [{ id: 'p1', title: 'Page 1', contentMd: '## Archived content', sectionTags: null }] },
    }
  })
  const history = await openDownloadHistory('ADMIN')
  fireEvent.click(history.getAllByRole('button', { name: 'Preview' })[0])
  const preview = within(await screen.findByRole('dialog', { name: 'Version preview' }))
  const content = await preview.findByRole('region', { name: 'Page 1' })
  assert.equal(content.tabIndex, 0)
  assert.ok(within(content).getByRole('heading', { name: 'Archived content' }))
  assert.equal(content.contains(preview.getByRole('combobox')), false)
  const back = preview.getByRole('button', { name: 'Back to version history' })
  assert.equal(content.contains(back), false)
  fireEvent.click(back)
  assert.ok(history.getByRole('button', { name: 'Download files for V2' }))
})

test('offers only reading documents and a migration ZIP, then retries only the failed file', async (t) => {
  const requests: string[] = []
  const saved: string[] = []
  let failPackage = true
  t.mock.method(knowledgeApi, 'exportRelease', async (id: string, kind: string) => {
    requests.push(`${id}/${kind}`)
    if (kind === 'package' && failPackage) throw new Error('Download failed')
    return { blob: new Blob(['zip']), filename: kind === 'package' ? 'V2.lgknowledge.zip' : 'V2.zip' }
  })
  t.mock.method(URL, 'createObjectURL', () => 'blob:release-transfer-test')
  t.mock.method(HTMLAnchorElement.prototype, 'click', function (this: HTMLAnchorElement) { saved.push(this.download) })

  const history = await openDownloadHistory('ADMIN')
  assert.equal(history.getAllByRole('button', { name: 'Download files for V2' }).length, 1)
  assert.ok(history.getByRole('button', { name: 'Delete version V1' }))
  fireEvent.click(history.getByRole('button', { name: 'Download files for V2' }))
  const dialog = within(await screen.findByRole('dialog', { name: 'Download version files' }))
  const items = dialog.getAllByRole<HTMLInputElement>('checkbox')
  assert.equal(items.length, 2)
  assert.match(items[0].parentElement?.textContent ?? '', /Reading documents.*\.zip/)
  assert.match(items[1].parentElement?.textContent ?? '', /Download migration ZIP.*\.lgknowledge\.zip/)
  assert.equal(dialog.getByRole<HTMLButtonElement>('button', { name: 'Next' }).disabled, true)
  fireEvent.click(dialog.getByRole('button', { name: 'Select all' }))
  assert.ok(items.every(item => item.checked))
  fireEvent.click(dialog.getByRole('button', { name: 'Next' }))
  fireEvent.click(dialog.getByRole('button', { name: 'Back' }))
  assert.ok(dialog.getAllByRole<HTMLInputElement>('checkbox').every(item => item.checked))
  fireEvent.click(dialog.getByRole('button', { name: 'Next' }))
  assert.deepEqual(requests, [])
  await act(async () => fireEvent.click(dialog.getByRole('button', { name: 'Download files (2)' })))
  assert.deepEqual(requests, ['current/export', 'current/package'])
  assert.deepEqual(saved, ['V2.zip'])
  assert.ok(dialog.getByRole('alert'))
  failPackage = false
  await act(async () => fireEvent.click(dialog.getByRole('button', { name: 'Download remaining files (1)' })))
  assert.deepEqual(requests, ['current/export', 'current/package', 'current/package'])
  assert.deepEqual(saved, ['V2.zip', 'V2.lgknowledge.zip'])
  assert.equal(dialog.queryByRole('alert'), null)
})

test('allows view-only users to select just the reading archive for a legacy version', async () => {
  const history = await openDownloadHistory('COURSE_CREATOR')
  assert.equal(history.queryByLabelText('Upload version package'), null)
  assert.equal(history.queryByRole('button', { name: 'Switch to this version' }), null)
  assert.equal(history.queryByRole('button', { name: 'Delete version V1' }), null)
  fireEvent.click(history.getByRole('button', { name: 'Download files for V1' }))
  const dialog = within(await screen.findByRole('dialog', { name: 'Download version files' }))
  fireEvent.click(dialog.getByRole('button', { name: 'Select all' }))
  assert.deepEqual(dialog.getAllByRole<HTMLInputElement>('checkbox').map(item => [item.checked, item.disabled]), [
    [true, false], [false, true],
  ])
  fireEvent.click(dialog.getByRole('button', { name: 'Next' }))
  assert.ok(dialog.getByRole('button', { name: 'Download files (1)' }))
  assert.ok(dialog.getByText('Reading documents'))
  assert.equal(dialog.queryByText('Download migration ZIP'), null)
})
