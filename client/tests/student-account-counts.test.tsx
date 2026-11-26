import './support/dom'
import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { cleanup, render, screen } from '@testing-library/react'
import { StudentAccountCounts } from '../src/backoffice/components/StudentAccountCounts'
afterEach(cleanup)
test('shows global account totals with localized labels', () => {
  render(<StudentAccountCounts locale="en-GB" counts={{total: 6, active: 5, inactive: 1}} />)
  assert.match(screen.getByTestId('student-account-counts').textContent ?? '', /Total Students\s*6/)
  assert.match(screen.getByTestId('student-account-counts').textContent ?? '', /Active Accounts\s*5/)
  assert.match(screen.getByTestId('student-account-counts').textContent ?? '', /Inactive Accounts\s*1/)
})
test('shows the same totals with Chinese labels', () => {
  render(<StudentAccountCounts locale="zh-CN" counts={{total: 2, active: 1, inactive: 1}} />)
  const text = screen.getByTestId('student-account-counts').textContent ?? ''
  assert.match(text, /学生总数\s*2/)
  assert.match(text, /启用账号\s*1/)
})
