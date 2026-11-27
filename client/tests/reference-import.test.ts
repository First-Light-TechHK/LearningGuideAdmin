import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchReference, parseReferences, referenceDraft } from '../src/components/knowledge/referenceImport'
import type { TeachingEntry } from '../src/api/teachingCards'

const md = '## Lesson 3\n### L3-F02 向量 · Vector\n\n$$\n\\begin{bmatrix}\na \\\\\nb\n\\end{bmatrix}\n$$\n\n说明。\n\nExplanation.\n'
const image = '00000000-0000-0000-0000-000000000001.png'
test('splits by heading, retains multiline LaTeX and ignores fenced examples', () => {
  const [row, ...rest] = parseReferences(md + '\n~~~md\n### L1-F99 假 · Example\n~~~', 'formulas.md', 'c')
  assert.equal(rest.length, 0)
  assert.equal(parseReferences('### L1-F01 平方 · Square\n$$x^2$$', 'f.md', 'c')[0].value, 'x^2')
  assert.equal(row.code, 'L3-F02')
  assert.equal(row.lesson, 'Lesson 3')
  assert.equal(row.line, 2)
  assert.equal(row.value, '\\begin{bmatrix}\na \\\\\nb\n\\end{bmatrix}')
  assert.deepEqual(row.summary, { zh: '说明。', en: 'Explanation.' })
})
test('binds exhibit pictures to the containing heading, rejects missing, foreign and ambiguous assets', () => {
  const link = '![](/api/files/images/c/' + image + ')'
  const row = (body: string) => parseReferences('## Exhibit 1.17 种群 · Population\n' + body, 'notes.docx', 'c')[0]
  assert.equal(row(link).value, image)
  assert.equal(row(link.replace('/c/', '/other/')).issue, 'missingAsset')
  assert.equal(row(link + '\n' + link).issue, 'multipleAssets')
  assert.equal(row('').issue, 'missingAsset')
})
test('imports an English-only reference and requires both English fields', () => {
  const [row] = parseReferences('### L1-F01 Vector\n$$x+y$$\n\nAdd components.', 'f.md', 'c')
  assert.deepEqual(row.names, { zh: '', en: 'Vector' })
  assert.deepEqual(row.summary, { zh: '', en: 'Add components.' })
  assert.equal(matchReference(row, [], []).status, 'new')
  assert.equal(matchReference({ ...row, summary: { zh: '逐分量相加', en: '' } }, [], []).status, 'conflict')
  const [chineseName] = parseReferences('### L1-F01 向量\n$$x+y$$\n\nAdd components.', 'f.md', 'c')
  assert.equal(matchReference(chineseName, [], []).status, 'conflict')
})
test('matches aliases and approved codes while preserving the active reference identity', () => {
  const [row] = parseReferences(md, 'f.md', 'c')
  const draft = referenceDraft(row)
  const entry = { id: 'kept', revision: 4, draft: { ...draft, approvedPayload: { ...draft.approvedPayload, code: 'VECTOR', aliases: [row.code] } }, approved: draft } as unknown as TeachingEntry
  assert.equal(matchReference(row, [entry], []).status, 'same')
  assert.equal(matchReference({ ...row, value: '2x' }, [entry], []).status, 'update')
  assert.equal(referenceDraft(row, entry).approvedPayload.code, 'VECTOR')
  assert.equal(matchReference({ ...row, kind: 'image', value: image }, [entry], []).status, 'conflict')
  assert.equal(matchReference({ ...row, summary: { en: ' ', zh: '' } }, [], []).status, 'conflict')
  assert.equal(matchReference(row, [], [row.code.toLowerCase()]).status, 'recreate')
})
