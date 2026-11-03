/**
 * 学生管理（Student Management PRD v1.0）页面用到的数据形状。源头是 Portal 的
 * contracts/student-management.ts（BackOffice Server 原样转发）；改字段要三处一起改。
 */

export const FEATURE_KEYS = ['improve_tutor', 'ai_support_assistant'] as const
export type FeatureKey = (typeof FEATURE_KEYS)[number]
export type OverrideValue = 'default' | 'allow' | 'deny'
export type AccountStatus = 'active' | 'inactive'
export type EmailVerification = 'verified' | 'pending' | 'admin_exempt'
export type SignInMethod = 'email' | 'google' | 'wechat'
export type AccessReason =
  | 'account_inactive'
  | 'emergency_off'
  | 'missing_prerequisite'
  | 'override_deny'
  | 'override_allow'
  | 'global_on'
  | 'global_off'
export type SubscriptionState = 'active' | 'cancel_at_period_end' | 'grace' | 'expired' | 'trial_canceled'
export type StaffStamp = { at: string; byName: string }

export const STATUS_FILTERS = ['all', 'active', 'inactive'] as const
export const SUBSCRIPTION_FILTERS = ['all', 'current', 'none', 'grace', 'ending'] as const
export const SPECIAL_FILTERS = ['all', 'any', 'none', 'improve_tutor', 'ai_support_assistant'] as const
export type StatusFilter = (typeof STATUS_FILTERS)[number]
export type SubscriptionFilter = (typeof SUBSCRIPTION_FILTERS)[number]
export type SpecialFilter = (typeof SPECIAL_FILTERS)[number]

export const REASON_MAX = 500
export const REFERENCE_MAX = 120

export type StudentListItem = {
  id: string
  name: string
  email: string | null
  accountStatus: AccountStatus
  emailVerification: EmailVerification
  subscription: { count: number; label: string | null; state: SubscriptionState | null }
  specialAccess: Array<{ feature: FeatureKey; value: 'allow' | 'deny' }>
  registeredAt: string
}

export type StudentList = {
  items: StudentListItem[]
  total: number
  page: number
  pageSize: number
  counts: { total: number; active: number; inactive: number }
}

export type StudentSubscription = {
  id: string
  label: string
  scope: 'course' | 'category' | 'everything'
  device: 'pc' | 'mobile'
  source: 'trial' | 'purchase'
  state: SubscriptionState
  current: boolean
  aiTutor: boolean
  validFrom: string
  validTo: string
  graceEndsAt: string | null
  renews: boolean
  orderId: string | null
}

export type StudentFeature = { feature: FeatureKey; override: OverrideValue; enabled: boolean; reason: AccessReason }

export type StudentDetails = {
  id: string
  name: string
  email: string | null
  accountStatus: AccountStatus
  deactivation: (StaffStamp & { reason: string }) | null
  emailVerification: EmailVerification
  emailExemption: (StaffStamp & { reference: string }) | null
  emailChange: (StaffStamp & { reference: string }) | null
  registeredAt: string
  profile: { country: string | null; ageRange: string | null; education: string | null; interests: string[]; language: 'en-GB' | 'zh-CN' }
  signInMethods: SignInMethod[]
  hasPassword: boolean
  subscriptions: StudentSubscription[]
  features: StudentFeature[]
  overridesVersion: string
  passwordLink: { available: true; kind: 'reset' | 'setup' } | { available: false; blockedBy: 'inactive' | 'no_email' | 'email_unverified' }
}

export type StudentActionResult = { student: StudentDetails; email: { sent: boolean } | null }

export type FeatureSetting = {
  feature: FeatureKey
  globalEnabled: boolean
  emergencyOff: (StaffStamp & { reason: string }) | null
  overrides: { allow: number; deny: number }
  eligibleDefault: number
  updated: StaffStamp | null
}
export type FeatureSettings = { features: FeatureSetting[]; version: string }
