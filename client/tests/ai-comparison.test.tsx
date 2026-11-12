import './support/dom'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { App } from 'antd'
import { TutorComparison } from '../src/components/ai/TutorComparison'
import { http } from '../src/api/client'

const post = http.post, originalFetch = globalThis.fetch
afterEach(() => { cleanup(); http.post = post; globalThis.fetch = originalFetch })

test('two tutors receive the same question concurrently and retain isolated follow-up histories', async () => {
  let sessions = 0
  const configs: Array<{runningSolution: string; locale?: string}> = []
  http.post = (async (_url: string, config: (typeof configs)[number]) => { configs.push(config); return {data:{id:String(++sessions)}} }) as unknown as typeof http.post
  const calls: Array<{url: string; body: {message: string; history: Array<{content: string}>}}> = []
  const pending: Array<() => void> = []
  globalThis.fetch = async (url, init) => {
    const path = String(url), answer = path.includes('/1/') ? 'answer-A' : 'answer-B'
    calls.push({url:path,body:JSON.parse(String(init?.body))})
    if (calls.length <= 2) await new Promise<void>((resolve) => pending.push(resolve))
    return new Response(`data: ${JSON.stringify({delta:answer})}\n\ndata: {"done":true}\n\n`)
  }
  render(<App><MemoryRouter><TutorComparison initial={{courseId:'c1',releaseId:'r1',model:'gemini',runningSolution:'grounded-jack',modes:['LECTURE'],kind:'multi'}} models={['gemini']} releases={[{id:'r1',versionTag:'v1'}]} en={false} /></MemoryRouter></App>)
  fireEvent.click(screen.getByRole('button',{name:'添加对比'}))
  assert.equal((screen.getByRole('button',{name:'添加对比'}) as HTMLButtonElement).disabled,true)
  fireEvent.change(screen.getByRole('textbox',{name:'共同问题'}),{target:{value:'question-1'}})
  fireEvent.click(screen.getByRole('button',{name:/发\s*送/}))
  await waitFor(() => assert.equal(pending.length,2))
  assert.deepEqual(calls.map((c) => c.body.message),['question-1','question-1'])
  assert.equal(configs[0].runningSolution,'grounded-jack')
  assert.equal(configs[1].runningSolution,'dialogue-yong')
  assert.equal(configs[0].locale,undefined)
  pending.forEach((finish) => finish())
  await waitFor(() => assert.equal((screen.getByRole('button',{name:'新测试'}) as HTMLButtonElement).disabled,false))
  fireEvent.change(screen.getByRole('textbox',{name:'共同问题'}),{target:{value:'follow-up'}})
  fireEvent.click(screen.getByRole('button',{name:/发\s*送/}))
  await waitFor(() => assert.equal(calls.length,4))
  assert.deepEqual(calls[2].body.history.map((m) => m.content),['question-1','answer-A'])
  assert.deepEqual(calls[3].body.history.map((m) => m.content),['question-1','answer-B'])
})
