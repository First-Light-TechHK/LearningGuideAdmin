import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { cleanup, render } from '@testing-library/react'

import { MarkdownView } from '../src/backoffice/helpdesk/Markdown'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { parseMarkdown, safeHref, summaryLine, unsafeLinks } from '../src/backoffice/lib/helpdeskMarkdown'

/**
 * Tickets v2 §1 answer format: the Markdown subset the drawer toolbar writes (**bold**, "1. ",
 * "- ", [text](https://… | mailto:…), paragraphs), shown by ONE safe renderer (Preview and the
 * Enquiries AI blocks). No raw HTML, only http(s) / mailto links, external links open in a new
 * tab with rel="noopener noreferrer".
 */

const FIXTURE_ANSWER =
  '1. Check your spam folder\n2. Request a new link on [Forgot password](https://www.ilovelearningguide.com/en-GB/forgot-password)\n\nStill stuck? Email **support** at [support@ilovelearningguide.com](mailto:support@ilovelearningguide.com).'

afterEach(() => cleanup())

describe('parseMarkdown', () => {
  test('paragraphs, ordered and bullet lists, bold and links', () => {
    assert.deepEqual(parseMarkdown('Hello **there**\nsecond line\n\n- one\n- [two](https://x.test/a)\n\n3. three\n4. four'), [
      {
        kind: 'paragraph',
        lines: [
          [
            { kind: 'text', text: 'Hello ' },
            { kind: 'strong', children: [{ kind: 'text', text: 'there' }] },
          ],
          [{ kind: 'text', text: 'second line' }],
        ],
      },
      {
        kind: 'bullet',
        items: [
          [[{ kind: 'text', text: 'one' }]],
          [[{ kind: 'link', href: 'https://x.test/a', external: true, children: [{ kind: 'text', text: 'two' }] }]],
        ],
      },
      { kind: 'ordered', start: 3, items: [[[{ kind: 'text', text: 'three' }]], [[{ kind: 'text', text: 'four' }]]] },
    ])
  })

  test('a list directly after a paragraph line starts a new block (no blank line needed)', () => {
    const blocks = parseMarkdown('Steps:\n1. a\n2. b\n\nThanks')
    assert.deepEqual(
      blocks.map((block) => block.kind),
      ['paragraph', 'ordered', 'paragraph'],
    )
  })

  test('CRLF and stray spaces are tolerated; empty input gives nothing', () => {
    assert.deepEqual(parseMarkdown('a\r\n\r\n  \r\nb').length, 2)
    assert.deepEqual(parseMarkdown('   \n\n'), [])
  })

  test('unsafe links keep only their label, as on Portal (javascript:, data:, relative, protocol-relative)', () => {
    for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', '/relative', '//evil.test', 'ftp://x.test']) {
      const [block] = parseMarkdown(`[click](${href})`)
      assert.equal(block.kind, 'paragraph')
      assert.deepEqual(block.kind === 'paragraph' ? block.lines[0] : null, [{ kind: 'text', text: 'click' }], href)
      assert.deepEqual(unsafeLinks(`[click](${href})`), [href])
    }
  })

  test('an unclosed ** is literal text', () => {
    assert.deepEqual(parseMarkdown('2 ** 3'), [{ kind: 'paragraph', lines: [[{ kind: 'text', text: '2 ** 3' }]] }])
  })
})

describe('safeHref', () => {
  test('only absolute http(s) with a host and mailto with an address (the Portal rule)', () => {
    assert.equal(safeHref('https://a.test/x'), 'https://a.test/x')
    assert.equal(safeHref('http://a.test'), 'http://a.test/')
    assert.equal(safeHref('mailto:a@b.test'), 'mailto:a@b.test')
    for (const bad of ['javascript:x', 'vbscript:x', 'data:x', 'file:///etc/passwd', '', 'https://', 'https://a b.test', ' https://a.test/x ', 'mailto:foo', "https://x.test/it's", 'https:///x']) {
      assert.equal(safeHref(bad), null, bad)
    }
  })
})

describe('summaryLine (FAQ list subtitle, Figma has no summary field)', () => {
  test('first plain-text line with the Markdown stripped', () => {
    assert.equal(summaryLine(FIXTURE_ANSWER), 'Check your spam folder')
    assert.equal(summaryLine('\n\n**Open** [My Subscription](https://x.test) page'), 'Open My Subscription page')
    assert.equal(summaryLine('- bullet item'), 'bullet item')
    assert.equal(summaryLine(''), '')
  })

  test('truncated with an ellipsis', () => {
    const line = summaryLine('word '.repeat(60), 40)
    assert.ok(line.length <= 40)
    assert.ok(line.endsWith('…'))
  })
})

/**
 * The shared corpus: the same bytes as Portal tests/fixtures/helpdesk-markdown-corpus.json and
 * server/src/backoffice/tests/fixtures (where the save check runs it). The Preview must show what
 * learners see (§1), so this parser gives exactly Portal's blocks, summary line and dropped links.
 */
describe('shared Markdown corpus (Portal parity)', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url))
  const bytes = read('./fixtures/helpdesk-markdown-corpus.json')

  test('is the pinned copy, byte-identical to the server copy', () => {
    assert.equal(createHash('sha256').update(bytes).digest('hex'), '45ece9b892722705fa064ef580ebaa1b0afdb094758eebdf021238565a97c852')
    assert.ok(bytes.equals(read('../../server/src/backoffice/tests/fixtures/helpdesk-markdown-corpus.json')))
  })

  test('every case parses, summarises and reports unsafe links as the corpus says', () => {
    const corpus = JSON.parse(bytes.toString('utf8')) as {
      cases: { name: string; input: string; blocks: unknown; summaryMax: number; summary: string; unsafeLinks: string[] }[]
    }
    for (const item of corpus.cases) {
      assert.deepEqual(parseMarkdown(item.input), item.blocks, `blocks: ${item.name}`)
      assert.equal(summaryLine(item.input, item.summaryMax), item.summary, `summary: ${item.name}`)
      assert.deepEqual(unsafeLinks(item.input), item.unsafeLinks, `unsafe links: ${item.name}`)
    }
  })

  test('a list item with a continuation line renders both lines in one item, as on Portal', () => {
    const { container } = render(<MarkdownView text={'1. Open Settings\nthen tap Save\n2. Done'} />)
    assert.equal(container.querySelectorAll('ol').length, 1)
    assert.deepEqual(Array.from(container.querySelectorAll('ol > li'), (li) => li.innerHTML), [
      'Open Settings<br><span class="md-line">then tap Save</span>',
      'Done',
    ])
  })

  test('a bare URL renders as a safe external link', () => {
    const { container } = render(<MarkdownView text={'Visit https://learningguide.com/billing.'} />)
    const a = container.querySelector('a')
    assert.deepEqual([a?.getAttribute('href'), a?.getAttribute('target'), a?.getAttribute('rel')], ['https://learningguide.com/billing', '_blank', 'noopener noreferrer'])
  })
})

describe('MarkdownView', () => {
  test('renders the contract answer: list, bold, links in a new tab with noopener noreferrer', () => {
    const { container } = render(<MarkdownView text={FIXTURE_ANSWER} />)
    const items = Array.from(container.querySelectorAll('ol > li'), (li) => li.textContent)
    assert.deepEqual(items, ['Check your spam folder', 'Request a new link on Forgot password'])
    assert.equal(container.querySelector('strong')?.textContent, 'support')
    const links = Array.from(container.querySelectorAll('a'))
    assert.deepEqual(
      links.map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]),
      [
        ['Forgot password', 'https://www.ilovelearningguide.com/en-GB/forgot-password', '_blank', 'noopener noreferrer'],
        ['support@ilovelearningguide.com', 'mailto:support@ilovelearningguide.com', null, 'noopener noreferrer'],
      ],
    )
  })

  test('raw HTML is shown as text, never parsed', () => {
    const { container } = render(<MarkdownView text={'<img src=x onerror=alert(1)> <script>alert(1)</script> <b>x</b>'} />)
    assert.equal(container.querySelector('img, script, b'), null)
    assert.match(container.textContent ?? '', /<img src=x onerror=alert\(1\)>/)
  })

  test('a javascript: link renders no anchor', () => {
    const { container } = render(<MarkdownView text={'[x](javascript:alert(1))'} />)
    assert.equal(container.querySelector('a'), null)
  })

  test('line breaks inside a paragraph are kept', () => {
    const { container } = render(<MarkdownView text={'a\nb'} />)
    assert.equal(container.querySelectorAll('p br').length, 1)
  })
})
