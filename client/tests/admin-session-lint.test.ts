import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const shellPath = 'src/backoffice/ShellRoute.tsx'
const project = fileURLToPath(new URL('../', import.meta.url))
const ruleName = 'resolved-before-readiness'

function lintShell(guards: string) {
  const folder = mkdtempSync(join(tmpdir(), 'admin-session-lint-'))
  try {
    const shell = join(folder, shellPath)
    mkdirSync(dirname(shell), { recursive: true })
    mkdirSync(join(folder, 'lint'))
    for (const file of ['.oxlintrc.json', 'lint/admin-session.mjs']) {
      copyFileSync(join(project, file), join(folder, file))
    }
    writeFileSync(shell, `
      declare function useState(initial: { kind: string }): [{ kind: string }]
      export function ShellRoute(capabilities: unknown, accountFeatures: unknown) {
        const [session] = useState({kind: 'loading'})
        ${guards}
        return 'app'
      }
    `)
    const result = spawnSync(process.execPath, [
      join(project, 'node_modules/oxlint/bin/oxlint'),
      shellPath,
    ], { cwd: folder, encoding: 'utf8', timeout: 15_000 })
    assert.ifError(result.error)
    return { status: result.status, output: result.stdout + result.stderr }
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

const outcomes = `
  if (session.kind === 'unavailable') return 'retry'
  if (session.kind === 'signedOut') return 'sign in'
`
const readiness = "if (session.kind === 'loading' || capabilities === null || accountFeatures === undefined) return 'loading'"

test('session lint rejects a loading guard that also intercepts signed-out and unavailable sessions', () => {
  const result = lintShell(readiness + outcomes)
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, new RegExp(ruleName))
  assert.match(result.output, /signedOut or unavailable/)
})

test('session lint accepts a readiness guard after resolved session outcomes', () => {
  const result = lintShell(outcomes + readiness)
  assert.equal(result.status, 0, result.output)
})

test('session lint permits loading and explicitly signed-in readiness before resolved outcomes', () => {
  const result = lintShell(`
    if (session.kind === 'loading') return 'loading'
    if (session.kind === 'signedIn' && (capabilities === null || accountFeatures === undefined)) return 'loading'
    ${outcomes}
  `)
  assert.equal(result.status, 0, result.output)
})
