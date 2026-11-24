// 编辑抽屉整链路：打开编辑 → GET 功能目录 → 三态修改 → 保存时账号 PATCH + 功能 PUT（只发显式开关）。
import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { EmployeeAccountClient } from '../src/backoffice/pages/EmployeeAccountPage'
import type { EmployeeFeatures, EmployeeListItem } from '../src/backoffice/contracts/employee'
import { installFakeServer } from './support/helpdesk-fake'

afterEach(cleanup)

const rowEmployee: EmployeeListItem = {
  employeeId: 'emp-1',
  loginEmail: 'maker@example.com',
  role: 'GRAPHIC_DESIGNER',
  accountStatus: 'ACTIVE',
  emailVerification: 'VERIFIED',
  displayStatus: 'Active',
  lastLoginAt: null,
  isBootstrapAdmin: false,
}

function featuresView(): EmployeeFeatures {
  return {
    employeeId: 'emp-1',
    catalog: [
      { key: 'module.course', group: 'module', sortOrder: 10 },
      { key: 'module.accounts', group: 'module', sortOrder: 20 },
      { key: 'course.edit', group: 'course', sortOrder: 10 },
    ],
    grants: [{ feature: 'course.edit', allowed: true }],
    effective: [
      { key: 'module.course', allowed: true, level: 'EDIT' },
      { key: 'module.accounts', allowed: false, level: 'NONE' },
      { key: 'course.edit', allowed: true, level: null },
    ],
  }
}

test('保存：账号 PATCH 与功能 PUT 一起发出，继承项省略、允许/禁止显式发送', async () => {
  const server = installFakeServer()
  server.on('GET', /^\/api\/admin\/employees$/, {
    data: { items: [rowEmployee], total: 1, page: 1, pageSize: 10 },
  })
  server.on('GET', '/api/admin/employees/emp-1/features', { data: featuresView() })
  server.on('PATCH', '/api/admin/employees/emp-1', {
    data: { employee: rowEmployee, delivery: null, manualLink: null },
  })
  server.on('PUT', '/api/admin/employees/emp-1/features', { data: featuresView() })
  try {
    render(<EmployeeAccountClient locale="en-GB" />)

    // 列表 → 行操作 → 编辑
    await waitFor(() => screen.getByText('maker@example.com'))
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))

    // 功能权限从服务端加载：继承/允许/禁止三态与生效结果
    await waitFor(() => assert.ok(screen.getByTestId('feature-row-module.course')))
    const courseRow = screen.getByTestId('feature-row-module.course')
    assert.equal(
      (within(courseRow).getByRole('radio', { name: 'Inherit role' }) as HTMLButtonElement).getAttribute('aria-checked'),
      'true',
    )
    assert.equal(screen.getByTestId('feature-effective-module.accounts').textContent, 'Effective: blocked')

    // 修改：module.course 继承 → 允许；course.edit 允许 → 禁止
    fireEvent.click(within(courseRow).getByRole('radio', { name: 'Allow' }))
    const editRow = screen.getByTestId('feature-row-course.edit')
    fireEvent.click(within(editRow).getByRole('radio', { name: 'Deny' }))

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() =>
      assert.equal(server.callsTo('PUT', '/api/admin/employees/emp-1/features').length, 1),
    )
    assert.equal(server.callsTo('PATCH', '/api/admin/employees/emp-1').length, 1)
    const put = server.callsTo('PUT', '/api/admin/employees/emp-1/features')[0]
    assert.deepEqual(put.body, {
      grants: [
        { feature: 'module.course', allowed: true },
        { feature: 'course.edit', allowed: false },
      ],
    })
    // 保存后抽屉关闭、列表刷新
    await waitFor(() => assert.equal(screen.queryByTestId('feature-row-module.course'), null))
    assert.ok(server.callsTo('GET', /^\/api\/admin\/employees$/).length >= 2)
  } finally {
    server.restore()
  }
})

test('功能目录读取失败：走既有错误提示，账号仍可单独保存（不发 PUT）', async () => {
  const server = installFakeServer()
  server.on('GET', /^\/api\/admin\/employees$/, {
    data: { items: [rowEmployee], total: 1, page: 1, pageSize: 10 },
  })
  server.on('GET', '/api/admin/employees/emp-1/features', { error: 'INTERNAL_ERROR' })
  server.on('PATCH', '/api/admin/employees/emp-1', {
    data: { employee: rowEmployee, delivery: null, manualLink: null },
  })
  try {
    render(<EmployeeAccountClient locale="en-GB" />)
    await waitFor(() => screen.getByText('maker@example.com'))
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))

    await waitFor(() => assert.ok(screen.getByTestId('employee-feature-grants-error')))
    assert.ok(screen.getAllByText('Something went wrong. Please try again.').length >= 1)
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => assert.equal(server.callsTo('PATCH', '/api/admin/employees/emp-1').length, 1))
    assert.equal(server.callsTo('PUT', '/api/admin/employees/emp-1/features').length, 0)
  } finally {
    server.restore()
  }
})
