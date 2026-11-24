import './support/dom'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type {
  BroadcastDraftInput,
  NotificationBroadcast,
  NotificationTemplate,
} from '../src/backoffice/contracts/notifications'
import {
  broadcastLanguageLabel,
  categoryLabel,
  channelLabel,
  chineseCopyMissing,
  defaultSendLogRange,
  formatHktDate,
  formatHktDateTime,
  groupTemplates,
  insertVariable,
  notificationErrorText,
  readRateLabel,
  renderSample,
  suggestVariable,
  unknownVariables,
  validateBroadcastDraft,
  validateTemplateDraft,
  variableErrorMessage,
} from '../src/backoffice/lib/notificationFormat'
import { t } from '../src/backoffice/lib/i18n/messages'

test('an unknown error with no message falls back to the request-failed text in the current language (R2-04)', () => {
  const zh = (key: string) => t('zh-CN', key)
  assert.equal(notificationErrorText(zh, { code: 'SOMETHING_NEW' }), '请求失败')
  assert.equal(notificationErrorText((key) => t('en-GB', key), {}), 'Request failed')
  assert.equal(notificationErrorText(zh, { code: 'SOMETHING_NEW', message: 'raw server text' }), 'raw server text')
})

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

test('groups the fixed 13 templates in PRD order and omits empty groups', () => {
  const groups = groupTemplates([
    template({ id: 'LIVE_SESSION_BOOKED', category: 'study_group' }),
    template({ id: 'SUB_SUCCESS' }),
    template({ id: 'HELPDESK_TICKET_REPLIED', category: 'support' }),
  ])
  assert.deepEqual(
    groups.map((group) => [group.label, group.items.length]),
    [
      ['Subscription', 1],
      ['Support', 1],
      ['Study group', 1],
    ],
  )
})

test('marks Chinese as missing when any required Chinese field is empty (NTF-BO-003)', () => {
  assert.equal(chineseCopyMissing(template()), false)
  assert.equal(
    chineseCopyMissing(template({ zh: { title: '只有标题' } })),
    true,
  )
  // Chinese is optional: all empty still shows "missing", because required fields are empty.
  assert.equal(chineseCopyMissing(template({ zh: {} })), true)
})

test('suggests the right variable for a misspelling (NTF-BO-017)', () => {
  const allowed = template().variables ?? []
  assert.equal(suggestVariable('amount_due', allowed), 'renewal_amount')
  assert.equal(suggestVariable('plan', allowed), 'plan_name')
  assert.equal(suggestVariable('completely_unknown', allowed), null)
  assert.deepEqual(unknownVariables({ message: '{{amount_due}}' }, allowed), [
    { field: 'message', name: 'amount_due', suggestion: 'renewal_amount' },
  ])
})

test('inserts a variable at the cursor and keeps the cursor after it', () => {
  const result = insertVariable('Hello world', '{{plan_name}}', 6, 11)
  assert.equal(result.value, 'Hello {{plan_name}}')
  assert.equal(result.cursor, 6 + '{{plan_name}}'.length)
})

test('blocks save on unknown variables, limits and partial Chinese copy', () => {
  const issues = validateTemplateDraft(
    template(),
    { ...template().en, message: 'Payment {{amount_due}} failed' },
    { title: '只有标题' },
    template().variables ?? [],
  )
  assert.ok(issues.fields.some((issue) => issue.field === 'zh.message'))
  assert.deepEqual(issues.unknown, [
    {
      field: 'message',
      name: 'amount_due',
      suggestion: 'renewal_amount',
      language: 'en',
    },
  ])

  const tooLong = validateTemplateDraft(
    template(),
    { ...template().en, title: 'x'.repeat(61) },
    template().zh,
    template().variables ?? [],
  )
  assert.ok(tooLong.fields.some((issue) => issue.field === 'en.title'))
})

test('renders PRD sample values into the preview', () => {
  assert.equal(
    renderSample('Your {{plan_name}} renews for {{renewal_amount}}.'),
    'Your Everything · 12 months renews for US$149.00.',
  )
})

test('formats HKT dates and times independently of the machine timezone', () => {
  assert.equal(formatHktDate('2026-11-16T10:00:00.000Z'), '16 Nov 2026')
  assert.equal(
    formatHktDateTime('2026-11-02T02:00:00.000Z'),
    '02 Nov 2026 10:00',
  )
  assert.equal(
    formatHktDateTime('2026-11-02T06:20:00.000Z', true),
    '02 Nov 2026, 14:20 HKT',
  )
})

test('defaults the send log to the last 7 HKT days', () => {
  assert.deepEqual(defaultSendLogRange(new Date('2026-11-02T10:00:00.000Z')), {
    from: '2026-10-27',
    to: '2026-11-02',
  })
})

function broadcast(overrides: Partial<NotificationBroadcast> = {}): NotificationBroadcast {
  return {
    id: 'b1',
    titleEn: 'Scheduled maintenance',
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

test('labels broadcast languages and read rate', () => {
  assert.equal(broadcastLanguageLabel(broadcast()), 'EN · 中文')
  assert.equal(broadcastLanguageLabel(broadcast({ titleZh: '', bodyZh: '' })), 'EN only')
  assert.equal(readRateLabel(12480, 0.41), '41% read')
  assert.equal(readRateLabel(0, 0), '—')
})

test('labels built in code follow the interface language (R-05)', () => {
  const zh = 'zh-CN'
  const noChinese = broadcast({ titleZh: '', bodyZh: '' })
  const draft: BroadcastDraftInput = { titleEn: 'Hi', bodyEn: 'Body', audience: 'all' }
  const first = (input: BroadcastDraftInput) => validateBroadcastDraft(input, zh)[0].message
  assert.equal(readRateLabel(100, 0.41, zh), '41% 已读')
  assert.equal(broadcastLanguageLabel(noChinese, zh), '仅英文')
  assert.equal(channelLabel('in_app', zh), '站内')
  assert.equal(channelLabel('email', zh), '邮件')
  assert.equal(categoryLabel('announcement', zh), '公告')
  assert.equal(first({ ...draft, titleEn: ' ' }), '标题为必填。')
  assert.equal(first({ ...draft, titleEn: 'x'.repeat(61) }), '最多 60 个字符。')
  assert.equal(first({ ...draft, buttonText: 'Go' }), '按钮文字和按钮链接必须同时填写。')
  assert.equal(
    variableErrorMessage({ field: 'message', name: 'amount_due', suggestion: 'renewal_amount' }, zh),
    '这条通知不能使用 {{amount_due}}，请改用 {{renewal_amount}}。',
  )
  assert.equal(
    validateTemplateDraft(template(), { ...template().en, title: '' }, template().zh, [], zh).fields[0]
      .message,
    '英文为必填。',
  )
})

test('validates broadcast content and optional button pair (NTF-BC-012)', () => {
  const valid: BroadcastDraftInput = {
    titleEn: 'Maintenance',
    bodyEn: 'Tonight',
    audience: 'all',
  }
  assert.deepEqual(validateBroadcastDraft(valid), [])

  assert.ok(
    validateBroadcastDraft({ ...valid, titleEn: '   ' }).some((issue) => issue.field === 'titleEn'),
  )
  assert.ok(
    validateBroadcastDraft({ ...valid, buttonText: 'Details' }).some(
      (issue) => issue.field === 'button',
    ),
  )
  assert.ok(
    validateBroadcastDraft({
      ...valid,
      buttonText: 'Details',
      buttonLink: 'javascript:alert(1)',
    }).some((issue) => issue.field === 'buttonLink'),
  )
})
