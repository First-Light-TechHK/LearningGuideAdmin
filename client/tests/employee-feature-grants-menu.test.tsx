// H2 / M1：账号开关抬升角色 NONE 的模块后，真实页面必须放行；
// course.view 被收回时 Course 菜单/路由必须消失（而不是进入后所有 API 403）。
import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import { ShellRoute } from '../src/backoffice/ShellRoute'
import { MenuGuard } from '../src/backoffice/pages/ModulePages'
import { employee, installFakeServer } from './support/helpdesk-fake'

afterEach(cleanup)

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}</div>
}

function renderShell(path: string, page: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/:locale" element={<ShellRoute />}>
          <Route path="knowledge" element={page} />
          <Route path="*" element={<LocationProbe />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

function serve(role: Parameters<typeof employee>[0], features: string[], capabilities: string[]) {
  const server = installFakeServer()
  server.on('GET', '/api/session', {
    data: { employee: employee(role), sidebarState: 'expanded', features },
  })
  server.on('GET', '/api/backoffice/environment', {
    data: { label: 'Sandbox', versionNumberingMode: 'sandbox', capabilities },
  })
  return server
}

test('账号把 OPERATION_ADMIN 的 Knowledge 从 NONE 抬到 VIEW 后，真实页面不再 Forbidden', async () => {
  const server = serve(
    'OPERATION_ADMIN',
    ['module.course', 'course.view', 'module.knowledge', 'module.settings'],
    ['course', 'knowledge'],
  )
  try {
    renderShell(
      '/en-GB/knowledge',
      <MenuGuard menu="knowledge">
        <div data-testid="knowledge-page">Knowledge</div>
      </MenuGuard>,
    )
    await waitFor(() => assert.ok(screen.getByTestId('knowledge-page')))
    assert.equal(screen.queryByText('Forbidden'), null)
  } finally {
    server.restore()
  }
})

test('course.view 被收回：Course 菜单消失，/course 重定向到仍有权访问的模块', async () => {
  const server = serve(
    'ADMIN',
    ['module.course', 'module.knowledge', 'module.settings'],
    ['course', 'knowledge'],
  )
  try {
    renderShell('/en-GB/course', <LocationProbe />)
    await waitFor(() =>
      assert.equal(screen.getByTestId('location').textContent, '/en-GB/knowledge'),
    )
    const menus = Array.from(document.querySelectorAll('.sidebar [data-menu]')).map(
      (node) => node.getAttribute('data-menu'),
    )
    assert.ok(!menus.includes('course'))
  } finally {
    server.restore()
  }
})
