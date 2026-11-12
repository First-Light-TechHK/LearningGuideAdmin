import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { App } from 'antd'
import { DialogueTestingPanel } from '../src/components/ai/DialogueTestingPanel'
import { useAiStore } from '../src/stores/aiStore'
import type { AiConfigView } from '../src/api/ai'
import { ShellRoute } from '../src/backoffice/ShellRoute'
import { employee, installFakeServer } from './support/helpdesk-fake'

const initialState = useAiStore.getState()
let server: ReturnType<typeof installFakeServer>

afterEach(() => {
  cleanup()
  server?.restore()
  useAiStore.setState(initialState, true)
  localStorage.clear()
})

test('测试路线按员工课程隔离保存，添加路线不写正式 AI 配置', async () => {
  server = installFakeServer()
  server.on('GET', '/api/session', { data: { employee: employee('ADMIN') } })
  useAiStore.setState({
    ownerId: 'employee-1', selectedCourseId: 'course-1',
    config: { model: 'openai/model-a', releaseId: 'release-1' } as AiConfigView,
    models: ['openai/model-a', 'openai/model-b'],
    releases: [{ id: 'release-1', versionTag: 'v1' } as never],
  })
  render(<App><MemoryRouter initialEntries={['/zh-CN/ai-tutor']}><Routes>
    <Route path="/:locale" element={<ShellRoute />}>
      <Route path="ai-tutor" element={<DialogueTestingPanel />} />
    </Route>
  </Routes></MemoryRouter></App>)
  fireEvent.click(await screen.findByRole('button', { name: '添加路线' }))
  const key = 'aitutor.dialogue-testing.v1.["employee-1","course-1"]'
  await waitFor(() => assert.equal(JSON.parse(localStorage.getItem(key) ?? '{}').routes?.length, 1))
  assert.equal(JSON.parse(localStorage.getItem(key)!).routes[0].releaseId, 'release-1')
  assert.equal(server.callsTo('PUT', /\/api\/ai\/config/).length, 0)
})
