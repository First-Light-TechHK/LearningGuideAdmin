import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { StudentDrawer } from '../src/backoffice/components/StudentDrawer'
import type { StudentDetails } from '../src/backoffice/contracts/students'
import type { Locale } from '../src/backoffice/lib/i18n/config'
import { installFakeServer } from './support/helpdesk-fake'

/**
 * 学生详情抽屉回归：BUG-0357 兴趣标签本地化；BUG-0358/0359 Portal 新契约
 * email.pending（sent:null,pending:true）与 STUDENTS_UNAVAILABLE 后的重新拉取。
 */

afterEach(cleanup)

const PROFILE = {
  country: 'United Kingdom',
  ageRange: '25-34',
  education: "Bachelor's degree",
  interests: ['Humanities', 'Science', 'History', 'Philosophy', 'Mathematics', 'Literature', 'Arts'],
  language: 'en-GB' as const,
}

function details(patch: Partial<StudentDetails> = {}): StudentDetails {
  return {
    id: 'stu-1',
    name: 'Emily Carter',
    email: 'emily@example.com',
    accountStatus: 'active',
    deactivation: null,
    emailVerification: 'verified',
    emailExemption: null,
    emailChange: null,
    registeredAt: '2026-09-01T00:00:00Z',
    profile: PROFILE,
    signInMethods: ['email'],
    hasPassword: true,
    subscriptions: [],
    features: [
      { feature: 'improve_tutor', override: 'default', enabled: false, reason: 'global_off' },
      { feature: 'ai_support_assistant', override: 'default', enabled: true, reason: 'global_on' },
    ],
    overridesVersion: 'v1',
    passwordLink: { available: true, kind: 'reset' },
    ...patch,
  }
}

function renderDrawer(locale: Locale) {
  return render(
    <MemoryRouter initialEntries={[`/${locale}/student`]}>
      <Routes>
        <Route
          path="/:locale/student"
          element={<StudentDrawer studentId="stu-1" canWrite onClose={() => {}} onChanged={() => {}} />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

async function openDrawer(locale: Locale, data: StudentDetails) {
  const server = installFakeServer()
  server.on('GET', '/api/students/stu-1', { data })
  renderDrawer(locale)
  await screen.findByText(data.name)
  return server
}

describe('BUG-0357: the Interests field follows the BackOffice language', () => {
  test('zh-CN shows the Chinese labels instead of the Portal values', async () => {
    const server = await openDrawer(
      'zh-CN',
      details({ profile: { ...PROFILE, interests: ['Humanities', 'Philosophy', 'Computer Science'] } }),
    )
    try {
      assert.ok(await screen.findByText('人文, 哲学, Computer Science'))
    } finally {
      server.restore()
    }
  })

  test('en-GB keeps the Portal values', async () => {
    const server = await openDrawer(
      'en-GB',
      details({ profile: { ...PROFILE, interests: ['Humanities', 'Philosophy'] } }),
    )
    try {
      assert.ok(await screen.findByText('Humanities, Philosophy'))
    } finally {
      server.restore()
    }
  })

  test('zh-CN shows country and education in Chinese, unknown values as stored', async () => {
    const server = await openDrawer(
      'zh-CN',
      details({ profile: { ...PROFILE, country: 'United Kingdom', education: 'Postgraduate' } }),
    )
    try {
      assert.ok(await screen.findByText('英国'))
      assert.ok(screen.getByText('研究生'))
      assert.equal(screen.queryByText('United Kingdom'), null)
    } finally {
      server.restore()
    }
  })

  test('zh-CN shows an unlisted country and education as stored', async () => {
    const server = await openDrawer(
      'zh-CN',
      details({ profile: { ...PROFILE, country: 'Narnia', education: "Bachelor's degree" } }),
    )
    try {
      assert.ok(await screen.findByText('Narnia'))
      assert.ok(screen.getByText("Bachelor's degree"))
    } finally {
      server.restore()
    }
  })
})

describe('BUG-0358/0359: email delivery states from the Portal contract', () => {
  test('zh-CN: a pending password link is reported as accepted, not as sent or failed', async () => {
    const server = await openDrawer('zh-CN', details())
    try {
      server.on('POST', '/api/students/stu-1/actions', {
        data: { student: details(), email: { sent: null, pending: true } },
      })
      fireEvent.click(screen.getByRole('button', { name: '发送重置密码链接' }))
      fireEvent.click(screen.getByRole('button', { name: '发送链接' }))
      const notice = await screen.findByTestId('student-notice')
      assert.equal(notice.textContent, '已受理，邮件正在发送。')
      assert.equal(screen.queryByRole('dialog', { name: '发送重置密码链接' }), null)
    } finally {
      server.restore()
    }
  })

  test('en-GB: a pending verification email after an email change is a neutral notice', async () => {
    const server = await openDrawer('en-GB', details())
    try {
      const changed = details({ email: 'emily.new@example.com', emailVerification: 'pending' })
      server.on('POST', '/api/students/stu-1/actions', {
        data: { student: changed, email: { sent: null, pending: true } },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Edit Email' }))
      fireEvent.change(screen.getByLabelText('New email'), { target: { value: 'emily.new@example.com' } })
      fireEvent.change(screen.getByLabelText('Reason or ticket'), { target: { value: 'Ticket LG-2001' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send verification link' }))
      const notice = await screen.findByTestId('student-notice')
      assert.equal(notice.textContent, 'Request received. The email is being sent.')
      assert.equal(screen.queryByRole('dialog', { name: 'Edit primary email' }), null)
    } finally {
      server.restore()
    }
  })

  test('sent:false still shows the existing "not delivered, resend" notice', async () => {
    const server = await openDrawer('en-GB', details())
    try {
      server.on('POST', '/api/students/stu-1/actions', {
        data: { student: details({ email: 'emily.new@example.com', emailVerification: 'pending' }), email: { sent: false } },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Edit Email' }))
      fireEvent.change(screen.getByLabelText('New email'), { target: { value: 'emily.new@example.com' } })
      fireEvent.change(screen.getByLabelText('Reason or ticket'), { target: { value: 'Ticket LG-2002' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send verification link' }))
      const notice = await screen.findByTestId('student-notice')
      assert.equal(
        notice.textContent,
        'Email changed, but the verification email was not delivered. Use Resend Verification Email.',
      )
    } finally {
      server.restore()
    }
  })

  test('sent:false on a password link is reported as not delivered, not sent', async () => {
    const server = await openDrawer('en-GB', details())
    try {
      server.on('POST', '/api/students/stu-1/actions', {
        data: { student: details(), email: { sent: false } },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Send Password Reset' }))
      fireEvent.click(screen.getByRole('button', { name: 'Send link' }))
      const notice = await screen.findByTestId('student-notice')
      assert.equal(notice.textContent, 'The email was not delivered. Please try again.')
    } finally {
      server.restore()
    }
  })

  test('sent:false on a verification resend is reported as not delivered, not sent', async () => {
    const pending = details({ emailVerification: 'pending' })
    const server = await openDrawer('en-GB', pending)
    try {
      server.on('POST', '/api/students/stu-1/actions', {
        data: { student: pending, email: { sent: false } },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Resend Verification Email' }))
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      const notice = await screen.findByTestId('student-notice')
      assert.equal(notice.textContent, 'The email was not delivered. Please try again.')
    } finally {
      server.restore()
    }
  })

  test('an old server that only sends sent:true keeps the existing copy', async () => {
    const server = await openDrawer('en-GB', details())
    try {
      server.on('POST', '/api/students/stu-1/actions', {
        data: { student: details(), email: { sent: true } },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Send Password Reset' }))
      fireEvent.click(screen.getByRole('button', { name: 'Send link' }))
      const notice = await screen.findByTestId('student-notice')
      assert.equal(notice.textContent, 'Password link sent.')
    } finally {
      server.restore()
    }
  })
})

describe('STUDENTS_UNAVAILABLE: refresh the student before asking for a retry', () => {
  test('the action actually applied: the drawer shows the fresh state and no retry error', async () => {
    const server = installFakeServer()
    let deactivated = false
    try {
      server.on('GET', '/api/students/stu-1', () => ({
        data: deactivated
          ? details({
              accountStatus: 'inactive',
              deactivation: { at: '2026-11-23T10:00:00Z', byName: 'Olive', reason: 'Ticket LG-2003' },
              passwordLink: { available: false, blockedBy: 'inactive' },
            })
          : details(),
      }))
      server.on('POST', '/api/students/stu-1/actions', () => {
        // 动作在 Portal 已生效，但网关在回程超时。
        deactivated = true
        return { status: 504, error: 'STUDENTS_UNAVAILABLE' }
      })
      renderDrawer('en-GB')
      await screen.findByText('Emily Carter')
      fireEvent.click(screen.getByRole('button', { name: 'Deactivate Account' }))
      fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Ticket LG-2003' } })
      fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }))

      const notice = await screen.findByTestId('student-notice')
      assert.equal(notice.textContent, 'The action was applied. The latest details are shown.')
      assert.equal(screen.queryByTestId('modal-confirm'), null, 'the modal closes instead of offering a retry')
      assert.equal(server.callsTo('GET', '/api/students/stu-1').length, 2, 'the detail is refreshed first')
      assert.ok(await screen.findByTestId('student-inactive-banner'))
    } finally {
      server.restore()
    }
  })

  test('an email change that applied is recognised from the refreshed detail', async () => {
    const server = installFakeServer()
    let changed = false
    try {
      server.on('GET', '/api/students/stu-1', () => ({
        data: changed ? details({ email: 'emily.new@example.com', emailVerification: 'pending' }) : details(),
      }))
      server.on('POST', '/api/students/stu-1/actions', () => {
        changed = true
        return { status: 504, error: 'STUDENTS_UNAVAILABLE' }
      })
      renderDrawer('en-GB')
      await screen.findByText('Emily Carter')
      fireEvent.click(screen.getByRole('button', { name: 'Edit Email' }))
      fireEvent.change(screen.getByLabelText('New email'), { target: { value: 'emily.new@example.com' } })
      fireEvent.change(screen.getByLabelText('Reason or ticket'), { target: { value: 'Ticket LG-2005' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send verification link' }))

      const notice = await screen.findByTestId('student-notice')
      assert.equal(notice.textContent, 'The action was applied. The latest details are shown.')
      assert.equal(screen.queryByTestId('modal-confirm'), null)
      assert.equal(server.callsTo('GET', '/api/students/stu-1').length, 2)
      assert.ok(await screen.findAllByText('emily.new@example.com'))
    } finally {
      server.restore()
    }
  })

  test('the action did not apply: refresh first, then keep the retry prompt', async () => {    const server = installFakeServer()
    try {
      server.on('GET', '/api/students/stu-1', { data: details() })
      server.on('POST', '/api/students/stu-1/actions', { status: 504, error: 'STUDENTS_UNAVAILABLE' })
      renderDrawer('en-GB')
      await screen.findByText('Emily Carter')
      fireEvent.click(screen.getByRole('button', { name: 'Deactivate Account' }))
      fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Ticket LG-2004' } })
      fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }))

      const alert = await screen.findByRole('alert')
      assert.equal(alert.textContent, 'Portal did not answer. Try again.')
      assert.equal(server.callsTo('GET', '/api/students/stu-1').length, 2, 'the detail is refreshed first')
      await waitFor(() => assert.ok(screen.getByTestId('modal-confirm')))
    } finally {
      server.restore()
    }
  })
})
