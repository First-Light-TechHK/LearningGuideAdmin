import './support/dom'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { aiApi, chatStream, type AiConfigView } from '../src/api/ai'
import { knowledgeApi } from '../src/api/knowledge'
import { useAiStore } from '../src/stores/aiStore'

const initial = useAiStore.getState()
const originalFetch = globalThis.fetch
const originalAi = { ...aiApi }, originalKnowledge = { ...knowledgeApi }
const config = (releaseId: string) => ({ releaseId, welcomeMsg: 'Welcome', main: {}, lecture: {}, socratic: {}, assessment: {} }) as AiConfigView
const encoder = new TextEncoder()
const response = (parts: string[]) => new Response(new ReadableStream({ start(c) {
  for (const part of parts) c.enqueue(encoder.encode(part))
  c.close()
} }))
const success = () => response(['data: {"delta":"ok"}\n\n', 'data: {"done":true}\n\n'])

afterEach(() => {
  useAiStore.getState().cancel()
  useAiStore.setState(initial, true)
  globalThis.fetch = originalFetch
  Object.assign(aiApi, originalAi)
  Object.assign(knowledgeApi, originalKnowledge)
  localStorage.clear()
})

test('SSE 跨 chunk、CRLF 和 EOF 末帧均保持增量与结束语义', async () => {
  globalThis.fetch = async () => response(['data: {"del', 'ta":"中文"}\r\n\r', '\ndata: {"done":true}'])
  const events: unknown[] = []
  await chatStream({ courseId: 'c1', message: 'q', mode: 'LECTURE', history: [] }, (e) => events.push(e))
  assert.deepEqual(events, [{ delta: '中文' }, { done: true }])
})

test('SSE 缺结束帧、错误帧或畸形 JSON 都拒绝成功', async () => {
  for (const parts of [
    ['data: {"delta":"partial"}\n\n'],
    ['data: {"error":"failed"}\n\n'],
    ['data: {broken}\n\n'],
  ]) {
    globalThis.fetch = async () => response(parts)
    await assert.rejects(chatStream({ courseId: 'c1', message: 'q', mode: 'LECTURE', history: [] }, () => {}))
  }
})

test('失败片段保留显示，下一轮只携带完整成功历史和屏幕 Release', async () => {
  useAiStore.setState({ ownerId: 'e1', selectedCourseId: 'c1', config: config('r1') })
  globalThis.fetch = async () => response(['data: {"delta":"partial"}\n\n', 'data: {"error":"upstream failed"}\n\n'])
  await useAiStore.getState().send('failed question')
  assert.equal(useAiStore.getState().messages.at(-1)?.status, 'error')
  assert.equal(useAiStore.getState().messages.at(-1)?.content, 'partial')
  let sent: { history: unknown[]; expectedReleaseId: string } | undefined
  globalThis.fetch = async (_url, init) => { sent = JSON.parse(String(init?.body)); return success() }
  await useAiStore.getState().send('new question')
  assert.deepEqual(sent?.history, [])
  assert.equal(sent?.expectedReleaseId, 'r1')
  assert.equal(useAiStore.getState().messages.at(-1)?.status, 'complete')
})

test('取消正在生成的回答保留片段，关闭读取且状态为 aborted', async () => {
  useAiStore.setState({ ownerId: 'e1', selectedCourseId: 'c1', config: config('r1') })
  let cancelled = false
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(c) { c.enqueue(encoder.encode('data: {"delta":"partial"}\n\n')) },
    cancel() { cancelled = true },
  }))
  let ready!: () => void
  const first = new Promise<void>((resolve) => { ready = resolve })
  const unsubscribe = useAiStore.subscribe((state) => { if (state.messages.at(-1)?.content === 'partial') ready() })
  const running = useAiStore.getState().send('q')
  await first
  useAiStore.getState().cancel()
  await running
  unsubscribe()
  assert.equal(cancelled, true)
  assert.equal(useAiStore.getState().messages.at(-1)?.status, 'aborted')
  assert.equal(useAiStore.getState().streaming, false)
})

test('Release 与账号切换隔离历史，旧无归属历史不迁入', async () => {
  useAiStore.setState({ ownerId: 'e1', selectedCourseId: 'c1', config: config('r1') })
  globalThis.fetch = async () => success()
  await useAiStore.getState().send('r1 question')
  aiApi.setActiveRelease = async (_courseId, releaseId) => config(releaseId)
  await useAiStore.getState().selectRelease('r2')
  assert.deepEqual(useAiStore.getState().messages.map((m) => m.content), ['Welcome'])
  await useAiStore.getState().selectRelease('r1')
  assert.equal(useAiStore.getState().messages[0]?.content, 'r1 question')
  localStorage.setItem('aitutor.chat.c1', JSON.stringify([{ role: 'user', content: 'legacy' }]))
  knowledgeApi.listCourses = async () => [{ id: 'c1' }] as Awaited<ReturnType<typeof knowledgeApi.listCourses>>
  knowledgeApi.listReleases = async () => []
  aiApi.listModels = async () => []
  aiApi.listPrompts = async () => []
  aiApi.getConfig = async () => config('r1')
  await useAiStore.getState().init('e2')
  assert.deepEqual(useAiStore.getState().messages.map((m) => m.content), ['Welcome'])
})

test('旧账号的延迟请求不能覆盖新账号的消息或 streaming 状态', async () => {
  useAiStore.setState({ ownerId: 'e1', selectedCourseId: 'c1', config: config('r1') })
  let resolveFetch!: (response: Response) => void
  globalThis.fetch = () => new Promise<Response>((resolve) => { resolveFetch = resolve })
  const oldRun = useAiStore.getState().send('old question')
  useAiStore.getState().cancel()
  const nextController = new AbortController()
  useAiStore.setState({ ownerId: 'e2', controller: nextController, streaming: true,
    messages: [{ role: 'user', content: 'new question', createdAt: 'now' }] })
  resolveFetch(success())
  await oldRun
  assert.equal(useAiStore.getState().messages[0]?.content, 'new question')
  assert.equal(useAiStore.getState().controller, nextController)
  assert.equal(useAiStore.getState().streaming, true)
  assert.equal(localStorage.length, 0)
})

test('快速选择 Release 时，旧响应不能覆盖后一次选择', async () => {
  useAiStore.setState({ ownerId: 'e1', selectedCourseId: 'c1', config: config('r1') })
  let resolveOld!: (config: AiConfigView) => void
  aiApi.setActiveRelease = (_courseId, releaseId) => releaseId === 'r2'
    ? new Promise((resolve) => { resolveOld = resolve }) : Promise.resolve(config(releaseId))
  const old = useAiStore.getState().selectRelease('r2')
  await useAiStore.getState().selectRelease('r3')
  resolveOld(config('r2'))
  await old
  assert.equal(useAiStore.getState().config?.releaseId, 'r3')
})

 test('saving either running solution preserves messages and reload history', async () => {
  const messages = [{ role: 'user' as const, content: 'keep', createdAt: 'now' }]
  useAiStore.setState({ ownerId: 'e1', selectedCourseId: 'c1', config: { ...config('r1'), runningSolution: 'grounded-jack' }, messages })
  aiApi.saveConfig = async (payload) => ({ ...config('r1'), runningSolution: payload.runningSolution })
  for (const runningSolution of ['dialogue-yong', 'grounded-jack'] as const) {
    useAiStore.getState().patchForm({ runningSolution })
    assert.equal(await useAiStore.getState().save(), true)
    assert.equal(useAiStore.getState().messages, messages)
  }
  assert.deepEqual(JSON.parse(localStorage.getItem('aitutor.chat.v4.["e1","c1","r1"]')!), messages)
  aiApi.getConfig = async () => ({ ...config('r1'), runningSolution: 'dialogue-yong' })
  knowledgeApi.listReleases = async () => []
  await useAiStore.getState().refreshActiveCourse()
  assert.equal(useAiStore.getState().messages, messages)
})
