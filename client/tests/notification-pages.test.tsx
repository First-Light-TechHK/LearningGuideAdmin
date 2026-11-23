import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import type {
  NotificationBroadcast,
  NotificationTemplate,
} from '../src/backoffice/contracts/notifications'
import { EmployeeContext } from '../src/backoffice/employeeSession'
import { BroadcastsTab, BroadcastEditor } from '../src/backoffice/pages/notification/BroadcastsTab'
import { NotificationEditor, SystemNotificationsTab } from '../src/backoffice/pages/notification/SystemNotificationsTab'
import { SendLogTab } from '../src/backoffice/pages/notification/SendLogTab'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  cleanup()
})

const employee = {
  employeeId: 'emp-1',
  loginEmail: 'jack@example.com',
  role: 'ADMIN' as const,
  displayName: 'Jack',
  accountStatus: 'ACTIVE' as const,
  emailVerification: 'VERIFIED' as const,
  displayStatus: 'Active' as const,
  isBootstrapAdmin: false,
}

function ok<T>(data: T) {
  return Promise.resolve(
    new Response(JSON.stringify({ success: true, data, error: null, message: 'OK' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

function template(overrides: Partial<NotificationTemplate> = {}): NotificationTemplate {
  return {
    id: 'SUB_RENEWAL_REMINDER',
    category: 'subscription',
    channels: ['in_app', 'email'],
    locked: true,
    enabled: true,
    triggerText: '5 days before the period ends',
    recipientText: 'The subscriber',
    sendsText: 'Once per billing period',
    buttonLink: '{{app_url}}/my-learning/subscription',
    en: {
      title: 'Your subscription renews soon',
      message: 'Your {{plan_name}} renews for {{renewal_amount}}.',
      buttonText: 'Manage subscription',
      subject: 'Renews soon',
      emailBody: 'Hi {{user_name}}',
      emailButtonText: 'Manage subscription',
    },
    zh: {
      title: '你的订阅即将续费',
      message: '你的{{plan_name}}将续费 {{renewal_amount}}。',
      buttonText: '管理订阅',
      subject: '即将续费',
      emailBody: '你好 {{user_name}}',
      emailButtonText: '管理订阅',
    },
    updatedAt: '2026-11-02T06:20:00.000Z',
    updatedBy: 'Jack',
    variables: ['plan_name', 'renewal_amount', 'renewal_date', 'user_name'],
    ...overrides,
  }
}

function broadcast(overrides: Partial<NotificationBroadcast> = {}): NotificationBroadcast {
  return {
    id: 'b1',
    titleEn: 'Scheduled maintenance on 15 Nov',
    bodyEn: 'Tonight',
    titleZh: '计划维护',
    bodyZh: '今晚',
    buttonText: null,
    buttonLink: null,
    audience: 'all',
    status: 'sent',
    createdBy: 'Jack',
    createdAt: '2026-10-30T02:00:00.000Z',
    sentAt: '2026-10-30T02:00:00.000Z',
    withdrawnAt: null,
    withdrawnBy: null,
    recipients: 12480,
    read: 5117,
    rate: 0.41,
    ...overrides,
  }
}

test('system notification list renders groups, language tags, locked and editable switches (B01)', () => {
  const templates: NotificationTemplate[] = [
    template(),
    template({
      id: 'SUB_RENEWAL_FAILED',
      en: { ...template().en, title: 'Renewal payment failed' },
      zh: { title: '续费支付失败' },
    }),
    template({
      id: 'HELPDESK_TICKET_REPLIED',
      category: 'support',
      locked: false,
      channels: ['in_app'],
      en: { title: 'New reply', message: 'Reply', buttonText: 'View' },
      zh: { title: '新回复', message: '回复', buttonText: '查看' },
      variables: ['ticket_subject', 'ticket_link'],
    }),
  ]
  const edited: string[] = []
  render(
    <MemoryRouter>
      <SystemNotificationsTab
        templates={templates}
        loading={false}
        errorMessage={null}
        onReload={() => {}}
        onEdit={(id) => edited.push(id)}
      />
    </MemoryRouter>,
  )

  assert.ok(screen.getByText('SUBSCRIPTION · 2'))
  assert.ok(screen.getByText('SUPPORT · 1'))
  const missing = screen.getAllByText('中文 missing')
  assert.equal(missing.length, 1)
  assert.ok(screen.getByTestId('language-tag-SUB_RENEWAL_FAILED'))

  const locked = screen.getAllByRole('switch')[0] as HTMLButtonElement
  assert.equal(locked.disabled, true)
  const editable = screen.getAllByRole('switch')[2] as HTMLButtonElement
  assert.equal(editable.disabled, false)

  fireEvent.click(screen.getByTestId('notification-edit-HELPDESK_TICKET_REPLIED'))
  assert.deepEqual(edited, ['HELPDESK_TICKET_REPLIED'])
})

test('turning an optional notification off asks for confirmation first (NTF-BO-005)', async () => {
  let writes = 0
  globalThis.fetch = (() => {
    writes += 1
    return ok({ ok: true, template: {} })
  }) as typeof fetch
  render(
    <MemoryRouter>
      <SystemNotificationsTab
        templates={[
          template({
            id: 'COURSE_NEW_LAUNCH',
            category: 'course',
            locked: false,
            channels: ['in_app'],
            en: { title: 'New course', message: 'A course', buttonText: 'View' },
            zh: { title: '新课程', message: '课程', buttonText: '查看' },
            variables: ['course_title', 'category_name'],
          }),
        ]}
        loading={false}
        errorMessage={null}
        onReload={() => {}}
        onEdit={() => {}}
      />
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('switch'))
  assert.ok(screen.getByText('Turn off this notification?'))
  assert.equal(writes, 0)
  fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
  await waitFor(() => assert.equal(writes, 1))
})

test('editor previews sample data and blocks an unknown variable before any request (B02/B03)', async () => {
  let calls = 0
  globalThis.fetch = (() => {
    calls += 1
    return ok({ ok: true })
  }) as typeof fetch
  render(
    <MemoryRouter>
      <EmployeeContext.Provider value={employee}>
        <NotificationEditor
          template={template()}
          onBack={() => {}}
          onReload={() => {}}
          onSaved={() => {}}
        />
      </EmployeeContext.Provider>
    </MemoryRouter>,
  )

  const preview = screen.getByTestId('notification-preview')
  assert.ok(within(preview).getAllByText(/Everything · 12 months/).length > 0)
  assert.ok(within(preview).getAllByText(/US\$149\.00/).length > 0)

  const message = screen.getByDisplayValue(template().en.message ?? '')
  fireEvent.change(message, { target: { value: 'Payment {{amount_due}} failed' } })
  fireEvent.click(screen.getByTestId('notification-save'))

  await waitFor(() =>
    assert.ok(screen.getByText(/Use \{\{renewal_amount\}\} instead/)),
  )
  assert.equal(calls, 0)
})

test('broadcast list shows status-specific actions and read rate (B04)', async () => {
  globalThis.fetch = (() =>
    ok({
      ok: true,
      broadcasts: [
        broadcast(),
        broadcast({ id: 'b2', titleEn: 'Help us improve', status: 'draft', sentAt: null, recipients: 0, read: 0, rate: 0 }),
        broadcast({
          id: 'b3',
          titleEn: 'Holiday support hours',
          status: 'withdrawn',
          withdrawnAt: '2026-10-01T02:15:00.000Z',
          withdrawnBy: 'Mia Chen',
        }),
      ],
      total: 3,
      page: 1,
      pageSize: 20,
    })) as typeof fetch
  render(
    <MemoryRouter>
      <BroadcastsTab refreshKey={0} onNew={() => {}} onEdit={() => {}} />
    </MemoryRouter>,
  )

  assert.ok(await screen.findByText('Scheduled maintenance on 15 Nov'))
  const sentRow = screen.getByTestId('broadcast-row-b1')
  assert.ok(within(sentRow).getByText('41% read'))
  assert.ok(within(sentRow).getByText('Withdraw'))
  const draftRow = screen.getByTestId('broadcast-row-b2')
  assert.ok(within(draftRow).getByText('Delete'))
  assert.equal(within(draftRow).queryByText('Withdraw'), null)
  const withdrawnRow = screen.getByTestId('broadcast-row-b3')
  assert.equal(within(withdrawnRow).queryByText('Withdraw'), null)
})

test('new broadcast validates the button pair and shows an announcement preview (B05)', () => {
  globalThis.fetch = (() => ok({ ok: true, all: 12500, paid: 3200 })) as typeof fetch
  render(
    <MemoryRouter>
      <BroadcastEditor onBack={() => {}} onSaved={() => {}} />
    </MemoryRouter>,
  )
  fireEvent.change(screen.getByPlaceholderText('e.g. Learn more'), {
    target: { value: 'Details' },
  })
  fireEvent.click(screen.getByTestId('broadcast-send-now'))
  assert.ok(screen.getByText('Button text and button link must be provided together.'))
  assert.equal(screen.queryByText('Send this broadcast now?'), null)
})

test('send log renders statuses, failure reasons, Test tags and filters (B06)', async () => {
  let requested = ''
  globalThis.fetch = ((url: string) => {
    requested = String(url)
    return ok({
      ok: true,
      items: [
        {
          id: 'log-1',
          occurredAt: '2026-11-02T02:00:00.000Z',
          recipientEmail: 'margaret.h@gmail.com',
          recipientName: 'Margaret Hughes',
          notificationId: 'n1',
          templateId: 'SUB_RENEWAL_REMINDER',
          broadcastId: null,
          notificationName: 'Renewal reminder (D-5) · SUB_RENEWAL_REMINDER',
          channel: 'email',
          status: 'delivered',
          failureReason: null,
          isTest: false,
          related: null,
        },
        {
          id: 'log-2',
          occurredAt: '2026-11-02T01:41:00.000Z',
          recipientEmail: 'd.lee@outlook.com',
          recipientName: 'David Lee',
          notificationId: 'n2',
          templateId: 'SUB_RENEWAL_FAILED',
          broadcastId: null,
          notificationName: 'Renewal payment failed · SUB_RENEWAL_FAILED',
          channel: 'email',
          status: 'failed',
          failureReason: 'Bounced: mailbox not found',
          isTest: true,
          related: 'subscription:s1',
        },
      ],
      total: 2,
      page: 1,
      pageSize: 20,
    })
  }) as typeof fetch
  render(
    <MemoryRouter>
      <SendLogTab templates={[template()]} broadcasts={[]} />
    </MemoryRouter>,
  )

  assert.ok(await screen.findByText('margaret.h@gmail.com'))
  assert.ok(screen.getAllByText('Delivered').length > 0)
  assert.ok(screen.getAllByText('Failed').length > 0)
  assert.ok(screen.getByText('Bounced: mailbox not found'))
  assert.ok(screen.getByText('Test'))
  assert.match(requested, /send-log\?/)
  assert.match(requested, /from=\d{4}-\d{2}-\d{2}/)
  assert.match(requested, /to=\d{4}-\d{2}-\d{2}/)
})

type Recorded = { method: string; url: string; body: Record<string, unknown> | null }

function recordFetch(answer: (request: Recorded) => Response | Promise<Response>): Recorded[] {
  const requests: Recorded[] = []
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const request = {
      method: init?.method ?? 'GET',
      url: String(url),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    }
    requests.push(request)
    return Promise.resolve(answer(request))
  }) as typeof fetch
  return requests
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const okBody = (data: unknown) => json(200, { success: true, data, error: null, message: 'OK' })

async function sendEditedDraft() {
  render(
    <MemoryRouter>
      <BroadcastEditor
        broadcast={broadcast({ id: 'b2', status: 'draft', sentAt: null })}
        onBack={() => {}}
        onSaved={() => {}}
      />
    </MemoryRouter>,
  )
  fireEvent.change(screen.getByDisplayValue('Scheduled maintenance on 15 Nov'), {
    target: { value: 'Edited maintenance notice' },
  })
  fireEvent.click(screen.getByTestId('broadcast-send-now'))
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Send now' }))
}

test('Send now saves the edited draft first, then sends (REV-15)', async () => {
  const requests = recordFetch((request) =>
    request.method === 'GET' ? okBody({ all: 12500, paid: 3200 }) : okBody({ ok: true, recipients: 12500 }),
  )
  await sendEditedDraft()
  await waitFor(() => assert.equal(requests.filter((r) => r.method === 'PATCH').length, 2))
  const writes = requests.filter((r) => r.method === 'PATCH')
  assert.match(writes[0].url, /broadcasts\/b2$/)
  assert.equal(writes[0].body?.action, 'update')
  assert.equal(writes[0].body?.titleEn, 'Edited maintenance notice')
  assert.deepEqual(writes[1].body, { action: 'send' })
})

test('Send now does not send when saving the draft fails', async () => {
  const requests = recordFetch((request) =>
    request.method === 'GET'
      ? okBody({ all: 12500, paid: 3200 })
      : json(400, { success: false, data: null, error: { code: 'INVALID_INPUT', message: 'Title is too long.' } }),
  )
  await sendEditedDraft()
  assert.ok(await screen.findByText('Title is too long.'))
  assert.equal(requests.filter((r) => r.method === 'PATCH' && r.body?.action === 'send').length, 0)
  assert.equal(screen.queryByRole('dialog'), null)
})

test('Send now on a new broadcast creates the draft, then sends', async () => {
  const requests = recordFetch((request) => {
    if (request.method === 'GET') return okBody({ all: 12500, paid: 3200 })
    if (request.method === 'POST') return okBody({ ok: true, broadcast: { id: 'new-1' } })
    return okBody({ ok: true, recipients: 12500 })
  })
  render(
    <MemoryRouter>
      <BroadcastEditor onBack={() => {}} onSaved={() => {}} />
    </MemoryRouter>,
  )
  const inputs = screen.getAllByRole('textbox')
  fireEvent.change(inputs[0], { target: { value: 'Hello' } })
  fireEvent.change(inputs[1], { target: { value: 'World' } })
  fireEvent.click(screen.getByTestId('broadcast-send-now'))
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Send now' }))
  await waitFor(() => assert.equal(requests.filter((r) => r.method === 'PATCH').length, 1))
  const writes = requests.filter((r) => r.method !== 'GET')
  assert.deepEqual(writes.map((r) => r.method), ['POST', 'PATCH'])
  assert.match(writes[1].url, /broadcasts\/new-1$/)
  assert.deepEqual(writes[1].body, { action: 'send' })
})

test('the broadcast editor has no "Send test to me" control (NTF-BC-014 not delivered in P0)', () => {
  globalThis.fetch = (() => ok({ ok: true, all: 1, paid: 1 })) as typeof fetch
  render(
    <MemoryRouter>
      <BroadcastEditor onBack={() => {}} onSaved={() => {}} />
    </MemoryRouter>,
  )
  assert.equal(screen.queryByRole('button', { name: /Send test|发送测试/ }), null)
  assert.ok(screen.getByRole('button', { name: 'Send now' }))
})
