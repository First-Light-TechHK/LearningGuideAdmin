import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

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

/** The broadcast editor reads the signed-in operator (Send test to me). */
function BroadcastEditorAsAdmin(props: React.ComponentProps<typeof BroadcastEditor>) {
  return (
    <EmployeeContext.Provider value={employee}>
      <BroadcastEditor {...props} />
    </EmployeeContext.Provider>
  )
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
  // a withdrawn row shows who withdrew it, a dash for recipients, and no read rate or language line
  assert.ok(within(withdrawnRow).getByText(/Withdrawn .* by Mia Chen/))
  assert.ok(within(withdrawnRow).getByText('—'))
  assert.equal(within(withdrawnRow).queryByText(/read$/), null)
  assert.equal(within(withdrawnRow).queryByText(/EN · |EN only/), null)
})

test('system notification rows use the fixed catalogue name when the Portal sends one (B01)', () => {
  render(
    <MemoryRouter>
      <SystemNotificationsTab
        templates={[template({ name: 'Renewal reminder (D-5)' })]}
        loading={false}
        errorMessage={null}
        onReload={() => {}}
        onEdit={() => {}}
      />
    </MemoryRouter>,
  )
  const row = screen.getByTestId('notification-row-SUB_RENEWAL_REMINDER')
  assert.ok(within(row).getByText('Renewal reminder (D-5)'))
  assert.equal(within(row).queryByText('Your subscription renews soon'), null)
  // five columns, Edit lives in the status cell
  assert.equal(row.querySelectorAll('td').length, 5)
  assert.ok(row.querySelector('.notificationStatusCell [data-testid="notification-edit-SUB_RENEWAL_REMINDER"]'))
})

test('group headings follow the interface language (A-11)', () => {
  render(
    <MemoryRouter initialEntries={['/zh-CN/x']}>
      <Routes>
        <Route
          path="/:locale/x"
          element={
            <SystemNotificationsTab templates={[template()]} loading={false} errorMessage={null} onReload={() => {}} onEdit={() => {}} />
          }
        />
      </Routes>
    </MemoryRouter>,
  )
  assert.ok(screen.getByText('订阅 · 1'))
})

test('the broadcast preview has no sample-values note, the system preview has one (B05)', () => {
  globalThis.fetch = (() => ok({ ok: true, all: 1, paid: 1 })) as typeof fetch
  const { unmount } = render(
    <MemoryRouter>
      <BroadcastEditorAsAdmin onBack={() => {}} onSaved={() => {}} />
    </MemoryRouter>,
  )
  const preview = screen.getByTestId('notification-preview')
  assert.equal(within(preview).queryByText(/Sample values/), null)
  assert.ok(within(preview).getByText('As learners will see it'))
  unmount()
  render(
    <MemoryRouter>
      <EmployeeContext.Provider value={employee}>
        <NotificationEditor template={template()} onBack={() => {}} onReload={() => {}} onSaved={() => {}} />
      </EmployeeContext.Provider>
    </MemoryRouter>,
  )
  assert.ok(within(screen.getByTestId('notification-preview')).getByText(/Sample values/))
})

test('new broadcast validates the button pair and shows an announcement preview (B05)', () => {
  globalThis.fetch = (() => ok({ ok: true, all: 12500, paid: 3200 })) as typeof fetch
  render(
    <MemoryRouter>
      <BroadcastEditorAsAdmin onBack={() => {}} onSaved={() => {}} />
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
          notificationName: 'Renewal reminder (D-5)',
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
          notificationName: 'Renewal payment failed',
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
  // Delivered is neutral, only Read is green (A-07)
  const delivered = within(screen.getByTestId('send-log-row-log-1')).getByText('Delivered')
  assert.ok(delivered.className.includes('notificationStatusDelivered'))
  assert.ok(!delivered.className.includes('notificationStatusOk'))
  assert.ok(screen.getAllByText('Failed').length > 0)
  assert.ok(screen.getByText('Bounced: mailbox not found'))
  assert.ok(screen.getByText('Test'))
  // name and template ID are separate elements (NTF-LOG-002); the Test tag sits on the name line
  const nameLine = screen.getByText('Renewal reminder (D-5)').parentElement as HTMLElement
  assert.equal(nameLine.querySelector('.smPill'), null)
  assert.equal(nameLine.nextElementSibling?.textContent, 'SUB_RENEWAL_REMINDER')
  const testLine = screen.getByText('Renewal payment failed').parentElement as HTMLElement
  assert.equal(within(testLine).getByText('Test').closest('div'), testLine)
  assert.match(requested, /send-log\?/)
  assert.match(requested, /from=\d{4}-\d{2}-\d{2}/)
  assert.match(requested, /to=\d{4}-\d{2}-\d{2}/)
})

test('editor heading and breadcrumb keep the fixed name when the English title changes (A-02)', () => {
  globalThis.fetch = (() => ok({ ok: true })) as typeof fetch
  render(
    <MemoryRouter>
      <EmployeeContext.Provider value={employee}>
        <NotificationEditor
          template={template({ name: 'Renewal reminder (D-5)' })}
          onBack={() => {}}
          onReload={() => {}}
          onSaved={() => {}}
        />
      </EmployeeContext.Provider>
    </MemoryRouter>,
  )
  fireEvent.change(screen.getByDisplayValue('Your subscription renews soon'), { target: { value: 'Renews very soon' } })
  const heading = screen.getByRole('heading', { level: 1 })
  assert.equal(heading.textContent, 'Renewal reminder (D-5)')
  assert.ok(heading.closest('[data-testid="notification-editor"]')?.querySelector('.notificationBreadcrumb')?.textContent?.includes('Renewal reminder (D-5)'))
})

test('send log drawer is translated and separates its details with a dot in Chinese (A-03)', async () => {
  const entry = {
    id: 'log-1',
    occurredAt: '2026-11-02T02:00:00.000Z',
    recipientEmail: 'margaret.h@gmail.com',
    recipientName: 'Margaret Hughes',
    notificationId: 'n1',
    templateId: 'SUB_RENEWAL_REMINDER',
    broadcastId: null,
    notificationName: 'Renewal reminder (D-5)',
    channel: 'in_app',
    status: 'read',
    failureReason: null,
    isTest: false,
    related: null,
  }
  globalThis.fetch = ((url: string) =>
    String(url).includes('send-log/log-1')
      ? ok({
          ok: true,
          entry,
          message: {
            notificationId: 'n1',
            title: 'Renews soon',
            body: 'Body',
            buttonText: null,
            buttonLink: null,
            language: 'en',
            category: 'subscription',
            createdAt: '2026-11-02T02:00:00.000Z',
            readAt: '2026-11-02T03:00:00.000Z',
            withdrawnAt: null,
          },
          timeline: [],
          isTest: false,
        })
      : ok({ ok: true, items: [entry], total: 1, page: 1, pageSize: 20 })) as typeof fetch
  render(
    <MemoryRouter initialEntries={['/zh-CN/log']}>
      <Routes>
        <Route path="/:locale/log" element={<SendLogTab templates={[template()]} broadcasts={[]} />} />
      </Routes>
    </MemoryRouter>,
  )
  fireEvent.click(await screen.findByText('查看'))
  const drawer = await screen.findByRole('dialog', { name: '发送日志详情' })
  assert.ok(within(drawer).getByText('详情'))
  assert.ok(within(drawer).getByText(/^语言: English · 订阅 · 已读于 /))
  assert.equal(within(drawer).queryByText('Details'), null)
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
      <BroadcastEditorAsAdmin
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
      <BroadcastEditorAsAdmin onBack={() => {}} onSaved={() => {}} />
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

test('Send now frees the buttons when the saved draft comes back without an id (A-13)', async () => {
  const requests = recordFetch((request) =>
    request.method === 'GET' ? okBody({ all: 12500, paid: 3200 }) : okBody({ ok: true }),
  )
  render(
    <MemoryRouter>
      <BroadcastEditorAsAdmin onBack={() => {}} onSaved={() => {}} />
    </MemoryRouter>,
  )
  const inputs = screen.getAllByRole('textbox')
  fireEvent.change(inputs[0], { target: { value: 'Hello' } })
  fireEvent.change(inputs[1], { target: { value: 'World' } })
  fireEvent.click(screen.getByTestId('broadcast-send-now'))
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Send now' }))
  await waitFor(() => assert.ok(screen.queryByRole('dialog') === null))
  assert.equal(requests.filter((r) => r.method === 'PATCH').length, 0)
  assert.equal((screen.getByTestId('broadcast-send-now') as HTMLButtonElement).disabled, false)
})

test('"Send test to me" sends the on-screen content without saving, and says who got it (NTF-BC-014)', async () => {
  const requests = recordFetch((request) =>
    request.method === 'GET' ? okBody({ all: 12500, paid: 3200 }) : okBody({ ok: true }),
  )
  render(
    <MemoryRouter>
      <BroadcastEditorAsAdmin
        broadcast={broadcast({ id: 'b2', status: 'draft', sentAt: null })}
        onBack={() => {}}
        onSaved={() => {}}
      />
    </MemoryRouter>,
  )
  fireEvent.change(screen.getByDisplayValue('Scheduled maintenance on 15 Nov'), {
    target: { value: 'Unsaved wording' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send test to me' }))
  assert.ok(await screen.findByText(/jack@example\.com/))
  const writes = requests.filter((r) => r.method !== 'GET')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].method, 'POST')
  assert.match(writes[0].url, /broadcasts\/test$/)
  assert.equal(writes[0].body?.titleEn, 'Unsaved wording')
  assert.equal(writes[0].body?.language, 'en')
  assert.equal('operatorEmail' in (writes[0].body ?? {}), false)
})

test('"Send test to me" does not send invalid content (NTF-BC-014)', async () => {
  const requests = recordFetch(() => okBody({ all: 1, paid: 1 }))
  render(
    <MemoryRouter>
      <BroadcastEditorAsAdmin onBack={() => {}} onSaved={() => {}} />
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Send test to me' }))
  assert.ok(await screen.findByRole('alert'))
  assert.equal(requests.filter((r) => r.method !== 'GET').length, 0)
})
