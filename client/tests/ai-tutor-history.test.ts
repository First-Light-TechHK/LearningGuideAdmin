import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { useAiStore } from '../src/stores/aiStore'

const initialState = useAiStore.getState()
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  useAiStore.setState(initialState, true)
  localStorage.clear()
})

test('Socratic sends ten complete turns; Lecture keeps five', async () => {
  const sent: Array<{ mode: string; history: Array<{ content: string }> }> = []
  globalThis.fetch = async (_input, init) => {
    sent.push(JSON.parse(String(init?.body)) as (typeof sent)[number])
    return new Response('data: {"done":true}\n\n', { status: 200 })
  }
  const messages = Array.from({ length: 12 }, (_, index) => [
    { role: 'user' as const, content: `q${index + 1}`, createdAt: '1' },
    { role: 'ai' as const, content: `a${index + 1}`, createdAt: '1' },
  ]).flat()

  useAiStore.setState({ selectedCourseId: 'c1', mode: 'SOCRATIC', messages })
  await useAiStore.getState().send('summary')
  assert.equal(sent[0]?.history.length, 20)
  assert.equal(sent[0]?.history[0]?.content, 'q3')

  useAiStore.setState({ selectedCourseId: 'c1', mode: 'LECTURE', messages })
  await useAiStore.getState().send('summary')
  assert.equal(sent[1]?.history.length, 10)
  assert.equal(sent[1]?.history[0]?.content, 'q8')
})
