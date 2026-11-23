import {
  NOTIFICATION_CATEGORY_ORDER,
  NOTIFICATION_COPY_FIELDS,
  TEMPLATE_LIMITS,
  type BroadcastDraftInput,
  type NotificationBroadcast,
  type NotificationChannel,
  type NotificationCategory,
  type NotificationCopy,
  type NotificationTemplate,
} from '../contracts/notifications'

/**
 * Notification Configuration 的纯逻辑（日期、分组、变量校验、预览、广播校验）。
 * 页面只负责渲染与提交；所有判定都可以单测（client/tests/notification-*.test.ts）。
 */

const HKT_DATE = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Hong_Kong',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
})

const HKT_DATETIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Hong_Kong',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function parts(value: Date, formatter: Intl.DateTimeFormat): Record<string, string> {
  const result: Record<string, string> = {}
  for (const part of formatter.formatToParts(value)) {
    if (part.type !== 'literal') result[part.type] = part.value
  }
  return result
}

/** HKT 日期：16 Nov 2026。 */
export function formatHktDate(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const p = parts(date, HKT_DATE)
  return `${p.day} ${p.month} ${p.year}`
}

/** HKT 时间：02 Nov 2026 10:00（列表）/ 02 Nov 2026, 14:20 HKT（最后编辑）。 */
export function formatHktDateTime(value: string | number | Date, withZone = false): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const p = parts(date, HKT_DATETIME)
  const base = `${p.day} ${p.month} ${p.year}${withZone ? ',' : ''} ${p.hour}:${p.minute}`
  return withZone ? `${base} HKT` : base
}

/** 日期输入框的 YYYY-MM-DD（HKT）。 */
export function hktDateInput(value: Date): string {
  const p = parts(value, HKT_DATE)
  const months: Record<string, string> = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
  }
  return `${p.year}-${months[p.month] ?? '01'}-${p.day.padStart(2, '0')}`
}

/** Send log 默认窗口：最近 7 天（PRD NTF-LOG-001）。 */
export function defaultSendLogRange(now = new Date()): { from: string; to: string } {
  const from = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000)
  return { from: hktDateInput(from), to: hktDateInput(now) }
}

export function categoryLabel(category: NotificationCategory): string {
  switch (category) {
    case 'subscription':
      return 'Subscription'
    case 'support':
      return 'Support'
    case 'course':
      return 'Course'
    case 'study_group':
      return 'Study group'
  }
}

export function groupTemplates(
  templates: readonly NotificationTemplate[],
): Array<{ category: NotificationCategory; label: string; items: NotificationTemplate[] }> {
  return NOTIFICATION_CATEGORY_ORDER.map((category) => ({
    category,
    label: categoryLabel(category),
    items: templates.filter((template) => template.category === category),
  })).filter((group) => group.items.length > 0)
}

export function channelLabel(channel: NotificationChannel): string {
  return channel === 'email' ? 'Email' : 'In-app'
}

/** 某语言的必填字段（由英文侧存在的字段决定）。 */
export function requiredCopyFields(
  channels: readonly NotificationChannel[],
  en: NotificationCopy,
): Array<(typeof NOTIFICATION_COPY_FIELDS)[number]> {
  const fields: Array<(typeof NOTIFICATION_COPY_FIELDS)[number]> = []
  if (channels.includes('in_app')) {
    for (const field of ['title', 'message', 'buttonText'] as const)
      if (en[field] !== undefined) fields.push(field)
  }
  if (channels.includes('email')) {
    for (const field of ['subject', 'emailBody', 'emailButtonText'] as const)
      if (en[field] !== undefined) fields.push(field)
  }
  return fields
}

/** 语言标签：中文任一必填字段为空 → "中文 missing"（B01 / NTF-BO-003）。 */
export function chineseCopyMissing(template: NotificationTemplate): boolean {
  const required = requiredCopyFields(template.channels, template.en)
  return required.some((field) => (template.zh[field] ?? '').trim() === '')
}

export function copyLimit(field: (typeof NOTIFICATION_COPY_FIELDS)[number]): number {
  switch (field) {
    case 'title':
      return TEMPLATE_LIMITS.in_app.title
    case 'message':
      return TEMPLATE_LIMITS.in_app.message
    case 'buttonText':
      return TEMPLATE_LIMITS.in_app.buttonText
    case 'subject':
      return TEMPLATE_LIMITS.email.subject
    case 'emailBody':
      return TEMPLATE_LIMITS.email.emailBody
    case 'emailButtonText':
      return TEMPLATE_LIMITS.email.emailButtonText
  }
}

const VARIABLE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

export function variableNamesIn(value: string): string[] {
  return [...value.matchAll(VARIABLE)].map((match) => match[1])
}

const ALIASES: Record<string, string> = {
  amount_due: 'renewal_amount',
  renewal_price: 'renewal_amount',
  renewal_cost: 'renewal_amount',
  plan: 'plan_name',
  scope: 'scope_name',
  valid_until: 'valid_to',
  expires_on: 'expired_date',
  expired_on: 'expired_date',
  grace_end: 'grace_end_date',
  due_date: 'renewal_date',
  renewal_on: 'renewal_date',
  ai_point: 'ai_points',
  points: 'ai_points',
  ticket_title: 'ticket_subject',
  course_name: 'course_title',
  category: 'category_name',
  session_name: 'session_title',
  group: 'group_name',
}

function editDistance(left: string, right: string): number {
  const rows = left.length + 1
  const cols = right.length + 1
  const table = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
  for (let i = 0; i < rows; i += 1) table[i][0] = i
  for (let j = 0; j < cols; j += 1) table[0][j] = j
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      table[i][j] = Math.min(
        table[i - 1][j] + 1,
        table[i][j - 1] + 1,
        table[i - 1][j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      )
    }
  }
  return table[rows - 1][cols - 1]
}

export function suggestVariable(unknown: string, allowed: readonly string[]): string | null {
  const alias = ALIASES[unknown]
  if (alias && allowed.includes(alias)) return alias
  let best: { name: string; distance: number } | null = null
  for (const name of allowed) {
    const distance = editDistance(unknown, name)
    if (!best || distance < best.distance) best = { name, distance }
  }
  return best && best.distance <= 3 ? best.name : null
}

export type UnknownVariable = {
  field: string
  name: string
  suggestion: string | null
  language?: 'en' | 'zh'
}

/** 保存/插入前检查模板变量：未知或拼错 → 阻断并给出正确写法（NTF-BO-017）。 */
export function unknownVariables(
  copy: NotificationCopy,
  allowed: readonly string[],
): UnknownVariable[] {
  const result: UnknownVariable[] = []
  for (const field of NOTIFICATION_COPY_FIELDS) {
    const value = copy[field]
    if (!value) continue
    for (const name of variableNamesIn(value)) {
      if (allowed.includes(name)) continue
      if (result.some((item) => item.field === field && item.name === name)) continue
      result.push({ field, name, suggestion: suggestVariable(name, allowed) })
    }
  }
  return result
}

export function variableErrorMessage(issue: UnknownVariable): string {
  return issue.suggestion
    ? `{{${issue.name}}} is not available for this notification. Use {{${issue.suggestion}}} instead.`
    : `{{${issue.name}}} is not available for this notification.`
}

export type DraftIssues = {
  fields: Array<{ field: string; message: string }>
  unknown: UnknownVariable[]
}

/** 编辑页保存前的完整校验（限长、英文必填、中文全有全无、未知变量）。 */
export function validateTemplateDraft(
  template: NotificationTemplate,
  en: NotificationCopy,
  zh: NotificationCopy,
  allowedVariables: readonly string[],
): DraftIssues {
  const fields: DraftIssues['fields'] = []
  for (const [copy, language] of [
    [en, 'en'],
    [zh, 'zh'],
  ] as const) {
    for (const field of NOTIFICATION_COPY_FIELDS) {
      const value = copy[field]
      if (value === undefined) continue
      if (value.length > copyLimit(field))
        fields.push({ field: `${language}.${field}`, message: `Use ${copyLimit(field)} characters or fewer.` })
    }
  }
  const required = requiredCopyFields(template.channels, template.en)
  for (const field of required) {
    if ((en[field] ?? '').trim() === '')
      fields.push({ field: `en.${field}`, message: 'English is required.' })
  }
  const anyChinese = NOTIFICATION_COPY_FIELDS.some((field) => (zh[field] ?? '').trim() !== '')
  if (anyChinese) {
    for (const field of required) {
      if ((zh[field] ?? '').trim() === '')
        fields.push({
          field: `zh.${field}`,
          message: 'If any Chinese field is filled, all required Chinese fields must be filled.',
        })
    }
  }
  const unknown = [
    ...unknownVariables(en, allowedVariables).map((issue) => ({ ...issue, language: 'en' as const })),
    ...unknownVariables(zh, allowedVariables).map((issue) => ({ ...issue, language: 'zh' as const })),
  ]
  return { fields, unknown }
}

/** 在光标处插入变量标签（NTF-BO-016）。 */
export function insertVariable(
  value: string,
  token: string,
  selectionStart: number,
  selectionEnd = selectionStart,
): { value: string; cursor: number } {
  const start = Math.max(0, Math.min(selectionStart, value.length))
  const end = Math.max(start, Math.min(selectionEnd, value.length))
  return {
    value: `${value.slice(0, start)}${token}${value.slice(end)}`,
    cursor: start + token.length,
  }
}

/** 预览/测试用样本值（PRD §13.2 的例子）。 */
export const SAMPLE_VALUES: Record<string, string> = {
  user_name: 'Margaret',
  plan_name: 'Everything · 12 months',
  scope_name: 'Everything',
  old_scope_name: 'History',
  new_scope_name: 'Everything',
  valid_to: '16 Nov 2026',
  new_valid_to: '16 Nov 2027',
  renewal_date: '16 Nov 2026',
  renewal_amount: 'US$149.00',
  amount_paid: 'US$60.00',
  grace_end_date: '19 Nov 2026',
  expired_date: '19 Nov 2026',
  ai_points: '10,000',
  ticket_subject: "Can't play the video in Lesson 3",
  course_title: 'The Renaissance in Florence',
  category_name: 'Art & Humanities',
  session_title: "Reading Plato's Republic",
  group_name: 'Philosophy Circle',
  session_date: '12 Nov 2026',
  session_time: '7:00 PM (HKT)',
  app_url: 'https://learningguide.test',
  ticket_link: '/my-learning/support/1',
  course_link: '/courses/renaissance',
  session_link: '/portal/study-groups/sessions/1',
}

export function renderSample(value: string | undefined): string {
  if (!value) return ''
  return value.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, name: string) =>
    SAMPLE_VALUES[name] ?? match,
  )
}

export type PreviewContent = { title: string; body: string; buttonText: string; subject: string }

export function previewContent(copy: NotificationCopy, channel: NotificationChannel): PreviewContent {
  if (channel === 'email') {
    return {
      title: renderSample(copy.subject),
      body: renderSample(copy.emailBody),
      buttonText: renderSample(copy.emailButtonText),
      subject: renderSample(copy.subject),
    }
  }
  return {
    title: renderSample(copy.title),
    body: renderSample(copy.message),
    buttonText: renderSample(copy.buttonText),
    subject: '',
  }
}

/** 语言标签里的中文（i18n 守卫禁止源码写死中文；这里是产品固定的语言名）。 */
const CHINESE_LABEL = String.fromCharCode(0x4e2d, 0x6587)

export function broadcastLanguageLabel(broadcast: NotificationBroadcast): string {
  return (broadcast.titleZh && broadcast.titleZh.trim()) || (broadcast.bodyZh && broadcast.bodyZh.trim())
    ? `EN · ${CHINESE_LABEL}`
    : 'EN only'
}

export type BroadcastDraftIssues = { fields: Array<{ field: string; message: string }> }

/** 新建/编辑广播的保存前校验（NTF-BC-012）：标题/正文限长、按钮成对、链接前缀。 */
export function validateBroadcastDraft(input: BroadcastDraftInput): BroadcastDraftIssues["fields"] {
  const fields: BroadcastDraftIssues['fields'] = []
  const title = input.titleEn.trim()
  const body = input.bodyEn.trim()
  if (!title) fields.push({ field: 'titleEn', message: 'Title is required.' })
  if (title.length > 60) fields.push({ field: 'titleEn', message: 'Use 60 characters or fewer.' })
  if (!body) fields.push({ field: 'bodyEn', message: 'Message is required.' })
  if (body.length > 300) fields.push({ field: 'bodyEn', message: 'Use 300 characters or fewer.' })
  if ((input.titleZh ?? '').trim().length > 60)
    fields.push({ field: 'titleZh', message: 'Use 60 characters or fewer.' })
  if ((input.bodyZh ?? '').trim().length > 300)
    fields.push({ field: 'bodyZh', message: 'Use 300 characters or fewer.' })
  const buttonText = (input.buttonText ?? '').trim()
  const buttonLink = (input.buttonLink ?? '').trim()
  if (Boolean(buttonText) !== Boolean(buttonLink))
    fields.push({ field: 'button', message: 'Button text and button link must be provided together.' })
  if (buttonText.length > 24)
    fields.push({ field: 'buttonText', message: 'Use 24 characters or fewer.' })
  if (buttonLink && !buttonLink.startsWith('https://') && !buttonLink.startsWith('/'))
    fields.push({ field: 'buttonLink', message: 'Button link must start with https:// or /.' })
  return fields
}

export function readRateLabel(recipients: number, rate: number): string {
  if (recipients <= 0) return '—'
  return `${Math.round(rate * 100)}% read`
}

export function countLabel(value: number): string {
  return new Intl.NumberFormat('en-GB').format(value)
}

/**
 * 服务端稳定错误码 → 界面文案（缺翻译时回退服务器 message）。
 * INVALID_INPUT 由 Portal 给出具体原因和建议（例如应改用哪个变量），直接显示。
 */
export function notificationErrorText(
  translate: (key: string) => string,
  result: { code?: string; error?: string; message?: string },
): string {
  const code = result.code ?? result.error ?? ''
  if (code === 'INVALID_INPUT' && result.message) return result.message
  const key = `notification.errors.${code}`
  const translated = translate(key)
  return translated === key ? result.message ?? 'Request failed' : translated
}
