/**
 * PRD §14.3 允许工程实现阶段定义技术参数，
 * 但不得削弱 48 小时激活有效期与角色隔离规则。
 */
export const ACTIVATION_TOKEN_HOURS = 48;
export const RESET_TOKEN_HOURS = 2;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** 产品要求：登录后 7 天内无需再次登录（除非主动退出或清理 Cookie）。 */
export const SESSION_MAX_DAYS = 7;
export const SESSION_IDLE_MINUTES = SESSION_MAX_DAYS * 24 * 60;
export const SESSION_MAX_HOURS = SESSION_MAX_DAYS * 24;

/** 登录页输入邮箱时防抖调用，一次输入就会打好几次，额度放宽 */
export const EMAIL_CHECK_MAX_PER_WINDOW = 60;
export const TOKEN_STATUS_MAX_PER_WINDOW = 30;
export const SIGN_IN_MAX_PER_WINDOW = 10;
export const EMAIL_SEND_MAX_PER_WINDOW = 5;
/** 管理员在账号管理里发信（新增 / 重发激活 / 重置），按操作者计数 */
export const ADMIN_EMAIL_SEND_MAX_PER_WINDOW = 20;
export const RATE_LIMIT_WINDOW_MINUTES = 5;

export const EMPLOYEE_PAGE_SIZE_DEFAULT = 10;
export const EMPLOYEE_PAGE_SIZE_MAX = 100;
export const EMPLOYEE_PAGE_MAX = 10_000;

export function isPasswordAcceptable(plain: string): boolean {
  return (
    plain.length >= PASSWORD_MIN_LENGTH && plain.length <= PASSWORD_MAX_LENGTH
  );
}
