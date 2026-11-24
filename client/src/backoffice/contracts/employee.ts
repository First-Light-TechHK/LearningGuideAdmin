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

// 本地部分不以点开头/结尾、不含连续点；域名每段字母数字（可含中间连字符），顶级域至少两位字母
const EMAIL_PATTERN =
  /^(?!\.)(?!.*\.\.)[^\s@]+(?<!\.)@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

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

/** GET /api/admin/employees 的行与分页结果（与 server/src/backoffice employeeAccount 一致）。 */
export type EmployeeListItem = {
  employeeId: string;
  loginEmail: string;
  role: EmployeeRole;
  accountStatus: AccountStatus;
  emailVerification: EmailVerification;
  displayStatus: DisplayStatus;
  lastLoginAt: string | null;
  isBootstrapAdmin: boolean;
};

export type EmployeeListResult = {
  items: EmployeeListItem[];
  total: number;
  page: number;
  pageSize: number;
};

/**
 * 账号级功能权限（角色基线 ± 账号开关）。
 * 契约：GET/PUT /api/admin/employees/:id/features 返回同一形状：
 * - catalog：服务端功能目录（唯一事实来源，前端不另维护 key 列表）
 * - grants：显式账号开关（只有 允许/禁止 两种，缺省 = 继承角色）
 * - effective：服务端算出的生效结果（环境能力 ∩ 角色基线 ± 开关）
 */
export type EmployeeFeatureGroup = "module" | "course";

export type EmployeeFeatureCatalogEntry = {
  key: string;
  group: EmployeeFeatureGroup;
  sortOrder: number;
};

export type EmployeeFeatureGrant = {
  feature: string;
  allowed: boolean;
  updatedAt?: string;
  updatedBy?: string;
};

export type EmployeeFeatureEffective = {
  key: string;
  allowed: boolean;
  /** 模块开关的解析级别；课程动作只有允许/拒绝，服务端给 null。 */
  level?: string | null;
};

export type EmployeeFeatures = {
  employeeId: string;
  catalog: EmployeeFeatureCatalogEntry[];
  grants: EmployeeFeatureGrant[];
  effective: EmployeeFeatureEffective[];
  /** 角色基线（不含账号开关），用于解释 INHERIT 行。旧服务端缺省。 */
  baseline?: EmployeeFeatureEffective[];
};

/** 界面三态：继承角色（不发开关）/ 允许 / 禁止。 */
export const FEATURE_MODES = ["INHERIT", "ALLOW", "DENY"] as const;
export type FeatureMode = (typeof FEATURE_MODES)[number];

/** 目录 key → 草稿三态。目录里的每个 key 默认继承；显式 grants 覆盖为 允许/禁止。 */
export function featureDraftFromFeatures(
  features: EmployeeFeatures | null | undefined
): Record<string, FeatureMode> {
  const draft: Record<string, FeatureMode> = {};
  const catalogKeys = new Set<string>();
  for (const entry of features?.catalog ?? []) {
    draft[entry.key] = "INHERIT";
    catalogKeys.add(entry.key);
  }
  for (const grant of features?.grants ?? []) {
    // 目录是唯一事实来源；目录为空时（数据异常）也接受服务端 grants，避免开关凭空消失
    if (catalogKeys.size === 0 || catalogKeys.has(grant.feature)) {
      draft[grant.feature] = grant.allowed ? "ALLOW" : "DENY";
    }
  }
  return draft;
}

/** 单键切换（不可变）：只改目标 key，其它键与顺序保持不变。 */
export function setFeatureMode(
  draft: Record<string, FeatureMode>,
  key: string,
  mode: FeatureMode
): Record<string, FeatureMode> {
  return { ...draft, [key]: mode };
}

/**
 * 保存载荷：替换式 PUT —— 只发显式的 允许/禁止，继承 = 省略（服务端据此清空该行的开关）。
 * 顺序按目录 sortOrder 排列，同一草稿输出稳定（幂等）。
 */
export function featureGrantsPayload(
  draft: Record<string, FeatureMode>,
  catalog: readonly EmployeeFeatureCatalogEntry[]
): { grants: Array<{ feature: string; allowed: boolean }> } {
  const ordered = catalog
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.sortOrder - b.entry.sortOrder || a.index - b.index);
  const grants: Array<{ feature: string; allowed: boolean }> = [];
  for (const { entry } of ordered) {
    const mode = draft[entry.key];
    if (mode === "ALLOW" || mode === "DENY") {
      grants.push({ feature: entry.key, allowed: mode === "ALLOW" });
    }
  }
  return { grants };
}

/** 服务端生效结果 → 按 key 查（缺失 key 不臆造，界面不显示结论）。 */
export function effectiveFeatureMap(
  effective: readonly EmployeeFeatureEffective[] | null | undefined
): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const row of effective ?? []) map[row.key] = row.allowed;
  return map;
}

/** INHERIT 行展示用：key → 角色基线级别（模块）或 allowed（课程动作）。 */
export function baselineFeatureMap(
  baseline: readonly EmployeeFeatureEffective[] | null | undefined
): Record<string, { allowed: boolean; level?: string | null }> {
  const map: Record<string, { allowed: boolean; level?: string | null }> = {};
  for (const row of baseline ?? []) map[row.key] = { allowed: row.allowed, level: row.level };
  return map;
}
