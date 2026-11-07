/**
 * 学生管理（Student Management PRD v1.0，2026-11-01）与 Portal 集成接口的形状。
 * 数据与判定都归 Portal（contracts/student-management.ts 是源头），这里只镜像 BackOffice 用到的字段；
 * 改字段要两边一起改。
 */

export const FEATURE_KEYS = ['improve_tutor', 'ai_support_assistant'] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];
export const OVERRIDE_VALUES = ['default', 'allow', 'deny'] as const;
export type OverrideValue = (typeof OVERRIDE_VALUES)[number];

export const STUDENT_STATUS_FILTERS = ['active', 'inactive'] as const;
export const SUBSCRIPTION_FILTERS = [
  'current',
  'none',
  'grace',
  'ending',
] as const;
export const SPECIAL_ACCESS_FILTERS = ['any', 'none', ...FEATURE_KEYS] as const;
export const STUDENT_PAGE_SIZE_MAX = 100;
export const STUDENT_REASON_MAX = 500;
export const STUDENT_REFERENCE_MAX = 120;

export const STUDENT_ACTIONS = [
  'deactivate',
  'activate',
  'change_email',
  'resend_verification',
  'send_password_link',
] as const;
export type StudentAction = (typeof STUDENT_ACTIONS)[number];

/** 员工（经会话认证）作为操作人传给 Portal，Portal 记在学员记录与审计里。 */
export type StaffActor = { id: string; name: string; role: string };

/** 浏览器 → BackOffice 的输入，校验后再拼 Portal 请求体（操作人由服务端注入，浏览器给的不算）。 */
export type ListQueryInput = {
  q?: string;
  status?: string;
  subscription?: string;
  special?: string;
  page?: number;
  pageSize?: number;
};
export type OverridesBody = {
  reason: string;
  expectedVersion: string;
  overrides: Partial<Record<FeatureKey, OverrideValue>>;
};
export type ActionBody =
  | { action: 'deactivate' | 'activate'; reason: string }
  | {
      action: 'change_email';
      email: string;
      reason: string;
      exemption: { reference: string } | null;
    }
  | { action: 'resend_verification' | 'send_password_link' };
export type SettingsBody = {
  reason: string;
  expectedVersion: string;
  features: Partial<Record<FeatureKey, { enabled: boolean }>>;
};
export type EmergencyBody = {
  feature: FeatureKey;
  off: boolean;
  reason: string;
};
