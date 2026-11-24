/**
 * Notification P0 — Admin 侧契约（设计 §5）。
 *
 * Portal 拥有通知域（模板、广播、发送日志、受众）；BackOffice 只做运营界面与
 * 服务令牌代理。这里的类型是 Portal `/api/integration/notifications/**` 的
 * 返回形状在 Admin 内的投影，字段与 `LearningGuidePortal/services/notifications/types.ts`
 * 对齐；页面不直接碰 Portal 的 snake_case 或额外字段。
 */

export const NOTIFICATION_CHANNELS = ['in_app', 'email'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_LANGUAGES = ['en', 'zh'] as const;
export type NotificationLanguage = (typeof NOTIFICATION_LANGUAGES)[number];

export const NOTIFICATION_CATEGORIES = [
  'subscription',
  'support',
  'course',
  'study_group',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** 页面固定分组顺序（PRD §5 / B01）。 */
export const NOTIFICATION_CATEGORY_ORDER: readonly NotificationCategory[] = [
  'subscription',
  'support',
  'course',
  'study_group',
];

export type NotificationCopy = {
  title?: string;
  message?: string;
  buttonText?: string;
  subject?: string;
  emailBody?: string;
  emailButtonText?: string;
};

export type NotificationTemplate = {
  id: string;
  /** Fixed catalogue name from the Portal; read-only. */
  name?: string;
  category: NotificationCategory;
  channels: NotificationChannel[];
  locked: boolean;
  enabled: boolean;
  triggerText: string;
  recipientText: string;
  sendsText: string;
  buttonLink: string;
  en: NotificationCopy;
  zh: NotificationCopy;
  updatedAt: string | null;
  updatedBy: string | null;
  /** 该模板允许的变量（Portal 按模板给出，NTF-BO-016）。 */
  variables?: string[];
  metadata?: Record<string, unknown>;
};

export type NotificationBroadcast = {
  id: string;
  titleEn: string;
  bodyEn: string;
  titleZh?: string | null;
  bodyZh?: string | null;
  buttonText?: string | null;
  buttonLink?: string | null;
  audience: 'all' | 'paid';
  status: 'draft' | 'sent' | 'withdrawn';
  createdBy: string;
  createdAt: string;
  sentAt: string | null;
  withdrawnAt: string | null;
  withdrawnBy: string | null;
  recipients: number;
  read: number;
  rate: number;
  metadata?: Record<string, unknown>;
};

export type NotificationAudienceCounts = { all: number; paid: number };

export type NotificationSendLogItem = {
  id: string;
  occurredAt: string;
  recipientEmail: string;
  recipientName: string;
  notificationId: string | null;
  templateId: string | null;
  broadcastId: string | null;
  notificationName: string;
  channel: NotificationChannel;
  status: 'delivered' | 'read' | 'withdrawn' | 'sent' | 'failed';
  failureReason: string | null;
  isTest: boolean;
  related: string | null;
};

export type NotificationSendLogDetail = {
  entry: NotificationSendLogItem;
  message: {
    notificationId: string;
    title: string;
    body: string;
    buttonText: string | null;
    buttonLink: string | null;
    language: NotificationLanguage;
    category: string | null;
    createdAt: string;
    readAt: string | null;
    withdrawnAt: string | null;
  } | null;
  timeline: Array<{
    status: NotificationSendLogItem['status'];
    occurredAt: string;
    failureReason: string | null;
  }>;
  isTest: boolean;
};
