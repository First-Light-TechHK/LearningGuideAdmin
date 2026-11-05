import './support/dom'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { cleanup, render } from '@testing-library/react'
import { TutorMarkdown } from '../src/components/ai/TutorMarkdown'
import { normalizeTutorMarkdown } from '../src/components/ai/normalizeTutorMarkdown'

afterEach(cleanup)

test('四种数学分隔符均渲染，数组下标和代码不被引用转换', () => {
  const { container } = render(<TutorMarkdown content={String.raw`$x=[1]$ and \(y=2\).

$$z=3$$

\[w=4\]

Claim [1]. Code: ${"`[2]`"}.

Sources
[1] Chapter 1`} />)
  assert.equal(container.querySelectorAll('.katex').length, 4)
  assert.equal(container.querySelectorAll('sup').length, 1)
  assert.equal(container.querySelector('code')?.textContent, '[2]')
  assert.match(container.querySelector('.markdown-sources')?.textContent ?? '', /Chapter 1/)
  assert.equal(normalizeTutorMarkdown('$x=[1]$'), '$x=[1]$')
})

test('代码块、金额和未闭合公式在增量中保持可读', () => {
  const code = '```text\nSources\n[1] $x$ \\(z\\)\n```'
  assert.equal(normalizeTutorMarkdown(code), code)
  const { container, rerender } = render(<TutorMarkdown content={'Price $5 and $10. Also $5, $10. Pending $x='} />)
  assert.equal(container.querySelector('.katex'), null)
  assert.match(container.textContent ?? '', /Price \$5 and \$10/)
  rerender(<TutorMarkdown content={'Price $5 and $10. Complete $x=2$ and $5 + 10$'} />)
  assert.equal(container.querySelectorAll('.katex').length, 2)
})

test('Markdown 链接保留，原始 HTML 和危险 URL 不成为可执行内容', () => {
  const { container } = render(<TutorMarkdown content={'[site](https://example.com) [bad](javascript:alert(1))\n\n<img src="x" onerror="alert(1)"><script>alert(1)</script>'} />)
  assert.equal(container.querySelector('a')?.getAttribute('href'), 'https://example.com')
  assert.equal(Boolean(container.querySelector('[onerror],script')), false)
  assert.equal(Boolean(container.querySelector('a[href^="javascript:"]')), false)
})
