import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'

import type { FaqChange, FaqChangePerson, HelpdeskFaq } from '../src/backoffice/contracts/helpdesk'
import { absent, faq, installFakeServer, type FakeServer } from './support/helpdesk-fake'
import { location, renderHelpDesk } from './support/helpdesk-render'

/**
 * 修改记录（Figma 草案 2.6–2.9，用户 2026-10-30 确认），经 HelpDeskPage 渲染，fetch 换成假的 BackOffice Server：
 * Change Log Tab（说明、筛选进地址栏与请求、表格、空状态、VIEW 也能看）；改动详情（谁、何时、版本、用户是否已看到、
 * 长文字与关键词的改前改后、Open this FAQ：FULL 编辑 / VIEW 预览、已删除的不给）；FAQ 抽屉三个页签（键盘切换、
 * History（N）时间线与展开、Open in Change Log 只看这一条、有草稿先确认放弃、保存时字段没填好切回 Details）。
 */

const LOG = '/api/helpdesk/faq-changes'
const FAQ_ID = '0192aaaa-0000-7000-8000-0000000000f1'
const HISTORY = `/api/helpdesk/faqs/${FAQ_ID}/changes`
const JACK = '0192aaaa-0000-7000-8000-0000000000e1'
const MIA = '0192aaaa-0000-7000-8000-0000000000e2'

const PEOPLE: FaqChangePerson[] = [
  { id: JACK, name: 'jack', role: 'ADMIN', email: 'jack@example.com' },
  { id: MIA, name: 'mia.chen', role: 'OPERATION_ADMIN', email: 'mia.chen@example.com' },
]

const RESET: HelpdeskFaq = faq(FAQ_ID, {
  key: 'reset-password',
  questionEn: 'How do I reset my password?',
  questionZh: '如何重置密码？',
  answerEn: 'Select “Forgot password”. The link expires after 30 minutes; check your spam folder.',
  keywords: ['reset password', 'reset link'],
  type: 'answer',
  entry: true,
  signals: [],
  version: 5,
})

const node = { id: FAQ_ID, key: 'reset-password', questionEn: RESET.questionEn, questionZh: RESET.questionZh, status: 'published' as const }

function change(id: string, patch: Partial<FaqChange> = {}): FaqChange {
  return {
    id,
    at: '2026-10-30T08:20:05.000Z',
    employee: PEOPLE[0],
    subject: 'faq',
    action: 'edited',
    faq: node,
    child: null,
    phrasing: null,
    release: null,
    version: null,
    changes: [],
    learners: 'live',
    liveIn: 12,
    ...patch,
  }
}

const EDIT = change('faq:edit', {
  version: { from: 4, to: 5 },
  learners: 'pending',
  liveIn: null,
  changes: [
    {
      field: 'answerEn',
      before: 'Select “Forgot password”. If no email arrives, check your spam folder.',
      after: 'Select “Forgot password”. The link expires after 30 minutes; check your spam folder.',
    },
    { field: 'keywords', before: ['reset password', 'cannot log in'], after: ['reset password', 'reset link'] },
  ],
})
const PHRASING = change('phrasing:1', {
  at: '2026-10-30T07:58:00.000Z',
  employee: PEOPLE[1],
  subject: 'phrasing',
  action: 'removed',
  phrasing: { locale: 'zh-CN', text: '忘记密码怎么办', source: 'staff' },
})
const RELEASE = change('release_published:12', {
  at: '2026-10-30T07:40:00.000Z',
  employee: PEOPLE[1],
  subject: 'release',
  action: 'published',
  faq: null,
  learners: null,
  liveIn: null,
  release: { version: 12, status: 'published', sourceVersion: null, problems: 0 },
})
const GONE = change('faq:gone', {
  at: '2026-10-29T09:44:00.000Z',
  action: 'archived',
  faq: { ...node, id: '0192aaaa-0000-7000-8000-0000000000f9', questionEn: 'Where can I find my invoice?', status: 'archived' },
  changes: [{ field: 'status', before: 'published', after: 'archived' }],
})

let server: FakeServer

function serveLog(changes: FaqChange[] = [EDIT, PHRASING, RELEASE, GONE]) {
  server.on('GET', LOG, (call) => {
    const subject = call.query.get('subject')
    const rows = changes.filter((c) => !subject || c.subject === subject)
    return { data: { changes: rows, total: rows.length, page: 1, pageSize: 10, people: PEOPLE } }
  })
  server.on('GET', '/api/helpdesk/tickets', { data: { tickets: [], nextCursor: null, counts: {} } })
}

function serveFaq() {
  server.on('GET', '/api/helpdesk/faqs', { data: { faqs: [RESET], total: 1, page: 1, pageSize: 10 } })
  server.on('GET', `/api/helpdesk/faqs/${FAQ_ID}`, { data: RESET })
  server.on('GET', `/api/helpdesk/faqs/${FAQ_ID}/edges`, { data: { children: [], parents: [] } })
  server.on('GET', `/api/helpdesk/faqs/${FAQ_ID}/phrasings`, { data: { phrasings: [] } })
  server.on('GET', HISTORY, {
    data: { changes: [EDIT, PHRASING, { ...RELEASE, id: 'release_published:r12' }], total: 3, page: 1, pageSize: 50, truncated: false },
  })
}

async function openLog(role: 'ADMIN' | 'COURSE_CREATOR' = 'ADMIN', query = '') {
  await renderHelpDesk(server, { role, path: `/en-GB/help-desk?tab=changes${query}` })
  await waitFor(() => assert.ok(server.callsTo('GET', LOG).length >= 1))
  return screen.findByRole('table')
}

function row(text: string): HTMLElement {
  const element = screen.getByText(text).closest('tr')
  assert.ok(element, `row containing ${text}`)
  return element as HTMLElement
}

beforeEach(() => {
  server = installFakeServer()
})

afterEach(() => {
  cleanup()
  server.restore()
})

describe('Change Log tab (Figma 2.6)', () => {
  test('the note, filters and table: who, when, what and the change, newest first', async () => {
    serveLog()
    await openLog()
    assert.equal(screen.getByRole('tab', { name: 'Change Log' }).getAttribute('aria-selected'), 'true')
    assert.ok(screen.getByText(/Records cannot be edited or deleted\./))
    // 缺省「最近 30 天」：请求带起点
    const first = server.callsTo('GET', LOG)[0].query
    assert.ok(first.get('from'), 'the last 30 days by default')
    assert.equal(first.get('pageSize'), '10')
    assert.equal((screen.getByLabelText('Date range') as HTMLSelectElement).value, '30d')
    await waitFor(() => assert.ok(screen.getByText('4 changes')))
    assert.deepEqual(
      within(screen.getByRole('table'))
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
      ['When', 'Changed by', 'What changed', 'Change', 'Action'],
    )
    const edit = row('Answer (English) · Keywords')
    assert.ok(within(edit).getByText('jack'))
    assert.ok(within(edit).getByText('Admin'))
    assert.ok(within(edit).getByText('FAQ'))
    assert.ok(within(edit).getByText('How do I reset my password?'))
    assert.ok(within(edit).getByText('Edited'))
    const phrasing = row('“忘记密码怎么办” (Simplified Chinese)')
    assert.ok(within(phrasing).getByText('mia.chen'))
    assert.ok(within(phrasing).getByText('Operation Admin'))
    assert.ok(within(phrasing).getByText('Removed'))
    assert.ok(within(row('Learners now see version 12')).getByText('Version 12'))
    assert.ok(within(row('Removed from Help Centre and AI Support')).getByText('Deleted'))
    assert.deepEqual(
      [...(screen.getByLabelText('Changed by') as HTMLSelectElement).options].map((o) => o.textContent),
      ['Everyone', 'jack', 'mia.chen', 'System'],
    )
  })

  test('filters go into the address bar and the request; changing one goes back to page 1', async () => {
    serveLog()
    await openLog('ADMIN', '&page=2')
    fireEvent.change(screen.getByLabelText('Change type'), { target: { value: 'phrasing' } })
    await waitFor(() => assert.match(location.current, /type=phrasing/))
    assert.doesNotMatch(location.current, /page=/)
    await waitFor(() => assert.equal(server.callsTo('GET', LOG).at(-1)?.query.get('subject'), 'phrasing'))
    fireEvent.change(screen.getByLabelText('Changed by'), { target: { value: MIA } })
    await waitFor(() => assert.equal(server.callsTo('GET', LOG).at(-1)?.query.get('employee'), MIA))
    fireEvent.change(screen.getByLabelText('Date range'), { target: { value: 'all' } })
    await waitFor(() => assert.equal(server.callsTo('GET', LOG).at(-1)?.query.get('from'), null))
    fireEvent.change(screen.getByLabelText('Search by question, key or text...'), { target: { value: 'reset' } })
    await waitFor(() => assert.equal(server.callsTo('GET', LOG).at(-1)?.query.get('q'), 'reset'), { timeout: 2000 })
    assert.match(location.current, /q=reset/)
  })

  test('nothing found says so; a server error is shown', async () => {
    serveLog([])
    await openLog()
    await waitFor(() => assert.ok(screen.getByText('No changes match your search or filters.')))
    cleanup()
    server.on('GET', LOG, { status: 503, error: 'HELPDESK_UNAVAILABLE' })
    await openLog()
    assert.ok(await screen.findByRole('alert'))
  })

  test('a VIEW role can read the Change Log and open a change; Open this FAQ is a preview', async () => {
    serveLog()
    serveFaq()
    await openLog('COURSE_CREATOR')
    await waitFor(() => row('Answer (English) · Keywords'))
    fireEvent.click(screen.getByRole('button', { name: 'View details: Edited, How do I reset my password?' }))
    const details = await screen.findByRole('dialog', { name: 'Change details' })
    fireEvent.click(within(details).getByRole('button', { name: 'Open this FAQ' }))
    assert.ok(await screen.findByRole('dialog', { name: 'Preview FAQ' }))
    absent(screen.queryByRole('dialog', { name: 'Edit FAQ' }))
  })
})

describe('change details (Figma 2.7)', () => {
  test('who and when, the version, whether learners see it, and before / after', async () => {
    serveLog()
    serveFaq()
    await openLog()
    await waitFor(() => row('Answer (English) · Keywords'))
    fireEvent.click(screen.getByRole('button', { name: 'View details: Edited, How do I reset my password?' }))
    const details = await screen.findByRole('dialog', { name: 'Change details' })
    assert.ok(within(details).getByText('FAQ · How do I reset my password?'))
    assert.ok(within(details).getByText('jack'))
    assert.ok(within(details).getByText('Admin · jack@example.com'))
    assert.ok(within(details).getByText(/ time$/), 'says which time zone')
    assert.ok(within(details).getByText('FAQ · Edited'))
    assert.ok(within(details).getByText('Version 4 → 5'))
    assert.ok(within(details).getByText('Not yet'))
    assert.ok(within(details).getByText('Goes live with the next published release'))
    assert.ok(within(details).getByRole('heading', { name: 'What changed (2 fields)' }))
    // 长文字：只标出改了的那一段
    const removed = [...details.querySelectorAll('del')].map((d) => d.textContent)
    const added = [...details.querySelectorAll('ins')].map((d) => d.textContent)
    assert.ok(removed.includes('If no email arrives,'))
    assert.ok(added.includes('The link expires after 30 minutes;'))
    // 关键词：− 删掉的，+ 加上的，没变的照常
    assert.ok(removed.includes('cannot log in'))
    assert.ok(added.includes('reset link'))
    assert.ok(within(details).getByText('reset password'))
    assert.ok(within(details).getByText('Unchanged fields are not shown. Red = removed, green = added.'))
    // Escape 关掉，焦点回到「View details」
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => absent(screen.queryByRole('dialog')))
  })

  test('Open this FAQ opens the editor for FULL roles; a deleted FAQ cannot be opened', async () => {
    serveLog()
    serveFaq()
    await openLog()
    await waitFor(() => row('Removed from Help Centre and AI Support'))
    fireEvent.click(screen.getByRole('button', { name: 'View details: Deleted, Where can I find my invoice?' }))
    let details = await screen.findByRole('dialog', { name: 'Change details' })
    assert.ok(within(details).getByText('This FAQ has since been deleted.'))
    absent(within(details).queryByRole('button', { name: 'Open this FAQ' }))
    assert.ok(within(details).getByText('Live'), 'status after')
    fireEvent.click(within(details).getAllByRole('button', { name: 'Close' })[0])
    await waitFor(() => absent(screen.queryByRole('dialog')))

    fireEvent.click(screen.getByRole('button', { name: 'View details: Edited, How do I reset my password?' }))
    details = await screen.findByRole('dialog', { name: 'Change details' })
    fireEvent.click(within(details).getByRole('button', { name: 'Open this FAQ' }))
    assert.ok(await screen.findByRole('dialog', { name: 'Edit FAQ' }))
  })

  test('a phrasing and a release show what they are', async () => {
    serveLog()
    await openLog()
    await waitFor(() => row('“忘记密码怎么办” (Simplified Chinese)'))
    fireEvent.click(screen.getByRole('button', { name: 'View details: Removed, How do I reset my password?' }))
    let details = await screen.findByRole('dialog', { name: 'Change details' })
    assert.equal(details.querySelector('del')?.textContent, '忘记密码怎么办')
    assert.ok(within(details).getByText('BackOffice'))
    assert.ok(within(details).getByText('Live since version 12'))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => absent(screen.queryByRole('dialog')))
    fireEvent.click(screen.getByRole('button', { name: 'View details: Published, Version 12' }))
    details = await screen.findByRole('dialog', { name: 'Change details' })
    absent(within(details).queryByText('Learners see it'), 'a release has no learners line of its own')
    absent(within(details).queryByRole('button', { name: 'Open this FAQ' }))
  })
})

describe('FAQ drawer tabs and History (Figma 2.8 / 2.9)', () => {
  async function openEditor() {
    serveFaq()
    serveLog()
    await renderHelpDesk(server, { path: '/en-GB/help-desk?tab=faqs' })
    fireEvent.click(await screen.findByRole('button', { name: `Edit ${RESET.questionEn}` }))
    return screen.findByRole('dialog', { name: 'Edit FAQ' })
  }

  test('three tabs; arrows move between them; History shows its count, the timeline and the diff', async () => {
    const dialog = await openEditor()
    const tabs = within(dialog).getAllByRole('tab')
    await waitFor(() => assert.equal(tabs[2].textContent, 'History (3)'))
    assert.deepEqual(
      tabs.map((tab) => [tab.textContent, tab.getAttribute('aria-selected')]),
      [
        ['Details', 'true'],
        ['Follow-ups & phrasings', 'false'],
        ['History (3)', 'false'],
      ],
    )
    assert.ok(within(dialog).getByLabelText(/^Question \(English\)/))
    tabs[0].focus()
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' })
    assert.equal(tabs[1].getAttribute('aria-selected'), 'true')
    assert.equal(document.activeElement, tabs[1])
    assert.ok(within(dialog).getByRole('heading', { name: 'Follow-ups and options' }))
    fireEvent.keyDown(tabs[1], { key: 'End' })
    assert.equal(tabs[2].getAttribute('aria-selected'), 'true')
    const panel = within(dialog).getByRole('tabpanel')
    assert.ok(within(panel).getByText('Every saved change to this FAQ, its follow-ups and its phrasings. Newest first.'))
    assert.ok(within(panel).getByText('Answer (English) · Keywords'))
    assert.ok(within(panel).getByText('Went live'))
    assert.ok(within(panel).getByText('Published in release version 12'))
    assert.ok(within(panel).getByText('Phrasing removed'))
    const view = within(panel).getAllByRole('button', { name: 'View changes' })[0]
    fireEvent.click(view)
    assert.equal(view.getAttribute('aria-expanded'), 'true')
    assert.ok([...panel.querySelectorAll('ins')].some((i) => i.textContent === 'reset link'))
    assert.equal(view.textContent, 'Hide changes')
    // 每次切到 History 都重新读（追问 / 问法是立即保存的）
    const reads = server.callsTo('GET', HISTORY).length
    fireEvent.click(tabs[0])
    fireEvent.click(tabs[2])
    await waitFor(() => assert.equal(server.callsTo('GET', HISTORY).length, reads + 1))
  })

  test('Open in Change Log closes the drawer and shows only this FAQ; with a draft it asks first', async () => {
    const dialog = await openEditor()
    fireEvent.change(within(dialog).getByLabelText(/^Answer \(Chinese\)/), { target: { value: '写到一半' } })
    fireEvent.click(within(dialog).getByRole('tab', { name: /^History/ }))
    absent(within(dialog).queryByRole('button', { name: 'Delete FAQ' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open in Change Log' }))
    const confirm = await screen.findByRole('alertdialog')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep editing' }))
    assert.ok(screen.getByRole('dialog', { name: 'Edit FAQ' }), 'kept')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open in Change Log' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard' }))
    await waitFor(() => absent(screen.queryByRole('dialog')))
    assert.equal(location.current, `/en-GB/help-desk?tab=changes&range=all&faq=${FAQ_ID}`)
    await waitFor(() => assert.equal(server.callsTo('GET', LOG).at(-1)?.query.get('faq'), FAQ_ID))
    assert.equal(server.callsTo('GET', LOG).at(-1)?.query.get('from'), null, 'all time')
    assert.ok(await screen.findByText('Changes to: How do I reset my password?'))
    fireEvent.click(screen.getByRole('button', { name: 'Show all FAQs' }))
    await waitFor(() => assert.doesNotMatch(location.current, /faq=/))
  })

  test('saving from another tab with a missing field goes back to Details and focuses it', async () => {
    const dialog = await openEditor()
    fireEvent.change(within(dialog).getByLabelText(/^Question \(English\)/), { target: { value: ' ' } })
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Follow-ups & phrasings' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save FAQ' }))
    await waitFor(() => assert.equal(within(dialog).getByRole('tab', { name: 'Details' }).getAttribute('aria-selected'), 'true'))
    assert.equal(document.activeElement, within(dialog).getByLabelText(/^Question \(English\)/))
    assert.equal(server.callsTo('PUT', `/api/helpdesk/faqs/${FAQ_ID}`).length, 0)
  })

  test('a new FAQ has no History tab', async () => {
    serveFaq()
    serveLog()
    await renderHelpDesk(server, { path: '/en-GB/help-desk?tab=faqs' })
    fireEvent.click(await screen.findByRole('button', { name: '+ Add FAQ' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add FAQ' })
    assert.deepEqual(
      within(dialog)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
      ['Details', 'Follow-ups & phrasings'],
    )
    assert.equal(server.callsTo('GET', /\/changes$/).length, 0)
  })
})
