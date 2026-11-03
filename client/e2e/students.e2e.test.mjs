// 浏览器 E2E（真 Chromium + Vite dev server，API 在浏览器里假装）：Student Management 与 Settings › Learning Access。
// 锁住：列表按 Figma 1423:3 的列显示、筛选参数、?student= 打开抽屉；单人设置必须写原因并带 expectedVersion；
// 停用 / 启用要原因、停用后显示横幅且单人设置不可改；改邮箱（人工核验需填工单号，邮箱被占用时报错不关弹窗）；
// 全局开关先改再确认（弹窗写明影响人数）；紧急关闭要原因并显示横幅；VIEW 角色只读；未接 Portal 时给出提示。
// 运行：node --test e2e/students.e2e.test.mjs（本地跑，CI 不装浏览器）。截图：E2E_SHOTS=<目录> 时保存。
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
const SHOTS = process.env.E2E_SHOTS || null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
let server
let browser
let base

before(async () => {
  server = await createServer({ root, logLevel: 'error', server: { port: 0, strictPort: false, host: '127.0.0.1' } })
  await server.listen()
  base = `http://127.0.0.1:${server.httpServer.address().port}`
  const executablePath = process.env.PW_CHROMIUM || undefined
  browser = await chromium.launch(executablePath ? { executablePath, args: ['--headless=new', '--no-sandbox'] } : {})
})

after(async () => {
  await browser?.close()
  await server?.close()
})

const ok = (data, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify({ success: true, data, error: null }) })
const fail = (status, code) => ({ status, contentType: 'application/json', body: JSON.stringify({ success: false, data: null, error: { code, message: code } }) })

function session(role) {
  return { employee: { employeeId: 'e1', loginEmail: 'olive@example.com', role, displayName: 'Olive', accountStatus: 'ACTIVE', emailVerification: 'VERIFIED', displayStatus: 'Active', isBootstrapAdmin: false }, sidebarState: 'expanded' }
}

const PEOPLE = [
  ['u1', 'Emma Wilson', 'emma.wilson@example.com', { aiTutor: true, overrides: { improve_tutor: 'allow' } }],
  ['u2', 'Liam Chen', 'liam.chen@example.com', { aiTutor: true }],
  ['u3', 'Sophia Martinez', 'sophia.m@example.com', { inactive: true }],
  ['u4', 'Noah Patel', 'noah.patel@example.com', { aiTutor: true, overrides: { improve_tutor: 'allow', ai_support_assistant: 'deny' } }],
  ['u5', 'Ava Thompson', 'ava.t@example.com', { pending: true }],
  ['u6', 'Lucas Brown', 'lucas.brown@example.com', {}],
]

function initialState() {
  return {
    students: PEOPLE.map(([id, name, email, opts], index) => ({
      id, name, email, aiTutor: Boolean(opts.aiTutor), overrides: { improve_tutor: 'default', ai_support_assistant: 'default', ...opts.overrides },
      inactive: Boolean(opts.inactive), deactivation: opts.inactive ? { at: '2026-10-30T09:00:00Z', byName: 'Jack', reason: 'Chargeback LG-1029' } : null,
      verification: opts.pending ? 'pending' : 'verified', registeredAt: `2026-10-${String(27 - index).padStart(2, '0')}T09:00:00Z`, version: 1,
    })),
    globals: { improve_tutor: { enabled: false, emergencyOff: null }, ai_support_assistant: { enabled: true, emergencyOff: null } },
    version: 3,
  }
}

function decide(state, s, feature) {
  const override = s.overrides[feature]
  const global = state.globals[feature]
  if (s.inactive) return { enabled: false, reason: 'account_inactive' }
  if (global.emergencyOff) return { enabled: false, reason: 'emergency_off' }
  if (feature === 'improve_tutor' && !s.aiTutor) return { enabled: false, reason: 'missing_prerequisite' }
  if (override === 'deny') return { enabled: false, reason: 'override_deny' }
  if (override === 'allow') return { enabled: true, reason: 'override_allow' }
  return global.enabled ? { enabled: true, reason: 'global_on' } : { enabled: false, reason: 'global_off' }
}

function special(s) {
  return Object.entries(s.overrides).filter(([, v]) => v !== 'default').map(([feature, value]) => ({ feature, value }))
}

function listItem(s) {
  return {
    id: s.id, name: s.name, email: s.email, accountStatus: s.inactive ? 'inactive' : 'active', emailVerification: s.verification,
    subscription: s.aiTutor ? { count: 1, label: 'Science', state: 'active' } : { count: 0, label: null, state: null },
    specialAccess: special(s), registeredAt: s.registeredAt,
  }
}

function details(state, s) {
  return {
    ...listItem(s),
    deactivation: s.inactive ? s.deactivation : null,
    emailExemption: s.verification === 'admin_exempt' ? { at: '2026-11-02T10:00:00Z', byName: 'Olive', reference: s.reference } : null,
    emailChange: null,
    profile: { country: 'United Kingdom', ageRange: '25-34', education: "Bachelor's degree", interests: ['Science', 'Philosophy'], language: 'en-GB' },
    signInMethods: ['email', 'google'], hasPassword: true,
    subscriptions: s.aiTutor
      ? [{ id: 'sub1', label: 'Science', scope: 'category', device: 'pc', source: 'purchase', state: 'active', current: true, aiTutor: true, validFrom: '2026-10-20T00:00:00Z', validTo: '2027-04-20T00:00:00Z', graceEndsAt: null, renews: true, orderId: 'ord_123' }]
      : [],
    features: ['improve_tutor', 'ai_support_assistant'].map((feature) => ({ feature, override: s.overrides[feature], ...decide(state, s, feature) })),
    overridesVersion: `v${s.version}`,
    passwordLink: s.inactive ? { available: false, blockedBy: 'inactive' } : s.verification === 'pending' ? { available: false, blockedBy: 'email_unverified' } : { available: true, kind: 'reset' },
  }
}

function settings(state) {
  return {
    version: String(state.version),
    features: ['improve_tutor', 'ai_support_assistant'].map((feature) => {
      const rows = state.students.map((s) => s.overrides[feature])
      return {
        feature, globalEnabled: state.globals[feature].enabled, emergencyOff: state.globals[feature].emergencyOff,
        overrides: { allow: rows.filter((v) => v === 'allow').length, deny: rows.filter((v) => v === 'deny').length },
        eligibleDefault: state.students.filter((s) => !s.inactive && s.overrides[feature] === 'default' && (feature !== 'improve_tutor' || s.aiTutor)).length,
        updated: { at: '2026-11-01T08:00:00Z', byName: 'Jack' },
      }
    }),
  }
}

async function open(urlPath, { role = 'ADMIN', connected = true, viewport = { width: 1440, height: 900 } } = {}) {
  const state = initialState()
  const calls = []
  const page = await browser.newPage({ viewport })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    const p = url.pathname
    const body = request.postData() ? JSON.parse(request.postData()) : null
    calls.push({ method, path: p, query: url.search, body })
    if (p === '/api/session') return route.fulfill(ok(session(role)))
    if (!connected && (p.startsWith('/api/students') || p.startsWith('/api/learning-access'))) return route.fulfill(fail(503, 'STUDENTS_NOT_CONNECTED'))
    if (p === '/api/students') {
      const status = url.searchParams.get('status')
      const items = state.students.filter((s) => !status || (status === 'inactive') === s.inactive).map(listItem)
      const inactive = state.students.filter((s) => s.inactive).length
      return route.fulfill(ok({ items, total: items.length, page: 1, pageSize: 10, counts: { total: state.students.length, active: state.students.length - inactive, inactive } }))
    }
    const m = p.match(/^\/api\/students\/([^/]+)(?:\/([\w-]+))?$/)
    if (m) {
      const s = state.students.find((row) => row.id === m[1])
      if (!s) return route.fulfill(fail(404, 'STUDENT_NOT_FOUND'))
      if (!m[2]) return route.fulfill(ok(details(state, s)))
      if (m[2] === 'feature-overrides') {
        if (body.expectedVersion !== `v${s.version}`) return route.fulfill(fail(409, 'VERSION_CONFLICT'))
        Object.assign(s.overrides, body.overrides)
        s.version += 1
        return route.fulfill(ok(details(state, s)))
      }
      if (m[2] === 'actions') {
        if (body.action === 'deactivate') Object.assign(s, { inactive: true, deactivation: { at: '2026-11-02T10:00:00Z', byName: 'Olive', reason: body.reason } })
        if (body.action === 'activate') Object.assign(s, { inactive: false, deactivation: null })
        if (body.action === 'change_email') {
          if (state.students.some((row) => row.email === body.email)) return route.fulfill(fail(409, 'EMAIL_TAKEN'))
          Object.assign(s, { email: body.email, verification: body.exemption ? 'admin_exempt' : 'pending', reference: body.exemption?.reference })
          return route.fulfill(ok({ student: details(state, s), email: { sent: true } }))
        }
        return route.fulfill(ok({ student: details(state, s), email: null }))
      }
    }
    if (p === '/api/learning-access' && method === 'GET') return route.fulfill(ok(settings(state)))
    if (p === '/api/learning-access' && method === 'PUT') {
      if (body.expectedVersion !== String(state.version)) return route.fulfill(fail(409, 'VERSION_CONFLICT'))
      for (const [feature, value] of Object.entries(body.features)) state.globals[feature].enabled = value.enabled
      state.version += 1
      return route.fulfill(ok(settings(state)))
    }
    if (p === '/api/learning-access/emergency') {
      state.globals[body.feature].emergencyOff = body.off ? { at: '2026-11-02T10:00:00Z', byName: 'Olive', reason: body.reason } : null
      state.version += 1
      return route.fulfill(ok(settings(state)))
    }
    return route.fulfill(ok({}))
  })
  await page.goto(`${base}${urlPath}`)
  return { page, calls, errors, state }
}

const writes = (calls) => calls.filter((call) => call.method !== 'GET')
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

test('list follows Figma: columns, pills, special access text, status filter, Feature Access Settings link', async () => {
  const { page, calls, errors } = await open('/en-GB/student')
  await page.getByTestId('student-row').first().waitFor()
  assert.equal(await page.getByTestId('student-row').count(), 6)
  const headers = await page.locator('thead th').allTextContents()
  assert.deepEqual(headers, ['Student', 'Email', 'Status', 'Subscription', 'Special Access', 'Registered', 'Action'])
  const first = page.getByTestId('student-row').first()
  assert.match(await first.textContent(), /Emma Wilson.*Active.*Science · Active.*Improve Tutor.*27 Oct 2026.*View →/)
  assert.match(await page.getByTestId('student-row').nth(3).textContent(), /2 overrides/)
  assert.match(await page.getByTestId('student-row').nth(4).textContent(), /Pending verification/)
  assert.ok(await page.getByRole('link', { name: /Feature Access Settings/ }).isVisible())
  await shot(page, '1.1-student-list')
  await page.getByLabel('Status').selectOption('inactive')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="student-row"]').length === 1)
  assert.ok(calls.some((call) => call.path === '/api/students' && call.query.includes('status=inactive')))
  assert.deepEqual(errors, [])
  await page.close()
})

test('drawer: ?student= deep link, override needs a reason, save sends expectedVersion and shows the result', async () => {
  const { page, calls, errors } = await open('/en-GB/student?student=u2')
  const drawer = page.getByTestId('student-drawer')
  await drawer.getByText('Liam Chen').waitFor()
  assert.equal(await page.getByTestId('effective-improve_tutor').textContent(), 'Disabled')
  await shot(page, '1.2-student-drawer')
  const save = page.getByTestId('student-save')
  assert.equal(await save.isDisabled(), true)
  await page.getByLabel('Improve Tutor override').selectOption('allow')
  assert.ok(await drawer.getByText('Unsaved changes').isVisible())
  assert.equal(await save.isDisabled(), true, 'a reason is required')
  await drawer.getByLabel('Reason for change').fill('Pilot group A')
  await save.click()
  await page.getByTestId('student-notice').waitFor()
  assert.equal(await page.getByTestId('effective-improve_tutor').textContent(), 'Enabled')
  const put = writes(calls).find((call) => call.path === '/api/students/u2/feature-overrides')
  assert.deepEqual(put.body, { reason: 'Pilot group A', expectedVersion: 'v1', overrides: { improve_tutor: 'allow' } })
  await page.getByRole('button', { name: 'Close' }).first().click()
  await page.waitForFunction(() => !location.search.includes('student='))
  assert.deepEqual(errors, [])
  await page.close()
})

test('closing with unsaved changes asks first', async () => {
  const { page } = await open('/en-GB/student?student=u2')
  await page.getByTestId('student-drawer').getByText('Liam Chen').waitFor()
  await page.getByLabel('AI Support Assistant override').selectOption('deny')
  await page.keyboard.press('Escape')
  await page.getByText('Discard unsaved changes?').waitFor()
  await page.getByRole('button', { name: 'Keep editing' }).click()
  assert.ok(await page.getByTestId('student-drawer').isVisible())
  await page.close()
})

test('deactivate needs a reason, shows the banner, locks overrides; activate brings it back', async () => {
  const { page, calls } = await open('/en-GB/student?student=u6')
  await page.getByTestId('student-drawer').getByText('Lucas Brown').waitFor()
  await page.getByRole('button', { name: 'Deactivate Account' }).click()
  const confirm = page.getByTestId('modal-confirm')
  assert.equal(await confirm.isDisabled(), true)
  await page.getByPlaceholder('What happened and the support reference').fill('Fraud report LG-2201')
  await shot(page, '1.2c-deactivate-modal')
  await confirm.click()
  await page.getByTestId('student-inactive-banner').waitFor()
  assert.equal(await page.getByLabel('Improve Tutor override').isDisabled(), true)
  assert.deepEqual(writes(calls).at(-1).body, { action: 'deactivate', reason: 'Fraud report LG-2201' })
  await shot(page, '1.2b-inactive-drawer')
  await page.getByRole('button', { name: 'Activate Account' }).click()
  await page.getByPlaceholder('What happened and the support reference').fill('Resolved')
  await page.getByTestId('modal-confirm').click()
  await page.getByText('Account activated.').waitFor()
  assert.equal(await page.getByTestId('student-inactive-banner').count(), 0)
  await page.close()
})

test('edit email: taken address stays in the modal with an error; Admin-exempt needs a reference', async () => {
  const { page, calls } = await open('/en-GB/student?student=u6')
  await page.getByTestId('student-drawer').getByText('Lucas Brown').waitFor()
  await page.getByRole('button', { name: 'Edit Email' }).click()
  await page.getByLabel('New email').fill('emma.wilson@example.com')
  await page.getByPlaceholder('What happened and the support reference').fill('Ticket 88')
  await page.getByTestId('modal-confirm').click()
  await page.getByText(/belongs to another account/).waitFor()
  await page.getByLabel('New email').fill('lucas.new@example.com')
  await page.getByLabel(/Ownership was verified manually/).check()
  assert.equal(await page.getByTestId('modal-confirm').isDisabled(), true, 'reference required')
  await page.getByLabel('Ticket or procedure reference').fill('Passport check 42')
  await page.getByTestId('modal-confirm').click()
  await page.getByText('Email changed and marked Admin-exempt.').waitFor()
  assert.deepEqual(writes(calls).at(-1).body, { action: 'change_email', email: 'lucas.new@example.com', reason: 'Ticket 88', exemption: { reference: 'Passport check 42' } })
  await page.close()
})

test('view-only role can read but not change anything', async () => {
  const { page, calls } = await open('/en-GB/student?student=u1', { role: 'FINANCE' })
  await page.getByTestId('student-drawer').getByText('Emma Wilson').waitFor()
  assert.ok(await page.getByText('View only.', { exact: false }).first().isVisible())
  assert.equal(await page.getByLabel('Improve Tutor override').isDisabled(), true)
  assert.equal(await page.getByTestId('student-actions').count(), 0)
  assert.equal(await page.getByTestId('student-save').count(), 0)
  await page.goto(`${base}/en-GB/settings/learning-access`)
  await page.getByTestId('feature-row-improve_tutor').waitFor()
  assert.equal(await page.getByRole('switch', { name: 'Improve Tutor' }).isDisabled(), true)
  assert.equal(await page.getByTestId('settings-save').count(), 0)
  assert.deepEqual(writes(calls), [])
  await page.close()
})

test('settings: turning a feature on asks with the affected count; emergency off needs a reason and shows a banner', async () => {
  const { page, calls, errors } = await open('/en-GB/settings/learning-access')
  await page.getByTestId('feature-row-improve_tutor').waitFor()
  assert.ok(await page.getByRole('link', { name: 'Learning Access & Experiments' }).isVisible())
  await shot(page, '2.1-learning-access')
  assert.equal(await page.getByTestId('settings-save').isDisabled(), true)
  await page.getByRole('switch', { name: 'Improve Tutor' }).click()
  await page.getByTestId('settings-save').click()
  await page.getByText(/About 1 eligible students/).waitFor()
  await page.getByPlaceholder('Release note or ticket').fill('Release 2026-11-04')
  await page.getByTestId('settings-confirm').click()
  await page.getByText('Settings saved.', { exact: false }).waitFor()
  assert.deepEqual(writes(calls).at(-1).body, { reason: 'Release 2026-11-04', expectedVersion: '3', features: { improve_tutor: { enabled: true } } })
  await page.getByTestId('feature-row-ai_support_assistant').getByRole('button', { name: 'Emergency off' }).click()
  assert.equal(await page.getByTestId('settings-confirm').isDisabled(), true)
  await page.getByPlaceholder('Release note or ticket').fill('Wrong answers incident')
  await page.getByTestId('settings-confirm').click()
  await page.getByTestId('emergency-banner-ai_support_assistant').waitFor()
  assert.deepEqual(writes(calls).at(-1).body, { feature: 'ai_support_assistant', off: true, reason: 'Wrong answers incident' })
  await shot(page, '2.1a-emergency-off')
  assert.deepEqual(errors, [])
  await page.close()
})

test('not connected to Portal: list explains instead of showing an empty table', async () => {
  const { page } = await open('/en-GB/student', { connected: false })
  await page.getByTestId('students-error').waitFor()
  assert.match(await page.getByTestId('students-error').textContent(), /not connected to Portal/)
  await page.close()
})

test('zh-CN renders the same page in Chinese', async () => {
  const { page } = await open('/zh-CN/student')
  await page.getByTestId('student-row').first().waitFor()
  assert.ok(await page.getByRole('heading', { name: '学生管理' }).isVisible())
  await shot(page, '1.1-student-list-zh')
  await page.close()
})
