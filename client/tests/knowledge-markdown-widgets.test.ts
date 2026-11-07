import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { parseTable, renderInline, serializeTable, TableWidget } from '../src/components/knowledge/markdownWidgets'

describe('Knowledge Markdown table widgets', () => {
  test('table text survives repeated parse and serialize cycles', () => {
    const original = '| Name | Score |\n| --- | --- |\n| Alice | 90 |\n| Bob | 85 |'
    let current = original
    for (let i = 0; i < 10; i++) {
      const parsed = parseTable(current)
      assert.ok(parsed)
      current = serializeTable(parsed)
    }
    assert.equal(current, original)
  })

  test('cell line breaks serialize without splitting the table', () => {
    const parsed = parseTable('| Name | Note |\n| --- | --- |\n| Alice | first<br>second |')
    assert.ok(parsed)
    assert.equal(parseTable(serializeTable(parsed))?.rows[0][1], 'first<br>second')
    assert.equal(renderInline('first<br>second'), 'first<br>second')
  })

  test('a table moved in the document is not treated as the same widget', () => {
    const markdown = '| Name |\n| --- |\n| Alice |'
    const deps = [false, false, () => null, () => {}, () => {}, (key: string) => key, 'en'] as const
    const before = new TableWidget(markdown, 10, 10 + markdown.length, ...deps)
    const after = new TableWidget(markdown, 30, 30 + markdown.length, ...deps)
    assert.equal(before.eq(after), false)
  })
})
