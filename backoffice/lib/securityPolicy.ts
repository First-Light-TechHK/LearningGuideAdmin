/**
 * PRD §14.3 允许工程实现阶段定义技术参数，
 * 但不得削弱 48 小时激活有效期与角色隔离规则。
 */
export const ACTIVATION_TOKEN_HOURS = 48;
export const RESET_TOKEN_HOURS = 2;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const SESSION_IDLE_MINUTES = 30;
export const SESSION_MAX_HOURS = 12;

export const EMAIL_CHECK_MAX_PER_WINDOW = 20;
export const SIGN_IN_MAX_PER_WINDOW = 10;
export const EMAIL_SEND_MAX_PER_WINDOW = 5;
export const RATE_LIMIT_WINDOW_MINUTES = 5;

export const EMPLOYEE_PAGE_SIZE_DEFAULT = 10;
export const EMPLOYEE_PAGE_SIZE_MAX = 100;

export function isPasswordAcceptable(plain: string): boolean {
  return plain.length >= PASSWORD_MIN_LENGTH && plain.length <= PASSWORD_MAX_LENGTH;
}
