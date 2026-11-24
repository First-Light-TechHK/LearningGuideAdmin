import type { CapabilityId } from '../../../common/capabilities';
import type { EmployeeRole } from '../../contracts/employee';
import {
  actionAllowedAtLevel,
  canAccessEmployeeAccount,
  isActionAllowed,
  levelFor,
  type ActionKind,
  type MenuKey,
  type PermissionLevel,
} from './permissions';

/**
 * 账号级功能开关（owner 2026-11-20）——单一事实来源。
 *
 * 角色给基线，账号开关可加可减；生效 = 环境能力 ∩ 角色矩阵 ∩ 账号开关：
 * - module.<menu> = false → NONE；= true 且角色为 NONE → 至少 VIEW；
 * - course.<action> = false → 拒绝；= true → 模块可见时允许；缺省继承角色；
 * - 环境能力（ADMIN_CAPABILITIES，既有能力门）永远优先，账号开关不能越过；
 * - module.accounts 例外：PRD §3.3 只给 Admin，账号开关只能收紧、不能授给非 Admin。
 *
 * 这里的纯函数同时给守卫、会话（GET /api/session 的 features）和功能权限 API 使用，
 * 页面/路由/接口禁止各自再写一套判定。
 */

/** 模块组：一个模块对应一个菜单（accounts 是独立能力，没有侧栏菜单）。 */
export const MODULE_FEATURES = [
  'module.course',
  'module.knowledge',
  'module.ai',
  'module.students',
  'module.helpdesk',
  'module.operations',
  'module.reporting',
  'module.order',
  'module.settings',
  'module.accounts',
] as const;

export type ModuleFeatureKey = (typeof MODULE_FEATURES)[number];

/**
 * 课程动作组（账号级）：与 route-access 的 ActionKind 对齐，导入/导出独立成键。
 * 新建/删除（CREATE/DELETE）不在账号级功能目录里 —— permissions.md：新建/删除只由
 * 角色矩阵控制，Admin 不能按账号把它们授予或收回。
 */
export const COURSE_ACTION_FEATURES = [
  'course.view',
  'course.edit',
  'course.publish',
  'course.import',
  'course.export',
] as const;

export type CourseActionFeatureKey = (typeof COURSE_ACTION_FEATURES)[number];

export type FeatureKey = ModuleFeatureKey | CourseActionFeatureKey;
export type FeatureGroup = 'module' | 'course';

export type FeatureCatalogEntry = {
  key: FeatureKey;
  group: FeatureGroup;
  sortOrder: number;
};

/** 固定顺序即前端渲染顺序；新增开关只能追加，不能重排既有 sortOrder。 */
export const FEATURE_CATALOG: readonly FeatureCatalogEntry[] = [
  ...MODULE_FEATURES.map((key, index) => ({
    key,
    group: 'module' as const,
    sortOrder: (index + 1) * 10,
  })),
  ...COURSE_ACTION_FEATURES.map((key, index) => ({
    key,
    group: 'course' as const,
    sortOrder: (index + 1) * 10,
  })),
];

const FEATURE_KEYS: ReadonlySet<string> = new Set(
  FEATURE_CATALOG.map((entry) => entry.key),
);
const MODULE_KEYS: ReadonlySet<string> = new Set(MODULE_FEATURES);

export function isFeatureKey(value: unknown): value is FeatureKey {
  return typeof value === 'string' && FEATURE_KEYS.has(value);
}

export function isModuleFeatureKey(value: unknown): value is ModuleFeatureKey {
  return typeof value === 'string' && MODULE_KEYS.has(value);
}

/** 模块开关 → 侧栏菜单；operations 住在 Course 里，accounts 没有菜单。 */
export const MODULE_MENU: Record<ModuleFeatureKey, MenuKey | null> = {
  'module.course': 'course',
  'module.knowledge': 'knowledge',
  'module.ai': 'aiTutor',
  'module.students': 'student',
  'module.helpdesk': 'helpDesk',
  'module.operations': 'course',
  'module.reporting': 'reporting',
  'module.order': 'order',
  'module.settings': 'settings',
  'module.accounts': null,
};

/** 模块开关 → 环境能力（ADMIN_CAPABILITIES）：账号开关永远不能越过它。 */
export const MODULE_CAPABILITY: Record<ModuleFeatureKey, CapabilityId> = {
  'module.course': 'course',
  'module.knowledge': 'knowledge',
  'module.ai': 'ai',
  'module.students': 'students',
  'module.helpdesk': 'helpdesk',
  'module.operations': 'operations',
  'module.reporting': 'reporting',
  'module.order': 'order',
  'module.settings': 'settings',
  'module.accounts': 'accounts',
};

/**
 * 课程路由动作 → 账号级动作开关。
 * CREATE / DELETE 没有账号开关（permissions.md：新建/删除仅由角色矩阵决定）。
 */
export const COURSE_ACTION_FEATURE: Partial<
  Record<ActionKind, CourseActionFeatureKey>
> = {
  VIEW: 'course.view',
  EDIT_EXISTING: 'course.edit',
  PUBLISH: 'course.publish',
  IMPORT: 'course.import',
  EXPORT: 'course.export',
};

/** 反向索引：菜单 → 模块开关（operations 与 Course 同菜单，先到先得）。 */
const MENU_MODULE: Partial<Record<MenuKey, ModuleFeatureKey>> = {};
for (const module of MODULE_FEATURES) {
  const menu = MODULE_MENU[module];
  if (menu && MENU_MODULE[menu] === undefined) MENU_MODULE[menu] = module;
}

/** 反向索引：动作开关 → 路由动作。 */
const FEATURE_ACTION = new Map<CourseActionFeatureKey, ActionKind>(
  (
    Object.entries(COURSE_ACTION_FEATURE) as Array<
      [ActionKind, CourseActionFeatureKey]
    >
  ).map(([action, feature]) => [feature, action]),
);

/** 单个课程动作键是否生效（路由级「任一命中」门槛用）。 */
export function isCourseActionFeatureAllowed(
  feature: CourseActionFeatureKey,
  role: EmployeeRole,
  grants: FeatureGrantMap,
  enabledCapabilities: ReadonlySet<CapabilityId>,
): boolean {
  const action = FEATURE_ACTION.get(feature);
  return action
    ? effectiveCourseAction(role, action, grants, enabledCapabilities)
    : false;
}

/** 显式开关：缺省（没有 key）= 继承角色基线。 */
export type FeatureGrantMap = ReadonlyMap<FeatureKey, boolean>;

export type EffectiveFeature = {
  key: FeatureKey;
  allowed: boolean;
  /** 模块开关的解析级别；课程动作只有允许/拒绝，level 为 null。 */
  level: PermissionLevel | null;
};

function baselineLevel(
  role: EmployeeRole,
  module: ModuleFeatureKey,
): PermissionLevel {
  if (module === 'module.accounts') {
    // PRD §3.3 / PORT-§15.3：员工账号管理只有 Admin 可访问，非 Admin 连子菜单都不可见。
    // 账号开关只能收紧（false），不能把 accounts 授给非 Admin —— 这是 module 通用规则
    // 「允许可越过角色 NONE」的唯一例外，按 PRD 的硬边界 fail-closed。
    return canAccessEmployeeAccount(role) ? 'FULL' : 'NONE';
  }
  const menu = MODULE_MENU[module];
  return menu ? levelFor(role, menu) : 'NONE';
}

/**
 * 模块的生效级别：环境能力优先；账号开关 false 收紧到 NONE，
 * true 在角色 NONE 上抬到 VIEW（已有更高基线时保留基线）。
 * 例外：module.accounts 的 true 不改变基线（见 baselineLevel）。
 */
export function effectiveModuleLevel(
  role: EmployeeRole,
  module: ModuleFeatureKey,
  grants: FeatureGrantMap,
  enabledCapabilities: ReadonlySet<CapabilityId>,
): PermissionLevel {
  if (!enabledCapabilities.has(MODULE_CAPABILITY[module])) return 'NONE';
  const baseline = baselineLevel(role, module);
  const grant = grants.get(module);
  if (grant === false) return 'NONE';
  if (module === 'module.accounts') return baseline;
  if (grant === true && baseline === 'NONE') return 'VIEW';
  return baseline;
}

/** 菜单的生效级别：菜单对应模块开关的解析结果。 */
export function effectiveMenuLevel(
  role: EmployeeRole,
  menu: MenuKey,
  grants: FeatureGrantMap,
  enabledCapabilities: ReadonlySet<CapabilityId>,
): PermissionLevel {
  const module = MENU_MODULE[menu];
  if (!module) return 'NONE';
  return effectiveModuleLevel(role, module, grants, enabledCapabilities);
}

/**
 * 课程动作的生效结果：模块可见是前提；账号开关 false 一律拒绝，
 * true 越过角色动作基线；缺省继承角色矩阵。
 * CREATE / DELETE 没有账号开关，始终按角色矩阵。
 */
export function effectiveCourseAction(
  role: EmployeeRole,
  action: ActionKind,
  grants: FeatureGrantMap,
  enabledCapabilities: ReadonlySet<CapabilityId>,
): boolean {
  if (
    effectiveModuleLevel(role, 'module.course', grants, enabledCapabilities) ===
    'NONE'
  )
    return false;
  const feature = COURSE_ACTION_FEATURE[action];
  if (!feature) return isActionAllowed(role, 'course', action);
  const grant = grants.get(feature);
  if (grant === false) return false;
  // 模块可见（上面已确认）即允许查看；显式允许再越过角色动作基线。
  if (action === 'VIEW') return true;
  if (grant === true) return true;
  return isActionAllowed(role, 'course', action);
}

/** 菜单 + 动作的最终判定（守卫用）：课程动作走账号开关，其它菜单沿用角色矩阵。 */
export function isMenuActionAllowed(
  role: EmployeeRole,
  menu: MenuKey,
  action: ActionKind,
  grants: FeatureGrantMap,
  enabledCapabilities: ReadonlySet<CapabilityId>,
): boolean {
  const level = effectiveMenuLevel(role, menu, grants, enabledCapabilities);
  if (level === 'NONE') return false;
  if (menu === 'course')
    return effectiveCourseAction(role, action, grants, enabledCapabilities);
  return actionAllowedAtLevel(level, action);
}

/** 模块开关本身是否允许（operations 等路由级门槛用）。 */
export function isModuleFeatureAllowed(
  module: ModuleFeatureKey,
  role: EmployeeRole,
  grants: FeatureGrantMap,
  enabledCapabilities: ReadonlySet<CapabilityId>,
): boolean {
  return (
    effectiveModuleLevel(role, module, grants, enabledCapabilities) !== 'NONE'
  );
}

export function resolveEffectiveFeatures(input: {
  role: EmployeeRole;
  grants: FeatureGrantMap;
  enabledCapabilities: ReadonlySet<CapabilityId>;
}): EffectiveFeature[] {
  const { role, grants, enabledCapabilities } = input;
  return FEATURE_CATALOG.map((entry) => {
    if (isModuleFeatureKey(entry.key)) {
      const level = effectiveModuleLevel(
        role,
        entry.key,
        grants,
        enabledCapabilities,
      );
      return { key: entry.key, allowed: level !== 'NONE', level };
    }
    // course.* 动作只有布尔结果
    const action = FEATURE_ACTION.get(entry.key);
    const allowed = action
      ? effectiveCourseAction(role, action, grants, enabledCapabilities)
      : false;
    return { key: entry.key, allowed, level: null };
  });
}

export function effectiveFeatureKeys(input: {
  role: EmployeeRole;
  grants: FeatureGrantMap;
  enabledCapabilities: ReadonlySet<CapabilityId>;
}): FeatureKey[] {
  return resolveEffectiveFeatures(input)
    .filter((entry) => entry.allowed)
    .map((entry) => entry.key);
}

/**
 * 角色基线（不看账号开关）：功能权限抽屉用来解释「继承」到底继承到什么。
 * module.* 给角色矩阵级别；course.* 给角色矩阵下的布尔结果。
 */
export function resolveBaselineFeatures(
  role: EmployeeRole,
): EffectiveFeature[] {
  return FEATURE_CATALOG.map((entry) => {
    if (isModuleFeatureKey(entry.key)) {
      const level = baselineLevel(role, entry.key);
      return { key: entry.key, allowed: level !== 'NONE', level };
    }
    const action = FEATURE_ACTION.get(entry.key);
    return {
      key: entry.key,
      allowed: action ? isActionAllowed(role, 'course', action) : false,
      level: null,
    };
  });
}
