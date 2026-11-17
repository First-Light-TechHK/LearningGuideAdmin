import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tutorAnswerParts } from '../src/components/ai/tutorAnswerParts'

test('常规：逐行段落、列表、引用和来源按 Portal 规则分组', () => {
  const result = tutorAnswerParts('第一点\n第二点\n- 项目一\n- 项目二\n\n结论 [Source: Lesson 1]\nSources\n[1] Chapter 2')
  assert.match(result.markdown, /第一点\n\n第二点/)
  assert.match(result.markdown, /- 项目一\n- 项目二/)
  assert.deepEqual(result.sources, ['Lesson 1', '[1] Chapter 2'])
})

test('边界：代码、未完成公式及金额保持可读', () => {
  const input = 'Intro\n```text\n$5 [Source: code]\n```\nPrice $5 and $10. Pending $x='
  const result = tutorAnswerParts(input)
  assert.match(result.markdown, /```text\n\$5 \[Source: code\]\n```/)
  assert.ok(result.markdown.includes('Price \\$5 and \\$10'))
  assert.deepEqual(result.sources, [])
})

test('边界：数学分隔符、数字乘号和来源去重', () => {
  const result = tutorAnswerParts(String.raw`Compute 2*3 and \(x^2\) [Source: Unit A] [Source: Unit A]`)
  assert.match(result.markdown, /2\\\*3 and \$x\^2\$/)
  assert.deepEqual(result.sources, ['Unit A'])
})

test('异常：空文本、未闭合代码围栏不会抛错', () => {
  assert.deepEqual(tutorAnswerParts(''), { markdown: '', sources: [] })
  assert.match(tutorAnswerParts('Before\n```js\nconst x = 1').markdown, /```js\nconst x = 1$/)
})
