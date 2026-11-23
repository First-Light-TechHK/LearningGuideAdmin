/**
 * Notification Configuration 的前端契约（与 server/src/backoffice/modules/notification/contracts.ts 对齐）。
 * 数据来自 BackOffice 代理 /api/backoffice/notifications/**；页面不直接访问 Portal。
 */

export const NOTIFICATION_CHANNELS = ['in_app', 'email'] as const
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

export const NOTIFICATION_LANGUAGES = ['en', 'zh'] as const
export type NotificationLanguage = (typeof NOTIFICATION_LANGUAGES)[number]

export const NOTIFICATION_CATEGORIES = ['subscription', 'support', 'course', 'study_group'] as const
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]

export const NOTIFICATION_CATEGORY_ORDER: readonly NotificationCategory[] = [
  'subscription',
  'support',
  'course',
  'study_group',
]

export type NotificationCopy = {
  title?: string
  message?: string
  buttonText?: string
  subject?: string
  emailBody?: string
  emailButtonText?: string
}

export const NOTIFICATION_COPY_FIELDS = [
  'title',
  'message',
  'buttonText',
  'subject',
  'emailBody',
  'emailButtonText',
] as const

export type NotificationTemplate = {
  id: string
  category: NotificationCategory
  channels: NotificationChannel[]
  locked: boolean
  enabled: boolean
  triggerText: string
  recipientText: string
  sendsText: string
  buttonLink: string
  en: NotificationCopy
  zh: NotificationCopy
  updatedAt: string | null
  updatedBy: string | null
  variables?: string[]
  metadata?: Record<string, unknown>
}

export type TemplatesResponse = { ok: true; templates: NotificationTemplate[] }

export type NotificationBroadcast = {
  id: string
  titleEn: string
  bodyEn: string
  titleZh?: string | null
  bodyZh?: string | null
  buttonText?: string | null
  buttonLink?: string | null
  audience: 'all' | 'paid'
  status: 'draft' | 'sent' | 'withdrawn'
  createdBy: string
  createdAt: string
  sentAt: string | null
  withdrawnAt: string | null
  withdrawnBy: string | null
  recipients: number
  read: number
  rate: number
  deletedAt?: string | null
  metadata?: Record<string, unknown>
}

export type BroadcastListResponse = {
  ok: true
  broadcasts: NotificationBroadcast[]
  total: number
  page: number
  pageSize: number
}

export type BroadcastDetailResponse = {
  ok: true
  broadcast: NotificationBroadcast
  readRate: { recipients: number; read: number; rate: number }
  timeline: Array<{ status: string; at: string; by: string }>
}

export type AudienceResponse = { ok: true; all: number; paid: number }

export type NotificationLogStatus = 'delivered' | 'read' | 'withdrawn' | 'sent' | 'failed'

export type SendLogItem = {
  id: string
  occurredAt: string
  recipientEmail: string
  recipientName: string
  notificationId: string | null
  templateId: string | null
  broadcastId: string | null
  notificationName: string
  channel: NotificationChannel
  status: NotificationLogStatus
  failureReason: string | null
  isTest: boolean
  related: string | null
}

export type SendLogResponse = {
  ok: true
  items: SendLogItem[]
  total: number
  page: number
  pageSize: number
}

export type SendLogDetailResponse = {
  ok: true
  entry: SendLogItem
  message: {
    notificationId: string
    title: string
    body: string
    buttonText: string | null
    buttonLink: string | null
    language: NotificationLanguage
    category: string | null
    createdAt: string
    readAt: string | null
    withdrawnAt: string | null
  } | null
  timeline: Array<{ status: NotificationLogStatus; occurredAt: string; failureReason: string | null }>
  isTest: boolean
}

export type TemplateUpdateInput = {
  enabled?: boolean
  en?: NotificationCopy
  zh?: NotificationCopy
  expectedUpdatedAt?: string | null
}

export type BroadcastDraftInput = {
  titleEn: string
  bodyEn: string
  titleZh?: string | null
  bodyZh?: string | null
  buttonText?: string | null
  buttonLink?: string | null
  audience: 'all' | 'paid'
}

export const TEMPLATE_LIMITS = {
  in_app: { title: 60, message: 300, buttonText: 24 },
  email: { subject: 100, emailBody: 2000, emailButtonText: 24 },
} as const

export const BROADCAST_LIMITS = { title: 60, body: 300, buttonText: 24 } as const
