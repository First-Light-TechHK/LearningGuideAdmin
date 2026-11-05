import './support/dom'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { cleanup, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { MarkdownSourceEditor } from '../src/components/knowledge/MarkdownSourceEditor'

afterEach(cleanup)

test('knowledge live preview renders vectors containing bracket and spacing commands', async () => {
  const original = Range.prototype.getClientRects
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  try {
    const { container } = render(
      <MemoryRouter>
        <MarkdownSourceEditor value={String.raw`Inline: $\vec{u}=[4,\,1]$.`} onChange={() => {}} />
      </MemoryRouter>,
    )
    await waitFor(() => assert.ok(container.querySelector('.cm-md-math-inline .katex')))
  } finally {
    Range.prototype.getClientRects = original
  }
})
