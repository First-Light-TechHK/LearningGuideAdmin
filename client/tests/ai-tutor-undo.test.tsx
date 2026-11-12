import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App } from 'antd'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ChatWindow } from '../src/components/ai/ChatWindow'
import type { AiConfigView } from '../src/api/ai'
import { useAiStore } from '../src/stores/aiStore'
import { ShellRoute } from '../src/backoffice/ShellRoute'
import { WorkspaceAccessProvider } from '../src/backoffice/lib/workspaceAccess'
import { employee, installFakeServer } from './support/helpdesk-fake'

const initialState = useAiStore.getState()
const original = '  **问题**\n第二行  '
let server: ReturnType<typeof installFakeServer>

afterEach(() => {
  cleanup()
  server?.restore()
  useAiStore.setState(initialState, true)
  localStorage.clear()
})

async function openChat(userContent = original) {
  server = installFakeServer()
  server.on('GET', '/api/session', { data: { employee: employee('ADMIN') } })
  useAiStore.setState({
    ownerId: 'employee-1', config: { releaseId: 'r1' } as AiConfigView, selectedCourseId: 'undo-course',
    messages: [
      { role: 'ai', content: 'Welcome', createdAt: '1' },
      { role: 'user', content: userContent, createdAt: '2' },
      { role: 'ai', content: 'Answer', createdAt: '3' },
    ],
  })
  render(
    <App>
      <MemoryRouter initialEntries={['/en-GB/ai-tutor']}>
        <Routes>
          <Route path="/:locale" element={<ShellRoute />}>
            <Route path="ai-tutor" element={<WorkspaceAccessProvider menu="aiTutor"><ChatWindow /></WorkspaceAccessProvider>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </App>,
  )
  return await screen.findByRole('textbox') as HTMLTextAreaElement
}

test('确认撤回后原文回填且可编辑，最后一轮从历史和持久化中移除', async () => {
  const input = await openChat()
  fireEvent.change(input, { target: { value: 'draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'undo' }))
  const dialog = await screen.findByRole('dialog')
  assert.equal(input.value, 'draft')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Undo' }))
  await waitFor(() => assert.equal(input.value, original))
  assert.deepEqual(useAiStore.getState().messages.map((m) => m.content), ['Welcome'])
  assert.deepEqual(JSON.parse(localStorage.getItem('aitutor.chat.v4.["employee-1","undo-course","r1"]')!).map((m: { content: string }) => m.content), ['Welcome'])
  fireEvent.change(input, { target: { value: 'edited question' } })
  assert.equal(input.value, 'edited question')
})

test('取消撤回保留输入草稿和对话', async () => {
  const input = await openChat()
  fireEvent.change(input, { target: { value: 'draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'undo' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  assert.equal(input.value, 'draft')
  assert.equal(useAiStore.getState().messages.length, 3)
})

test('用户消息保留原有 Markdown 展示，不抽取回答来源', async () => {
  await openChat('Question [Source: private note]')
  const bubble = document.querySelector('.chat-bubble-user')
  assert.match(bubble?.textContent ?? '', /Question \[Source: private note\]/)
  assert.ok(bubble?.querySelector('.wmde-markdown'))
  assert.equal(bubble?.querySelector('.tutor-answer'), null)
})
