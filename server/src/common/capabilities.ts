/**
 * 配置驱动的模块能力门（ADMIN_CAPABILITIES）。
 *
 * 语义：
 * - 变量未配置 / 为空 = 全部能力启用（默认；dev / sit / uat / prod 行为零变化，
 *   Sandbox 同样不裁剪 —— owner 2026-11-24 决策：全模块打开，需要密钥的功能
 *   由运维配置密钥，未配置时按设计降级）；
 * - 配置后按逗号分隔的能力标识启用子集；写错标识启动即报错（与 APP_ROLES 同一先例）；
 * - 请求路径 → 能力按下面的前缀表集中映射，一处维护、可单测；
 *   不属于任何能力的路径不归能力门管，交给既有的 401/403 或 404，
 *   避免把未登记接口误伤成“模块未启用”。
 *
 * 能力标识与上游模块/路由一一对应（见每条注释）；reporting / order 在上游只是
 * 前端占位菜单，没有后端路由，能力只决定菜单与路由是否可见。
 */
export const CAPABILITY_IDS = [
  'course', // 课程管理：commerce-courses（/api/backoffice/courses、Portal 课程投影 /api/portal/v1）
  'knowledge', // 知识库：KS（/api/courses、/api/pages、/api/releases、/api/sync、/api/files、/api/tags、/api/ks）
  'ai', // AI Tutor：/api/ai 与学员运行时 /api/user
  'students', // 学员管理：Student Management（/api/students）
  'helpdesk', // 服务台：Tickets / FAQ（/api/helpdesk）与 Portal 集成（/api/integration/helpdesk）
  'operations', // 运营位：/api/backoffice/operations
  'reporting', // 报表：上游仅前端占位菜单，没有后端路由
  'order', // 订单：上游仅前端占位菜单，没有后端路由
  'settings', // 设置：学习权限（/api/learning-access）与其余 /api/admin/**
  'accounts', // 员工账号管理（/api/admin/employees/**）：owner 2026-11-20 从 settings 拆出，
  // 账号级功能权限也挂在这里；需要裁剪的环境可只显式开启 course,accounts 等子集
  // （Sandbox 不裁剪，未设置即全开，见下方 parseEnabledCapabilities）。
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export const ALL_CAPABILITIES: ReadonlySet<CapabilityId> = new Set(
  CAPABILITY_IDS,
);

/**
 * 解析 ADMIN_CAPABILITIES。未配置 / 空白 = 全部能力；
 * 未知标识直接抛错（启动阶段失败），不允许拼错后静默关闭模块。
 */
export function parseEnabledCapabilities(
  raw: string | undefined,
): ReadonlySet<CapabilityId> {
  const items = (raw ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (items.length === 0) return ALL_CAPABILITIES;
  const unknown = items.filter(
    (item) => !(CAPABILITY_IDS as readonly string[]).includes(item),
  );
  if (unknown.length > 0) {
    throw new Error(
      `ADMIN_CAPABILITIES 含未知能力：${unknown.join(', ')}（可选 ${CAPABILITY_IDS.join(', ')}）`,
    );
  }
  return new Set(items as CapabilityId[]);
}

/**
 * 某能力是否启用（未配置 ADMIN_CAPABILITIES = 全开）。
 * HTTP 之外的后台入口（启动期调度、seed）也要走同一套能力语义。
 */
export function isCapabilityEnabled(
  id: CapabilityId,
  raw: string | undefined = process.env.ADMIN_CAPABILITIES,
): boolean {
  return parseEnabledCapabilities(raw).has(id);
}

type GovernedPrefix = {
  /** 去掉 /api 后的前若干路径段（按段比较，/api/coursesx 不会命中 courses）。 */
  segments: readonly string[];
  /** 该前缀属于哪些能力；共享前缀（如 courses/releases）任一启用即放行。 */
  capabilities: readonly CapabilityId[];
};

/**
 * 路径前缀 → 能力映射表。新增受能力门管控的模块时只在这里登记；
 * 未登记的路径不归能力门管（见 capabilityForPath 的 null 语义）。
 */
const GOVERNED_PREFIXES: readonly GovernedPrefix[] = [
  // 课程管理（commerce-courses）：/api/backoffice/courses/** 与 Portal 课程投影
  { segments: ['backoffice', 'courses'], capabilities: ['course'] },
  { segments: ['portal'], capabilities: ['course'] },
  // 运营位（课程首页的运营配置）
  { segments: ['backoffice', 'operations'], capabilities: ['operations'] },
  // Settings › Notification Configuration
  { segments: ['backoffice', 'notifications'], capabilities: ['settings'] },
  // 服务台与 Portal → Admin 的 Helpdesk 集成
  { segments: ['integration', 'helpdesk'], capabilities: ['helpdesk'] },
  { segments: ['helpdesk'], capabilities: ['helpdesk'] },
  // 学员管理
  { segments: ['students'], capabilities: ['students'] },
  // 员工账号管理（独立能力 accounts）：必须先于通用 /api/admin 前缀匹配
  { segments: ['admin', 'employees'], capabilities: ['accounts'] },
  // 其余设置：学习权限；/api/admin/** 的其它接口仍归 settings
  { segments: ['admin'], capabilities: ['settings'] },
  { segments: ['learning-access'], capabilities: ['settings'] },
  // AI Tutor 与学员端运行时
  { segments: ['ai'], capabilities: ['ai'] },
  { segments: ['user'], capabilities: ['ai'] },
  // 知识库（KS）：内部接口 + 编写接口；
  // courses / releases 与 AI Tutor 共享（AI Tutor 要读课程与版本、切换线上版本）
  { segments: ['ks'], capabilities: ['knowledge'] },
  { segments: ['courses'], capabilities: ['knowledge', 'ai'] },
  { segments: ['releases'], capabilities: ['knowledge', 'ai'] },
  { segments: ['pages'], capabilities: ['knowledge'] },
  { segments: ['sync'], capabilities: ['knowledge'] },
  { segments: ['files'], capabilities: ['knowledge'] },
  { segments: ['tags'], capabilities: ['knowledge'] },
];

/** 永远放行的前缀：健康检查、登录/登出/改密等账户自身操作、会话与偏好。 */
const EXEMPT_FIRST_SEGMENTS: ReadonlySet<string> = new Set([
  'health',
  'auth',
  'session',
  'preferences',
]);

/**
 * 取 /api 之后的路径段；非 /api 路径（前端静态资源、SPA 回退）返回 null。
 * 与 Express 路由一致：不区分大小写、忽略查询串与尾斜杠。
 */
function apiSegments(path: string): string[] | null {
  const trimmed = path.toLowerCase().split('?')[0].replace(/\/+$/, '');
  if (trimmed !== '/api' && !trimmed.startsWith('/api/')) return null;
  return trimmed.slice('/api'.length).split('/').filter(Boolean);
}

/**
 * 路径归属的能力集合。
 * - null：不归能力门管（豁免路径、未登记路径、非 /api 路径）——放行；
 * - 数组：该路径的前缀属于这些能力，任一能力启用即放行。
 */
export function capabilityForPath(
  path: string,
): readonly CapabilityId[] | null {
  const segments = apiSegments(path);
  if (!segments || segments.length === 0) return null;
  const [first, second] = segments;
  if (EXEMPT_FIRST_SEGMENTS.has(first)) return null;
  // 环境端点：前端靠它读能力集，必须在能力门之外
  if (first === 'backoffice' && second === 'environment') return null;
  for (const prefix of GOVERNED_PREFIXES) {
    if (
      prefix.segments.every((segment, index) => segments[index] === segment)
    ) {
      return prefix.capabilities;
    }
  }
  return null;
}

/** 能力门判定：路径不属于已启用能力的前缀时返回 false（应 404）。 */
export function capabilityGateAllows(
  path: string,
  enabled: ReadonlySet<CapabilityId>,
): boolean {
  const owners = capabilityForPath(path);
  return (
    owners === null || owners.some((capability) => enabled.has(capability))
  );
}
