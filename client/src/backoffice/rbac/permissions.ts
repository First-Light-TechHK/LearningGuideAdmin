import type { EmployeeRole } from "../contracts/employee";

/** PRD §1.4：View 只读；Edit = View + 修改既有记录；Full = 模块内全部授权操作。 */
export type PermissionLevel = "NONE" | "VIEW" | "EDIT" | "FULL";

/** PRD PORT-NAV-002：侧边栏顺序固定，不得在页面里重新排序。 */
export const MENU_ORDER = [
  "course",
  "knowledge",
  "aiTutor",
  "order",
  "reporting",
  "student",
  "helpDesk",
  "settings",
] as const;

export type MenuKey = (typeof MENU_ORDER)[number];

/**
 * PRD §3.2 角色权限矩阵 —— 单一事实来源。
 * 页面、路由守卫与 API 授权都读这张表，禁止各自硬编码。
 */
export const ROLE_MATRIX: Record<EmployeeRole, Record<MenuKey, PermissionLevel>> = {
  ADMIN: {
    course: "FULL",
    knowledge: "FULL",
    aiTutor: "FULL",
    order: "FULL",
    reporting: "FULL",
    student: "FULL",
    helpDesk: "FULL",
    settings: "FULL",
  },
  COURSE_CREATOR: {
    course: "VIEW",
    knowledge: "VIEW",
    aiTutor: "VIEW",
    order: "VIEW",
    reporting: "VIEW",
    student: "VIEW",
    helpDesk: "VIEW",
    settings: "VIEW",
  },
  GRAPHIC_DESIGNER: {
    course: "EDIT",
    // REQ-0236 / PRD §3.2：Course=Edit（可改已有课程内容，不能新增、删除、发布），
    // 其他菜单全部 View。Course 模块已上线，编辑能力不再借道 Knowledge。
    knowledge: "VIEW",
    aiTutor: "VIEW",
    order: "VIEW",
    reporting: "VIEW",
    student: "VIEW",
    helpDesk: "VIEW",
    settings: "VIEW",
  },
  FINANCE: {
    course: "VIEW",
    knowledge: "VIEW",
    aiTutor: "VIEW",
    order: "FULL",
    reporting: "FULL",
    student: "VIEW",
    helpDesk: "VIEW",
    settings: "VIEW",
  },
  OPERATION_ADMIN: {
    course: "FULL",
    knowledge: "NONE",
    aiTutor: "NONE",
    order: "FULL",
    reporting: "FULL",
    student: "FULL",
    helpDesk: "FULL",
    settings: "FULL",
  },
  OPERATION_AI: {
    course: "VIEW",
    knowledge: "FULL",
    aiTutor: "FULL",
    order: "VIEW",
    reporting: "VIEW",
    student: "VIEW",
    helpDesk: "VIEW",
    settings: "VIEW",
  },
};

/**
 * PRD §3.2 注释：Edit 只允许修改既有记录，不能创建、删除或发布。
 * IMPORT / EXPORT 是发布级动作，但账号级功能开关要求单独控制（与服务端 ActionKind 对齐）。
 */
export type ActionKind =
  | "VIEW"
  | "EDIT_EXISTING"
  | "CREATE"
  | "DELETE"
  | "PUBLISH"
  | "IMPORT"
  | "EXPORT";

export function levelFor(role: EmployeeRole, menu: MenuKey): PermissionLevel {
  return ROLE_MATRIX[role][menu];
}

export function canViewMenu(role: EmployeeRole, menu: MenuKey): boolean {
  return levelFor(role, menu) !== "NONE";
}

export function isActionAllowed(
  role: EmployeeRole,
  menu: MenuKey,
  action: ActionKind
): boolean {
  return actionAllowedAtLevel(levelFor(role, menu), action);
}

/** 某一权限级别是否允许某种操作（账号开关解析出的生效级别也可直接套用）。 */
export function actionAllowedAtLevel(
  level: PermissionLevel,
  action: ActionKind
): boolean {
  switch (action) {
    case "VIEW":
      return level !== "NONE";
    case "EDIT_EXISTING":
      return level === "EDIT" || level === "FULL";
    case "CREATE":
    case "DELETE":
    case "PUBLISH":
    // 导入/导出沿用发布级基线：角色层面只有 Full 可以，账号开关再单独加减。
    case "IMPORT":
    case "EXPORT":
      return level === "FULL";
    default:
      return false;
  }
}

export function visibleMenus(role: EmployeeRole): MenuKey[] {
  return MENU_ORDER.filter((menu) => canViewMenu(role, menu));
}

/**
 * PRD §3.3：Employee Account Management 独立于 Settings 的 View/Edit/Full，
 * 只有 Admin 可访问，非 Admin 连子菜单都不可见。
 */
export function canAccessEmployeeAccount(role: EmployeeRole): boolean {
  return role === "ADMIN";
}

/** PRD BR-PORT-017：登录后默认落地 Course。 */
export const DEFAULT_LANDING_MENU: MenuKey = "course";

export const MENU_SEGMENT: Record<MenuKey, string> = {
  course: "course",
  knowledge: "knowledge",
  aiTutor: "ai-tutor",
  order: "order",
  reporting: "reporting",
  student: "student",
  helpDesk: "help-desk",
  settings: "settings",
};

export function menuHref(locale: string, menu: MenuKey): string {
  return `/${locale}/${MENU_SEGMENT[menu]}`;
}

export function employeeAccountHref(locale: string): string {
  return `/${locale}/${MENU_SEGMENT.settings}/employee-account`;
}

/**
 * PRD §2 范围说明 + §8.5：Settings 有子导航，其中 Employee Account 仅 Admin 可见；
 * Payment Gateway 与 Notification Configuration 在 P0 只是占位入口。
 */
export type SettingsSubKey =
  | "employeeAccount"
  | "paymentGateway"
  | "notificationConfiguration"
  | "learningAccess"
  | "sandboxReset";

export const SETTINGS_SUB_ORDER = [
  "employeeAccount",
  "paymentGateway",
  "notificationConfiguration",
  // Student Management PRD §7：紧跟 Notification Configuration；能看 Settings 的角色都能看（只读角色只读）
  "learningAccess",
  // Sandbox 专项：仅环境端点返回 sandboxResetEnabled=true 时出现（见 visibleSettingsSubs）
  "sandboxReset",
] as const;

export const SETTINGS_SUB_SEGMENT: Record<SettingsSubKey, string> = {
  employeeAccount: "employee-account",
  paymentGateway: "payment-gateway",
  notificationConfiguration: "notification-configuration",
  learningAccess: "learning-access",
  sandboxReset: "sandbox-reset",
};

export function settingsSubHref(locale: string, sub: SettingsSubKey): string {
  return `/${locale}/${MENU_SEGMENT.settings}/${SETTINGS_SUB_SEGMENT[sub]}`;
}

/**
 * Settings 子项 = 角色可见 ∩ 环境能力 ∩ 账号功能键。
 * - capabilities / features 传 null = 旧调用（只按角色过滤，保持既有行为）；
 * - employeeAccount 由 module.accounts（环境能力 accounts 或 settings）单独控制；
 * - 其它子项仍要 module.settings（环境能力 settings）；
 * - sandboxReset 还要环境端点明确返回 sandboxResetEnabled=true（默认不出现）。
 */
export function visibleSettingsSubs(
  role: EmployeeRole,
  capabilities: ReadonlySet<string> | null = null,
  features: ReadonlySet<string> | null = null,
  sandboxResetEnabled = false
): SettingsSubKey[] {
  return SETTINGS_SUB_ORDER.filter((sub) => {
    if (sub === "sandboxReset" && (!sandboxResetEnabled || !canAccessEmployeeAccount(role)))
      return false
    if (sub === "employeeAccount" && !canAccessEmployeeAccount(role)) return false
    if (capabilities !== null) {
      const anyOf = sub === "employeeAccount" ? ["settings", "accounts"] : ["settings"]
      if (!anyOf.some((id) => capabilities.has(id))) return false
    }
    if (features !== null) {
      const featureKey = sub === "employeeAccount" ? "module.accounts" : "module.settings"
      if (!features.has(featureKey)) return false
    }
    return true
  })
}

export function menuFromPathSegments(segments: string[] | undefined): MenuKey | null {
  if (!segments || segments.length === 0) return null;
  const target = segments[0];
  // Operations 从 Course Overview 进入，侧边栏仍高亮 Course（PRD §6）
  if (target === "operations") return "course";
  const entry = (Object.entries(MENU_SEGMENT) as [MenuKey, string][]).find(
    ([, segment]) => segment === target
  );
  return entry ? entry[0] : null;
}
