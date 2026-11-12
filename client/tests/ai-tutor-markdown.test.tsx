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
  assert.match(container.querySelector('.tutor-answer-sources')?.textContent ?? '', /Chapter 1/)
  assert.equal(container.querySelector('code')?.textContent, '[2]')
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

test('缩进的中文长句按普通段落显示，不产生横向代码块', () => {
  const { container } = render(<TutorMarkdown content={'    状态必须带有数值和单位，因为我们需要对系统进行定量的数学分析。'} />)
  assert.equal(container.querySelector('.tutor-answer pre'), null)
  assert.match(container.querySelector('.tutor-answer p')?.textContent ?? '', /状态必须带有数值和单位/)
})

test('常规：段落、列表、引用、表格、代码和来源使用同一回答层', () => {
  const { container } = render(<TutorMarkdown content={'第一点\n第二点\n- 列表一\n- 列表二\n\n> 引用\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```js\nconst a = 1\n```\n\n结论 [Source: Lesson 1]'} sourcesLabel="来源" />)
  assert.equal(container.querySelectorAll('.tutor-answer p').length >= 2, true)
  for (const selector of ['ul', 'blockquote', 'table', 'pre code']) assert.ok(container.querySelector(`.tutor-answer ${selector}`), selector)
  assert.match(container.querySelector('.tutor-answer-sources')?.textContent ?? '', /来源Lesson 1/)
})

test('常规：标题、强调、任务列表、分隔线和行内引用保持 Markdown 结构', () => {
  const { container } = render(<TutorMarkdown content={'# 标题\n\n**重点** *斜体* ~~删除~~\n\n- [x] 已完成\n- [ ] 待完成\n\n---\n\nClaim [1].'} />)
  for (const selector of ['h1', 'strong', 'em', 'del', 'input[type="checkbox"]', 'hr']) assert.ok(container.querySelector(`.tutor-answer ${selector}`), selector)
  assert.match(container.textContent ?? '', /Claim \[1\]/)
})

test('边界：课程图片按当前课程显示，外部和跨课程图片只保留替代文字', () => {
  const id = '22222222-2222-4222-8222-222222222222.png'
  const { container } = render(<TutorMarkdown courseId="course-a" content={`![ok](/api/files/images/course-a/${id}) ![wrong](/api/files/images/course-b/${id}) ![remote](https://example.com/x.png)`} />)
  assert.equal(container.querySelectorAll('img').length, 1)
  assert.equal(container.querySelector('img')?.getAttribute('src'), `/api/files/images/course-a/${id}`)
  assert.match(container.textContent ?? '', /wrong.*remote/)
})

test('异常：空回答和危险链接不产生可执行元素', () => {
  const { container, rerender } = render(<TutorMarkdown content="" />)
  assert.equal(container.querySelectorAll('a,img,script').length, 0)
  rerender(<TutorMarkdown content={'[bad](javascript:alert(1)) <img src="x" onerror="alert(1)">'} />)
  assert.equal(container.querySelectorAll('a,img,script,[onerror]').length, 0)
})

test('边界：超长文本和未闭合围栏完整保留内容', () => {
  const long = '状态变量'.repeat(180)
  const { container, rerender } = render(<TutorMarkdown content={long} />)
  assert.equal(container.querySelector('.tutor-answer p')?.textContent, long)
  rerender(<TutorMarkdown content={'说明\n```js\nconst x = 1'} />)
  assert.match(container.querySelector('pre code')?.textContent ?? '', /const x = 1/)
})
