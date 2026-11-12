import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractWikiSources } from '../src/components/knowledge/wikiSources'

test('Wiki source links belong to the stable Page entry and keep their URL', () => {
  const refs = extractWikiSources({
    id: 'page-1',
    title: 'Lesson',
    contentMd: '# Lesson\n\n[Paper](https://example.org/paper)\n\n![Image](https://example.org/image.png)\n\n[Notes](https://example.org/notes)',
  })
  assert.deepEqual(refs, [
    { entryId: 'page-1', entryTitle: 'Lesson', linkText: 'Paper', url: 'https://example.org/paper' },
    { entryId: 'page-1', entryTitle: 'Lesson', linkText: 'Notes', url: 'https://example.org/notes' },
  ])
})
