/** PRD §3.1 六个固定角色；顺序即筛选器与导航的展示顺序。 */
export const EMPLOYEE_ROLES = [
  "ADMIN",
  "COURSE_CREATOR",
  "GRAPHIC_DESIGNER",
  "FINANCE",
  "OPERATION_ADMIN",
  "OPERATION_AI",
] as const;

export type EmployeeRole = (typeof EMPLOYEE_ROLES)[number];

export const ACCOUNT_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export type EmailVerification = "PENDING_VERIFICATION" | "VERIFIED";
export type DisplayStatus = "Active" | "Pending" | "Inactive";

export const DISPLAY_STATUSES = ["Active", "Pending", "Inactive"] as const;

export function isEmployeeRole(value: unknown): value is EmployeeRole {
  return typeof value === "string" && (EMPLOYEE_ROLES as readonly string[]).includes(value);
}

export function isAccountStatus(value: unknown): value is AccountStatus {
  return value === "ACTIVE" || value === "INACTIVE";
}

export function isDisplayStatus(value: unknown): value is DisplayStatus {
  return typeof value === "string" && (DISPLAY_STATUSES as readonly string[]).includes(value);
}

/** PRD BR-PORT-004：Inactive 优先，其次未验证为 Pending。 */
export function deriveDisplayStatus(
  accountStatus: AccountStatus,
  emailVerification: EmailVerification
): DisplayStatus {
  if (accountStatus === "INACTIVE") return "Inactive";
  return emailVerification === "VERIFIED" ? "Active" : "Pending";
}

/** PRD BR-PORT-002：去空格 + 小写，保证大小写不敏感比较。 */
export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(raw: string): boolean {
  const value = normaliseEmail(raw);
  return value.length > 0 && value.length <= 254 && EMAIL_PATTERN.test(value);
}

/** PRD BR-PORT-018：显示名取邮箱 @ 之前的部分。 */
export function displayNameFromEmail(email: string): string {
  const normalised = normaliseEmail(email);
  const at = normalised.indexOf("@");
  return at > 0 ? normalised.slice(0, at) : normalised;
}

/** PRD BR-PORT-005：Active + Verified 才允许登录。 */
export function isSignInEligible(
  accountStatus: AccountStatus,
  emailVerification: EmailVerification
): boolean {
  return accountStatus === "ACTIVE" && emailVerification === "VERIFIED";
}

export type SessionEmployee = {
  employeeId: string;
  loginEmail: string;
  role: EmployeeRole;
  displayName: string;
  accountStatus: AccountStatus;
  emailVerification: EmailVerification;
  displayStatus: DisplayStatus;
  isBootstrapAdmin: boolean;
};
