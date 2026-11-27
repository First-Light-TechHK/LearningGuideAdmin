// 外壳级：菜单 = 角色 ∩ 环境能力 ∩ 账号 module.*；settings 子项按 module.accounts / module.settings 分辨。
// 会话与环境端点用假服务端替换 fetch，页面路径用 MemoryRouter。
import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import { ShellRoute } from '../src/backoffice/ShellRoute'
import { deferred, employee, installFakeServer, type Reply } from './support/helpdesk-fake'

afterEach(cleanup)

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}</div>
}

function renderShell(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/:locale/sign-in" element={<LocationProbe />} />
        <Route path="/:locale" element={<ShellRoute />}>
          <Route path="*" element={<LocationProbe />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

function serve(options: { features?: string[]; capabilities?: string[] }) {
  const server = installFakeServer()
  server.on('GET', '/api/session', {
    data: {
      employee: employee('ADMIN'),
      sidebarState: 'expanded',
      ...(options.features === undefined ? {} : { features: options.features }),
    },
  })
  server.on('GET', '/api/backoffice/environment', {
    data: {
      label: 'Sandbox',
      versionNumberingMode: 'sandbox',
      ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    },
  })
  return server
}

async function menuKeys(expected: string[]): Promise<string[]> {
  await waitFor(() => {
    const keys = Array.from(document.querySelectorAll('.sidebar [data-menu]')).map(
      (node) => node.getAttribute('data-menu'),
    )
    assert.deepEqual(keys, expected)
  })
  return Array.from(document.querySelectorAll('.sidebar [data-menu]')).map(
    (node) => node.getAttribute('data-menu'),
  )
}

test('旧服务端（session 无 features、环境无 capabilities）：菜单回退角色矩阵，行为不变', async () => {
  const server = serve({})
  try {
    renderShell('/en-GB/course')
    await waitFor(() => assert.ok(screen.getByTestId('location')))
    assert.equal(screen.getByTestId('location').textContent, '/en-GB/course')
    assert.deepEqual(await menuKeys([
      'course',
      'knowledge',
      'aiTutor',
      'order',
      'reporting',
      'student',
      'helpDesk',
      'settings',
    ]), [
      'course',
      'knowledge',
      'aiTutor',
      'order',
      'reporting',
      'student',
      'helpDesk',
      'settings',
    ])
  } finally {
    server.restore()
  }
})

test('裁剪形态 course,accounts：侧栏只剩 Course 与 Settings（账号管理独立能力）', async () => {
  const server = serve({
    features: ['module.course', 'course.view', 'module.accounts'],
    capabilities: ['course', 'accounts'],
  })
  try {
    renderShell('/en-GB/course')
    await waitFor(() => assert.ok(screen.getByTestId('location')))
    assert.deepEqual(await menuKeys(['course', 'settings']), ['course', 'settings'])
  } finally {
    server.restore()
  }
})

test('账号禁止 module.course：直接访问 /course 重定向到仍有权限的模块', async () => {
  const server = serve({
    features: ['module.knowledge'],
    capabilities: ['course', 'knowledge'],
  })
  try {
    renderShell('/en-GB/course')
    await waitFor(() =>
      assert.equal(screen.getByTestId('location').textContent, '/en-GB/knowledge'),
    )
    assert.deepEqual(await menuKeys(['knowledge']), ['knowledge'])
  } finally {
    server.restore()
  }
})

test('账号允许可越过角色 NONE：OPERATION_ADMIN 被授予 module.knowledge 后出现 Knowledge 菜单', async () => {
  const server = installFakeServer()
  server.on('GET', '/api/session', {
    data: {
      // 服务端 effective：角色基线 knowledge=NONE，账号开关 true → VIEW，features 里就有它
      employee: employee('OPERATION_ADMIN'),
      sidebarState: 'expanded',
      features: [
        'module.course',
        'course.view',
        'module.knowledge',
        'module.order',
        'module.reporting',
        'module.students',
        'module.helpdesk',
        'module.settings',
      ],
    },
  })
  server.on('GET', '/api/backoffice/environment', {
    data: { label: 'Sandbox', versionNumberingMode: 'sandbox' },
  })
  try {
    renderShell('/en-GB/knowledge')
    await waitFor(() =>
      assert.equal(screen.getByTestId('location').textContent, '/en-GB/knowledge'),
    )
    assert.deepEqual(
      await menuKeys(['course', 'knowledge', 'order', 'reporting', 'student', 'helpDesk', 'settings']),
      ['course', 'knowledge', 'order', 'reporting', 'student', 'helpDesk', 'settings'],
    )
  } finally {
    server.restore()
  }
})

test('Settings 子项：module.accounts 只开员工账号；其它子项被 module.settings 拦住并回落', async () => {
  const server = serve({
    features: ['module.accounts'],
    capabilities: ['accounts'],
  })
  try {
    renderShell('/en-GB/settings/employee-account')
    await waitFor(() =>
      assert.equal(screen.getByTestId('location').textContent, '/en-GB/settings/employee-account'),
    )
    assert.deepEqual(await menuKeys(['settings']), ['settings'])
    cleanup()
    renderShell('/en-GB/settings/learning-access')
    await waitFor(() =>
      assert.equal(screen.getByTestId('location').textContent, '/en-GB/settings'),
    )
  } finally {
    server.restore()
  }
})

test('初次会话返回 401 时，无需等环境能力便跳转到登录页', async () => {
  const server = serve({})
  const environment = deferred<Reply>()
  server.on('GET', '/api/backoffice/environment', () => environment.promise)
  server.on('GET', '/api/session', { status: 401, error: 'INVALID_EMPLOYEE_ACCOUNT' })
  try {
    renderShell('/zh-CN/course')
    assert.equal((await screen.findByTestId('location')).textContent, '/zh-CN/sign-in')
  } finally {
    cleanup()
    environment.resolve({})
    server.restore()
  }
})

test('初次会话返回 503 时显示重试，重试成功后打开课程外壳', async () => {
  const server = serve({ features: ['module.course', 'course.view'], capabilities: ['course'] })
  let requests = 0
  server.on('GET', '/api/session', () => {
    requests++
    return requests === 1
      ? { status: 503, error: 'INTERNAL_ERROR' }
      : { data: { employee: employee('ADMIN'), features: ['module.course', 'course.view'] } }
  })
  try {
    renderShell('/en-GB/course')
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    assert.equal((await screen.findByTestId('location')).textContent, '/en-GB/course')
    assert.equal(requests, 2)
    assert.deepEqual(await menuKeys(['course']), ['course'])
  } finally {
    server.restore()
  }
})
