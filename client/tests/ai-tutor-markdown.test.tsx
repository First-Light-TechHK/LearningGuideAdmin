import './support/dom'
import assert from 'node:assert/strict'
import { afterEach, test as nodeTest } from 'node:test'
import { cleanup, render } from '@testing-library/react'
import type { ComponentProps, ComponentType } from 'react'
import { ChatAnswer } from '../src/components/ai/ChatAnswer'
import { TutorMarkdown } from '../src/components/ai/TutorMarkdown'
import { tutorAnswerParts } from '../src/components/ai/tutorAnswerParts'
import { normalizeTutorMarkdown } from '../src/components/ai/normalizeTutorMarkdown'

afterEach(cleanup)

function test(name: string, run: (Answer: ComponentType<ComponentProps<typeof TutorMarkdown>>) => void) {
  nodeTest(name + ' · shared preview', () => run(TutorMarkdown))
  nodeTest(name + ' · AI Test', () => run(ChatAnswer))
}

test('只整理有来源的双层引用，保留公式、代码和 Markdown 链接', (Answer) => {
  const content = '方向 [[1]]，未知 [[9]]。 $[[1]]$。\n\n' + '\x60[[1]]\x60 [[1]](https://example.com)\n\nSources\n[1] Lesson 3'
  const { container } = render(<Answer content={content} />)
  assert.match(container.textContent ?? '', /方向 \[1\]，未知 \[\[9\]\]/)
  assert.equal(container.querySelector('code')?.textContent, '[[1]]')
  assert.equal(container.querySelector('a')?.getAttribute('href'), 'https://example.com')
  assert.ok(tutorAnswerParts(content).markdown.includes('$[[1]]$'))
})

test('旧回答用紧邻的配图标题补全句子，仍只展示一张图', (Answer) => {
  const content = 'The exhibit is . \n\nExhibit 1.7\n\n![Exhibit 1.7][exhibit:r:item]\n\n[exhibit:r:item]: /api/files/images/c/11111111-1111-4111-8111-111111111111.png'
  const { container } = render(<Answer content={content} courseId="c" />)
  assert.match(container.textContent ?? '', /The exhibit is Exhibit 1\.7\./)
  assert.equal(container.querySelectorAll('img').length, 1)
})

test('旧回答的混合引用只显示来源编号，代码与图片引用保持可用', (Answer) => {
  const id = 'bcf873fb-7cee-43d3-9656-791097a9cd6c'
  const key = `exhibit:release-test:${id}`
  const path = '/api/files/images/course/11111111-1111-4111-8111-111111111111.png'
  const content = `温度 [1, [ref:${id}]]。重量 [[ref:${id}]]。体积 [1，ref:${id}，2]。普通来源 [1, 2]。\n\n![咖啡杯][${key}]\n\n[${key}]: ${path}\n\n示例代码：\`[ref:example]\``
  const { container } = render(<Answer courseId="course" content={content} />)
  assert.match(container.textContent ?? '', /温度 \[1\]。重量 。体积 \[1, 2\]。普通来源 \[1, 2\]。/)
  assert.ok(!container.textContent?.includes(id))
  assert.equal(container.querySelector('code')?.textContent, '[ref:example]')
  assert.equal(container.querySelector('img')?.getAttribute('src'), path)
})

test('课程图片的版本化 Markdown 引用显示为一张图，引用 ID 对学生隐藏', (Answer) => {
  const path = '/api/files/images/course/11111111-1111-4111-8111-111111111111.png'
  const key = 'exhibit:release-test:coffee'
  const content = `咖啡杯的状态变量\n\n![咖啡杯][${key}]\n\n[${key}]: ${path}\n\n来源见讲义。`
  const { container } = render(<Answer courseId="course" content={content} />)
  assert.equal(container.querySelector('img')?.getAttribute('src'), path)
  assert.equal(container.querySelectorAll('img').length, 1)
  assert.ok(!container.textContent?.includes(key))
})

test('公式展示为 KaTeX，追问所用的版本号与对象 ID 不进入正文', (Answer) => {
  const { container } = render(<Answer content={'向量加法\n\n$$a+b$$\n\n[exhibit:release-test:add]: #formula'} />)
  assert.equal(container.querySelectorAll('.katex').length, 1)
  assert.ok(!container.textContent?.includes('exhibit:'))
})

test('L3-F02 新旧引用均显示三行矩阵，追问标记隐藏且来源保留', (Answer) => {
  const formula = ['x(t) = \\begin{bmatrix}', '\tS(t) \\\\', '\tT(t) \\\\', '\tP(t)', '\\end{bmatrix}'].join('\n')
  for (const block of [`$$${formula}$$`, `$$\n${formula}\n$$`]) {
    const content = `抽象空间 [1]。\n\nL3-F02 · 三维状态向量\n\n${block}\n\n[exhibit:release:vector]: #formula\n\nSources\n[1] 状态空间`
    const { container, unmount } = render(<Answer content={content} />)
    assert.equal(container.querySelector('.katex-error')?.textContent ?? '', '')
    assert.equal(container.querySelectorAll('.katex-display').length, 1)
    const rows = container.querySelector('.mtable .vlist')?.children ?? []
    assert.deepEqual(Array.from(rows, row => row.textContent?.trim()).filter(Boolean), ['S(t)', 'T(t)', 'P(t)'])
    assert.doesNotMatch(container.textContent ?? '', /exhibit:|#formula/)
    assert.match(container.querySelector('.tutor-answer-sources')?.textContent ?? '', /状态空间/)
    unmount()
  }
})

test('流式矩阵完整后正常渲染，正文和引用留在公式外', (Answer) => {
  const rows = [
    String.raw`\begin{pmatrix}`,
    String.raw`V \\`,
    String.raw`[\mathrm{Na}^+] \\`,
    String.raw`[\mathrm{K}^+] \\`,
    String.raw`[\mathrm{Ca}^{2+}]`,
    String.raw`\end{pmatrix}`,
  ]
  const prefix = ['State vector:', '$$', ...rows.slice(0, 2)].join('\r\n')
  const answer = ['State vector:', '$$', ...rows, '$$', 'Next paragraph. [1]', '', 'Sources', '[1] Lesson 3'].join('\r\n')
  const { container, rerender } = render(<Answer content={prefix} />)
  rerender(<Answer content={answer} />)
  assert.equal(container.querySelectorAll('.katex-display').length, 1)
  assert.equal(container.querySelector('.katex-error'), null)
  assert.ok(Array.from(container.querySelectorAll('p')).some((p) => p.textContent === 'Next paragraph. [1]'))
  assert.match(container.querySelector('.tutor-answer-sources')?.textContent ?? '', /Lesson 3/)
})

test('回答中展示的公式源码保持原样，随后引用的同一矩阵正常排版', (Answer) => {
  const matrix = String.raw`$$\begin{bmatrix}
S \\
T
\end{bmatrix}$$`
  const { container } = render(<Answer content={['```latex', matrix, '```', '', matrix].join('\n')} />)
  assert.equal(container.querySelector('pre code')?.textContent?.trimEnd(), matrix)
  assert.equal(container.querySelectorAll('.katex-display').length, 1)
  assert.equal(container.querySelector('.katex-error'), null)
})

test('Jack Lecture 历史方程组和神经元矩阵兼容同行定界符与引用', (Answer) => {
  for (const [open, rows, end] of [
    [String.raw`$$\begin{cases}`, [String.raw`T'=4 \\[1.2ex]`, "S'=-1.5"], String.raw`\end{cases}$$ [1]`],
    ['$$\n' + String.raw`x=\begin{pmatrix}`, [String.raw`V \\`, String.raw`[\mathrm{Na}^+] \\`, String.raw`[\mathrm{K}^+] \\`, String.raw`[\mathrm{Ca}^{2+}]`], String.raw`\end{pmatrix}` + '\n$$ [1]'],
  ] as const) {
    const content = [open, ...rows, end, 'Following text.'].join('\n')
    const { container, unmount } = render(<Answer content={content} jackLecture />)
    assert.equal(container.querySelector('.katex-error'), null)
    const column = container.querySelector('.mtable .vlist')
    assert.equal(Array.from(column?.children ?? []).filter((row) => row.textContent?.trim()).length, rows.length)
    assert.match(container.textContent ?? '', /\[1\][\s\S]*Following text/)
    unmount()
  }
})

test('四种数学分隔符均渲染，数组下标和代码不被引用转换', (Answer) => {
  const { container } = render(<Answer content={String.raw`$x=[1]$ and \(y=2\).

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

test('代码块、金额和未闭合公式在增量中保持可读', (Answer) => {
  const code = '```text\nSources\n[1] $x$ \\(z\\)\n```'
  assert.equal(normalizeTutorMarkdown(code), code)
  const { container, rerender } = render(<Answer content={'Price $5 and $10. Also $5, $10. Pending $x='} />)
  assert.equal(container.querySelector('.katex'), null)
  assert.match(container.textContent ?? '', /Price \$5 and \$10/)
  rerender(<Answer content={'Price $5 and $10. Complete $x=2$ and $5 + 10$'} />)
  assert.equal(container.querySelectorAll('.katex').length, 2)
})

test('Markdown 链接保留，原始 HTML 和危险 URL 不成为可执行内容', (Answer) => {
  const { container } = render(<Answer content={'[site](https://example.com) [bad](javascript:alert(1))\n\n<img src="x" onerror="alert(1)"><script>alert(1)</script>'} />)
  assert.equal(container.querySelector('a')?.getAttribute('href'), 'https://example.com')
  assert.equal(Boolean(container.querySelector('[onerror],script')), false)
  assert.equal(Boolean(container.querySelector('a[href^="javascript:"]')), false)
})

test('缩进的中文长句按普通段落显示，不产生横向代码块', (Answer) => {
  const { container } = render(<Answer content={'    状态必须带有数值和单位，因为我们需要对系统进行定量的数学分析。'} />)
  assert.equal(container.querySelector('.tutor-answer pre'), null)
  assert.match(container.querySelector('.tutor-answer p')?.textContent ?? '', /状态必须带有数值和单位/)
})

test('第二段缩进的讲解按正文渲染，流式补全后行内公式和来源可见', (Answer) => {
  for (const indent of ['    ', '\t', '  \t']) {
    const first = '不是，鲨鱼–金枪鱼空间并不是它们生活的真实海洋 [1, 2]。'
    const prefix = first + '\n\n' + indent + '这里的“空间”与物理空间没有任何关系，它由两个状态变量 '
    const { container, rerender, unmount } = render(<Answer content={prefix} />)
    assert.ok(!container.querySelector('pre'))
    rerender(<Answer content={prefix + '$S$ 和 $T$ 张成。\n\nSources\n[1] Lesson 1'} />)
    assert.ok(!container.querySelector('pre'))
    assert.equal(container.querySelectorAll('p .katex').length, 2)
    assert.match(container.querySelector('.tutor-answer-sources')?.textContent ?? '', /Lesson 1/)
    unmount()
  }
})

test('以行内公式开头的缩进中文解释使用正文样式，示例代码保留', (Answer) => {
  const { container } = render(<Answer content={'不是实际海洋。\n\n    $S$ 和 $T$ 表示数量。\n\n```js\n    const S = 1\n```'} />)
  assert.equal(container.querySelectorAll('p .katex').length, 2)
  assert.equal(container.querySelectorAll('pre').length, 1)
  assert.equal(container.querySelector('pre code')?.textContent?.trimEnd(), '    const S = 1')
})

test('常规：段落、列表、引用、表格、代码和来源使用同一回答层', (Answer) => {
  const { container } = render(<Answer content={'第一点\n第二点\n- 列表一\n- 列表二\n\n> 引用\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```js\nconst a = 1\n```\n\n结论 [Source: Lesson 1]'} sourcesLabel="来源" />)
  assert.equal(container.querySelectorAll('.tutor-answer p').length >= 2, true)
  for (const selector of ['ul', 'blockquote', 'table', 'pre code']) assert.ok(container.querySelector(`.tutor-answer ${selector}`), selector)
  assert.match(container.querySelector('.tutor-answer-sources')?.textContent ?? '', /来源Lesson 1/)
})

test('常规：标题、强调、任务列表、分隔线和行内引用保持 Markdown 结构', (Answer) => {
  const { container } = render(<Answer content={'# 标题\n\n**重点** *斜体* ~~删除~~\n\n- [x] 已完成\n- [ ] 待完成\n\n---\n\nClaim [1].'} />)
  for (const selector of ['h1', 'strong', 'em', 'del', 'input[type="checkbox"]', 'hr']) assert.ok(container.querySelector(`.tutor-answer ${selector}`), selector)
  assert.match(container.textContent ?? '', /Claim \[1\]/)
})

test('边界：课程图片按当前课程显示，外部和跨课程图片只保留替代文字', (Answer) => {
  const id = '22222222-2222-4222-8222-222222222222.png'
  const { container } = render(<Answer courseId="course-a" content={`![ok](/api/files/images/course-a/${id}) ![wrong](/api/files/images/course-b/${id}) ![remote](https://example.com/x.png)`} />)
  assert.equal(container.querySelectorAll('img').length, 1)
  assert.equal(container.querySelector('img')?.getAttribute('src'), `/api/files/images/course-a/${id}`)
  assert.match(container.textContent ?? '', /wrong.*remote/)
})

test('异常：空回答和危险链接不产生可执行元素', (Answer) => {
  const { container, rerender } = render(<Answer content="" />)
  assert.equal(container.querySelectorAll('a,img,script').length, 0)
  rerender(<Answer content={'[bad](javascript:alert(1)) <img src="x" onerror="alert(1)">'} />)
  assert.equal(container.querySelectorAll('a,img,script,[onerror]').length, 0)
})

test('边界：超长文本和未闭合围栏完整保留内容', (Answer) => {
  const long = '状态变量'.repeat(180)
  const { container, rerender } = render(<Answer content={long} />)
  assert.equal(container.querySelector('.tutor-answer p')?.textContent, long)
  rerender(<Answer content={'说明\n```js\nconst x = 1'} />)
  assert.match(container.querySelector('pre code')?.textContent ?? '', /const x = 1/)
})
