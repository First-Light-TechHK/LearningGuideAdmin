import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * Enquiries three columns (Figma 1324:2 at 1672 px: list 340, side 387, conversation the rest).
 * On 1280–1440 px laptops the conversation keeps a usable width: the side columns give way
 * down to their minimums instead. Measured in a real browser (before → after, middle column):
 * 1280: 291 → 420, 1366: 377 → 420, 1440: 411 → 420, 1672: 643 → 643 (pixel-identical).
 */
const css = readFileSync(new URL('../src/backoffice/helpdesk.css', import.meta.url), 'utf8')

function rule(selector: string): Record<string, string> {
  const match = new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')} \\{([^}]*)\\}`).exec(css)
  assert.ok(match, `${selector} rule missing`)
  return Object.fromEntries(
    match[1]
      .split(';')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('/*'))
      .map((line) => {
        const at = line.indexOf(':')
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()]
      }),
  )
}

const px = (value: string) => Number(/^(\d+)px$/.exec(value)?.[1])

describe('Enquiries column widths', () => {
  test('Figma widths at full size: list 340, side 387', () => {
    assert.match(css, /--hd-list-width: 340px;/)
    assert.match(css, /--hd-side-width: 387px;/)
    assert.equal(rule('.hdList').flex, '0 1 var(--hd-list-width)')
    assert.equal(rule('.hdSide').flex, '0 1 var(--hd-side-width)')
  })

  test('the conversation keeps at least 420 px; list and side shrink to 280 / 300', () => {
    assert.equal(rule('.hdConversation')['min-width'], '420px')
    assert.equal(rule('.hdList')['min-width'], '280px')
    assert.equal(rule('.hdSide')['min-width'], '300px')
  })

  test('at 1280 px the minimums fit in the 1018 px the card gives the three columns', () => {
    const minimums = ['.hdList', '.hdConversation', '.hdSide'].map((s) => px(rule(s)['min-width']))
    assert.ok(minimums.reduce((a, b) => a + b, 0) <= 1018)
  })

  test('narrower than the minimums, the columns scroll sideways instead of being cut off', () => {
    assert.equal(rule('.hdMain')['overflow-x'], 'auto')
    assert.equal(rule('.hdMain')['overflow-y'], 'hidden')
  })
})
