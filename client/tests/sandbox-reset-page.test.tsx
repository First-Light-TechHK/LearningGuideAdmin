// Sandbox Reset 页面：影响面、确认短语/原因/范围校验、二次确认、作业进度、不可用兜底。
import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { EmployeeContext } from '../src/backoffice/employeeSession'
import { SandboxResetPage } from '../src/backoffice/pages/SandboxResetPage'
import { rememberEnvironment } from '../src/backoffice/lib/capabilities'
import { visibleSettingsSubs } from '../src/backoffice/rbac/permissions'
import { employee, installFakeServer } from './support/helpdesk-fake'

afterEach(() => {
  cleanup()
  rememberEnvironment(null)
})

function impact() {
  return { courses: 3, versions: 7, mediaAssets: 5, mediaBytes: 2048, packageJobs: 2 }
}

function job(status: string, stage: string | null = null, progress = 0) {
  return {
    jobId: 'job-1',
    status,
    stage,
    progress,
    error: null,
    scope: {},
    report: null,
  }
}

function renderPage() {
  return render(
    <EmployeeContext.Provider value={employee('ADMIN')}>
      <MemoryRouter>
        <SandboxResetPage />
      </MemoryRouter>
    </EmployeeContext.Provider>,
  )
}

test('shows the impact and keeps Reset disabled until phrase and reason are filled', async () => {
  rememberEnvironment({ capabilities: ['settings', 'accounts'], sandboxResetEnabled: true })
  const server = installFakeServer()
  server.on('GET', '/api/backoffice/sandbox/reset', {
    data: { enabled: true, environment: 'SANDBOX', activeJob: null, impact: impact() },
  })
  try {
    renderPage()
    await waitFor(() => assert.ok(screen.getByTestId('sandbox-reset-impact')))
    assert.ok(screen.getByText('3 courses (including drafts and archived)'))
    assert.ok(screen.getByText('5 course media files (2 KB)'))

    const start = screen.getByTestId('sandbox-reset-start') as HTMLButtonElement
    assert.equal(start.disabled, true)

    fireEvent.change(screen.getByTestId('sandbox-reset-confirm-input'), {
      target: { value: 'RESET SANDBOX' },
    })
    fireEvent.change(screen.getByTestId('sandbox-reset-reason'), {
      target: { value: 'fresh import' },
    })
    await waitFor(() => assert.equal(start.disabled, false))
  } finally {
    server.restore()
  }
})

test('requires a second confirmation before posting the reset request', async () => {
  rememberEnvironment({ capabilities: ['settings', 'accounts'], sandboxResetEnabled: true })
  const server = installFakeServer()
  server.on('GET', '/api/backoffice/sandbox/reset', {
    data: { enabled: true, environment: 'SANDBOX', activeJob: null, impact: impact() },
  })
  server.on('POST', '/api/backoffice/sandbox/reset', { data: job('QUEUED') })
  try {
    renderPage()
    await waitFor(() => assert.ok(screen.getByTestId('sandbox-reset-impact')))

    fireEvent.change(screen.getByTestId('sandbox-reset-confirm-input'), {
      target: { value: 'RESET SANDBOX' },
    })
    fireEvent.change(screen.getByTestId('sandbox-reset-reason'), {
      target: { value: 'fresh import' },
    })
    const start = screen.getByTestId('sandbox-reset-start') as HTMLButtonElement
    await waitFor(() => assert.equal(start.disabled, false))
    fireEvent.click(start)

    // 第一次点击只打开确认面板，不发送请求
    await waitFor(() => assert.ok(screen.getByTestId('sandbox-reset-confirm-panel')))
    assert.equal(server.callsTo('POST', '/api/backoffice/sandbox/reset').length, 0)

    fireEvent.click(screen.getByTestId('sandbox-reset-confirm'))

    await waitFor(() =>
      assert.equal(server.callsTo('POST', '/api/backoffice/sandbox/reset').length, 1),
    )
    const call = server.callsTo('POST', '/api/backoffice/sandbox/reset')[0]
    assert.deepEqual(call.body, {
      confirm: 'RESET SANDBOX',
      reason: 'fresh import',
      scope: {
        courses: true,
        media: true,
        staging: true,
        packageJobs: true,
        resetCodeCounters: true,
      },
    })
    await waitFor(() => assert.ok(screen.getByTestId('sandbox-reset-progress')))
  } finally {
    server.restore()
  }
})

test('shows an unavailable card when the endpoint rejects the environment', async () => {
  rememberEnvironment(null)
  const server = installFakeServer()
  server.on('GET', '/api/backoffice/sandbox/reset', {
    status: 403,
    error: 'SANDBOX_RESET_DISABLED',
  })
  try {
    renderPage()
    await waitFor(() => assert.ok(screen.getByTestId('sandbox-reset-unavailable')))
    assert.ok(
      screen.getByText('Sandbox reset is not available in this environment.'),
    )
  } finally {
    server.restore()
  }
})

test('Settings sub-navigation only lists Sandbox Reset for an enabled sandbox ADMIN', () => {
  const capabilities = new Set(['settings', 'accounts'])
  const features = new Set(['module.settings'])
  assert.ok(visibleSettingsSubs('ADMIN', capabilities, features, true).includes('sandboxReset'))
  assert.equal(
    visibleSettingsSubs('ADMIN', capabilities, features, false).includes('sandboxReset'),
    false,
  )
  assert.equal(
    visibleSettingsSubs('OPERATION_ADMIN', capabilities, features, true).includes('sandboxReset'),
    false,
  )
})
