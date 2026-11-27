import './support/dom'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { toggleWrap } from '../src/components/knowledge/markdownCommands'
import { MarkdownSourceEditor } from '../src/components/knowledge/MarkdownSourceEditor'
import { MarkdownToolbar } from '../src/components/knowledge/MarkdownToolbar'
import { KnowledgeMarkdown } from '../src/components/knowledge/KnowledgeMarkdown'

const originalRects = Range.prototype.getClientRects
beforeEach(() => { Range.prototype.getClientRects = () => [] as unknown as DOMRectList })
afterEach(() => {
  cleanup()
  Range.prototype.getClientRects = originalRects
})

for (const marker of ['**', '*', '~~', '`', '$']) {
  test(`empty ${marker} formatting cancels on the second click and preserves surrounding text`, () => {
    const editor = {
      state: EditorState.create({ doc: '前文 后文', selection: { anchor: 3 }, extensions: [markdown({ base: markdownLanguage })] }),
      dispatch(...specs: Parameters<EditorState['update']>) { this.state = this.state.update(...specs).state },
      focus() {},
    }
    for (let i = 0; i < 5; i++) {
      toggleWrap(editor as unknown as EditorView, marker)
      assert.equal(editor.state.doc.toString(), `前文 ${marker}${marker}后文`)
      toggleWrap(editor as unknown as EditorView, marker)
      assert.equal(editor.state.doc.toString(), '前文 后文')
      assert.equal(editor.state.selection.main.head, 3)
    }
  })
}

test('the formatting toolbar has no image insert button', () => {
  const editor = { dom: document.createElement('div'), state: EditorState.create() } as EditorView
  render(<MemoryRouter><MarkdownToolbar view={editor} /></MemoryRouter>)
  assert.ok(!screen.queryByRole('button', { name: 'Image' }))
})

test('the Markdown toolbar exposes course references next to its existing commands', () => {
  let opened = false
  const editor = { dom: document.createElement('div'), state: EditorState.create() } as EditorView
  render(<MemoryRouter><MarkdownToolbar view={editor} onCourseReference={() => { opened = true }} /></MemoryRouter>)
  fireEvent.click(screen.getByRole('button', { name: 'Course reference' }))
  assert.ok(opened)
})

const image = '/api/files/images/course/diagram.png'
const html = `<div class="joplin-table-wrapper"><table><tr><td><p>阅读时间</p><ol><li>虎先锋<img src="${image}"></li></ol></td><td rowspan="2">第21回</td></tr></table></div>`

test('document preview renders rich HTML tables and embedded images while filtering unsafe HTML', () => {
  const { container } = render(<KnowledgeMarkdown source={`# 标题\n\n${html}\n\n![图](${image})\n\n<script>alert(1)</script><img src="javascript:alert(1)" onerror="alert(1)"><a href=" java&#x09;script:alert(1)">unsafe</a>`} />)
  assert.equal(container.querySelector('h1')?.textContent, '标题')
  assert.equal(container.querySelectorAll('img').length, 2)
  assert.equal(container.querySelector('td[rowspan]')?.getAttribute('rowspan'), '2')
  assert.equal(container.querySelector('script, [onerror]'), null)
  const unsafeLink = [...container.querySelectorAll('a')].find((link) => link.textContent === 'unsafe')
  assert.equal(unsafeLink?.getAttribute('href'), '')
  assert.equal(container.textContent?.includes('joplin-table-wrapper'), false)
})

test('legacy DOCX raster data images remain visible in preview', () => {
  const src = 'data:image/png;base64,iVBORw0KGgo='
  const { container } = render(<KnowledgeMarkdown source={`![图](${src})\n\n<img src="${src}">`} />)
  assert.equal(container.querySelectorAll(`img[src="${src}"]`).length, 2)
})

test('course reference preview resolves an image and formula and labels missing objects', () => {
  const imageId = '12345678-aaaa-bbbb-cccc-123456789012.png'
  const { container } = render(<KnowledgeMarkdown courseId="course-1" references={[
    { id: 'diagram', kind: 'image', label: 'Diagram', value: imageId, requires: [] },
    { id: 'square', kind: 'latex', label: 'Square', value: 'x^2', requires: [] },
  ]} source={'[Diagram](refobj:diagram) [Square](refobj:square) [Missing](refobj:removed) ` [Code](refobj:other) `'} />)
  assert.equal(container.querySelector('img')?.getAttribute('src'), `/api/files/images/course-1/${imageId}`)
  assert.ok(container.querySelector('.katex'))
  assert.match(container.textContent ?? '', /Reference unavailable \(removed\)/)
  assert.match(container.querySelector('code:not(.katex code)')?.textContent ?? '', /refobj:other/)
  assert.equal(container.querySelector('a'), null)
})

test('imported heading numbers match preview and expose their escape when edited', async () => {
  const source = '#### 1\\. What Does “Rate of Change” Mean?\n\n`1\\.`'
  const preview = render(<KnowledgeMarkdown source={source} />)
  const heading = preview.getByRole('heading', { level: 4 }).textContent
  assert.equal(heading, '1. What Does “Rate of Change” Mean?')
  let editor: EditorView | null = null
  const { container } = render(<MemoryRouter><MarkdownSourceEditor value={source}
    onChange={() => assert.fail('display changed document')} onViewReady={view => { editor = view }} /></MemoryRouter>)
  const headingLine = () => container.querySelector('.cm-md-h4')?.textContent
  await waitFor(() => assert.equal(headingLine(), heading))
  const slash = source.indexOf('\\')
  act(() => editor!.dispatch({ selection: { anchor: slash + 1 } }))
  await waitFor(() => assert.match(headingLine() ?? '', /1\\\./))
  act(() => editor!.dispatch({ selection: { anchor: source.indexOf('Mean') } }))
  await waitFor(() => assert.equal(headingLine(), heading))
  assert.match(container.querySelector('.cm-md-code')?.textContent ?? '', /1\\\./)
  assert.equal(editor!.state.doc.toString(), source)
})

test('editor displays DOCX HTML table and images without modifying the source', async () => {
  let editor: EditorView | null = null
  const source = `${html}\n\n末尾`
  const { container } = render(<MemoryRouter><MarkdownSourceEditor value={source} onChange={() => assert.fail('display changed document')}
    onViewReady={(view) => { editor = view }} /></MemoryRouter>)
  await waitFor(() => assert.ok(container.querySelector('.cm-md-table-widget img')))
  fireEvent.click(container.querySelector('.cm-md-table-widget td')!)
  assert.ok(container.querySelector('.cm-md-table-widget img'))
  assert.equal(editor!.state.doc.toString(), source)
})

test('Word equations inside a rich HTML table render in the editor and document preview', async () => {
  const source = '<table><tr><td><code class="language-math math-inline">\\frac{df}{dt}</code></td></tr></table>'
  const preview = render(<KnowledgeMarkdown source={source} />)
  assert.ok(preview.container.querySelector('td .katex .mfrac'))
  const editor = render(<MemoryRouter><MarkdownSourceEditor value={source} onChange={() => assert.fail('display changed document')} /></MemoryRouter>)
  await waitFor(() => assert.ok(editor.container.querySelector('.cm-md-table-widget td .katex .mfrac')))
})

test('spreadsheet table survives ten edit, repeated click and done cycles', async () => {
  let editor: EditorView | null = null
  const table = '| 名称 | 备注 |\n| --- | --- |\n| 唐僧 | first<br>second |\n| 孙悟空 | A\\|B |'
  const source = `## 工作表\n\n${table}\n\n结束`
  const original = Range.prototype.getClientRects
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  try {
    const { container } = render(<MemoryRouter><MarkdownSourceEditor value={source} onChange={() => {}}
      onViewReady={(view) => { editor = view }} /></MemoryRouter>)
    for (let i = 0; i < 10; i++) {
      const cell = await waitFor(() => {
        const element = container.querySelector('.cm-md-table-cell-preview')
        assert.ok(element)
        return element
      })
      fireEvent.click(cell)
      await waitFor(() => assert.ok(container.querySelector('.cm-md-table-cell-edit')))
      const edit = container.querySelector('.cm-md-table-cell-edit')!
      fireEvent.click(edit)
      fireEvent.click(edit)
      fireEvent.click(container.querySelector('.cm-md-table-tbtn-primary')!)
      assert.equal(editor!.state.doc.toString(), source)
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    }
  } finally {
    Range.prototype.getClientRects = original
  }
})
