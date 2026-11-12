import './support/dom'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { App } from 'antd'
import { EvaluationPanel } from '../src/components/ai/EvaluationPanel'
import { useAiStore } from '../src/stores/aiStore'
import { http } from '../src/api/client'
import type { AiConfigView } from '../src/api/ai'

const initial = useAiStore.getState(), originalGet = http.get
afterEach(() => { cleanup(); useAiStore.setState(initial, true); http.get = originalGet })

for (const locale of ['zh-CN', 'en-GB']) {
  test(`evaluation has bilingual templates and keeps the normal chat untouched (${locale})`, async () => {
    const messages = [{ role: 'user' as const, content: 'keep chat', createdAt: 'now' }]
    useAiStore.setState({ ownerId: 'e1', selectedCourseId: 'c1', config: { releaseId: 'r1', model: 'm1' } as AiConfigView, models: ['m1'], releases: [{ id: 'r1', versionTag: 'v1' } as never], messages })
    http.get = (async () => ({ data: [] })) as unknown as typeof http.get
    render(<App><MemoryRouter initialEntries={[`/${locale}`]}><Routes><Route path="/:locale" element={<EvaluationPanel open close={() => undefined} />} /></Routes></MemoryRouter></App>)
    fireEvent.click(await screen.findByRole('tab', { name: locale === 'zh-CN' ? 'Excel 批量测试' : 'Excel batch test' }))
    const blank = screen.getByRole('link', { name: locale === 'zh-CN' ? '下载讲授示例' : 'Download Lecture example' })
    assert.ok(blank.getAttribute('href')?.includes('mode=LECTURE'))
    assert.equal(screen.queryByRole('link', { name: /空白|blank/i }), null)
    assert.equal(screen.queryByRole('combobox', { name: /回答语言|Answer language/ }), null)
    assert.equal((screen.getByRole('button', { name: locale === 'zh-CN' ? '开始测试' : 'Start test' }) as HTMLButtonElement).disabled, true)
    assert.equal(useAiStore.getState().messages, messages)
    assert.equal(screen.queryByText(locale === 'zh-CN' ? '使用知识库' : 'Use knowledge'), null)
  })
}
