// 外壳的“墙”和钥石：按环境身份渲染，旧的环境徽标不再存在。
import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { cleanup, render } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { AppShell } from '../src/backoffice/components/AppShell'
import { resolveEnvironment, type EnvironmentIdentity } from '../src/backoffice/lib/environment'

afterEach(cleanup)

function shellFor(path: string, identity: EnvironmentIdentity) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/:locale/*"
          element={
            <AppShell
              employee={{ displayName: 'Ada', loginEmail: 'ada@example.com', role: 'SUPER_ADMIN' }}
              menus={['course', 'student']}
              environment={identity}
            >
              <div>page</div>
            </AppShell>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

const CASES: Array<[string, string, string | null, string, string]> = [
  ['sandbox', 'SANDBOX', 'Sandbox', 'sandbox', 'Sandbox'],
  ['production', 'PROD', 'Production', 'production', 'Production'],
  ['neutral code', 'DEV', 'Sandbox', 'neutral', 'DEV'],
  ['neutral unknown', '', null, 'neutral', 'Unknown environment'],
]

for (const [name, appEnv, label, kind, text] of CASES) {
  test(`wall and keystone: ${name}`, () => {
    const view = shellFor('/en-GB/course', resolveEnvironment(appEnv, label))
    const shell = view.container.querySelector('.shell')
    assert.equal(shell?.getAttribute('data-env'), kind)
    const keystone = view.container.querySelector('[data-testid="env-keystone"]')
    assert.ok(keystone)
    // visible name + the visually hidden announcement
    assert.equal(keystone.querySelector('[aria-hidden="true"]:not(.envMark)')?.textContent, text)
    assert.equal(keystone.querySelector('.visuallyHidden')?.textContent, `Environment: ${text}`)
    // the old pill is gone: nothing but the keystone carries the environment name
    assert.equal(view.container.querySelectorAll('[style*="border-radius: 999px"]').length, 0)
    assert.ok(view.container.querySelector('.envWall .appSurface .sidebar [data-menu="course"]'))
  })
}

test('keystone in Chinese', () => {
  const view = shellFor('/zh-CN/course', resolveEnvironment('SANDBOX', 'Sandbox'))
  assert.equal(view.container.querySelector('[data-testid="env-keystone"] [aria-hidden="true"]:not(.envMark)')?.textContent, '沙盒')
})
