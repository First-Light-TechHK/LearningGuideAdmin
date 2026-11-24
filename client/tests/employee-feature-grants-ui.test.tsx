// 功能权限三态开关组件：分组渲染、服务端生效结果、点击只上报不自行判定。
import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { EmployeeFeatureGrants } from '../src/backoffice/components/EmployeeFeatureGrants'
import type { EmployeeFeatureCatalogEntry, FeatureMode } from '../src/backoffice/contracts/employee'

afterEach(cleanup)

const catalog: EmployeeFeatureCatalogEntry[] = [
  { key: 'module.course', group: 'module', sortOrder: 1 },
  { key: 'module.accounts', group: 'module', sortOrder: 2 },
  { key: 'course.edit', group: 'course', sortOrder: 3 },
  { key: 'course.publish', group: 'course', sortOrder: 4 },
]

const draft: Record<string, FeatureMode> = {
  'module.course': 'INHERIT',
  'module.accounts': 'ALLOW',
  'course.edit': 'ALLOW',
  'course.publish': 'DENY',
}

const effective: Record<string, boolean> = {
  'module.course': true,
  'module.accounts': true,
  'course.edit': true,
  'course.publish': false,
}

test('按模块 / 课程动作两组渲染目录，未知 key 显示原始 key 而不丢行', () => {
  render(
    <EmployeeFeatureGrants
      locale="en-GB"
      catalog={[...catalog, { key: 'future.feature', group: 'module', sortOrder: 9 }]}
      draft={{ ...draft, 'future.feature': 'INHERIT' }}
      effective={effective}
      onChange={() => {}}
    />,
  )
  assert.ok(screen.getByText('Modules'))
  assert.ok(screen.getByText('Course actions'))
  assert.ok(screen.getByTestId('feature-row-module.course'))
  assert.ok(screen.getByTestId('feature-row-course.edit'))
  assert.ok(screen.getByTestId('feature-row-future.feature'))
  // 已知 key 用翻译后的名字，不再显示 key 本身
  const row = screen.getByTestId('feature-row-module.accounts')
  assert.ok(within(row).getByText('Account management'))
  assert.equal(within(row).queryByText('module.accounts'), null)
})

test('生效结果来自服务端 effective，不在前端重算三态', () => {
  const view = render(
    <EmployeeFeatureGrants
      locale="en-GB"
      catalog={catalog}
      draft={draft}
      effective={effective}
      onChange={() => {}}
    />,
  )
  assert.equal(screen.getByTestId('feature-effective-module.course').textContent, 'Effective: allowed')
  assert.equal(screen.getByTestId('feature-effective-course.publish').textContent, 'Effective: blocked')
  // effective 缺 key（服务端未给）= 不显示结论，不臆造
  view.rerender(
    <EmployeeFeatureGrants
      locale="en-GB"
      catalog={catalog}
      draft={draft}
      effective={{}}
      onChange={() => {}}
    />,
  )
  assert.equal(screen.queryByTestId('feature-effective-module.course'), null)
})

test('三态开关：当前选中项 aria-checked，点击其它态上报 (key, mode)', () => {
  const changes: Array<[string, FeatureMode]> = []
  render(
    <EmployeeFeatureGrants
      locale="en-GB"
      catalog={catalog}
      draft={draft}
      effective={effective}
      onChange={(key, mode) => changes.push([key, mode])}
    />,
  )
  const row = screen.getByTestId('feature-row-course.publish')
  const radios = within(row).getAllByRole('radio')
  assert.equal(radios.length, 3)
  assert.equal((within(row).getByRole('radio', { name: 'Inherit role' }) as HTMLButtonElement).getAttribute('aria-checked'), 'false')
  assert.equal((within(row).getByRole('radio', { name: 'Deny' }) as HTMLButtonElement).getAttribute('aria-checked'), 'true')
  fireEvent.click(within(row).getByRole('radio', { name: 'Allow' }))
  fireEvent.click(within(row).getByRole('radio', { name: 'Inherit role' }))
  assert.deepEqual(changes, [
    ['course.publish', 'ALLOW'],
    ['course.publish', 'INHERIT'],
  ])
})

test('保存中禁用全部开关', () => {
  render(
    <EmployeeFeatureGrants
      locale="en-GB"
      catalog={catalog}
      draft={draft}
      effective={effective}
      disabled
      onChange={() => {}}
    />,
  )
  for (const radio of screen.getAllByRole('radio')) {
    assert.equal((radio as HTMLButtonElement).disabled, true)
  }
})
