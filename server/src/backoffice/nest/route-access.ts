import {
  COURSE_ACTION_FEATURE,
  type FeatureKey,
} from '../modules/rbac/features';
import type { ActionKind, MenuKey } from '../modules/rbac/permissions';

/**
 * 每个 /api 请求归哪一类、要哪个菜单、算哪种操作。
 * PRD §1.4：View 只读；Edit = View + 修改既有记录；Full = 新建、删除、发布等全部操作。
 * feature：账号级功能开关（owner 2026-11-20），课程路由带 course.<action>，
 * operations 带 module.operations；守卫按 features.ts 的生效规则判定。
 */
export type RouteAccess =
  | { kind: 'public' }
  /** Portal 学员端经服务间密钥调用（X-API-Key），不走员工会话。 */
  | { kind: 'service' }
  /** KS 内部接口（/api/ks/**），只给 Agent 用：Bearer KS_SERVICE_TOKEN。 */
  | { kind: 'internal' }
  /**
   * Portal → Admin 的 Helpdesk 集成接口（/api/integration/helpdesk/**，Figma addendum §E）：
   * 明确豁免员工登录，只认 Bearer ADMIN_HELPDESK_TOKEN（为空 503，错 401，problem+json）。
   */
  | { kind: 'helpdeskIntegration' }
  /** 只要求登录（会话、改密、语言偏好）。 */
  | { kind: 'signedIn' }
  /** 其余 /api/admin/**：PRD §3.3 仅 Admin。 */
  | { kind: 'employeeAdmin' }
  /**
   * 员工账号管理（/api/admin/employees/**）：归 accounts 能力；
   * VIEW = 账号列表（仅 Admin 基线），写 = FULL；
   * 功能权限 GET/PUT 用 PUBLISH（只有 Full/Admin 可读可改，避免泄露他人 grants）。
   */
  | { kind: 'accountsAdmin'; action: ActionKind }
  /** 任一菜单在该角色下允许这种操作即可。 */
  | {
      kind: 'menu';
      menus: MenuKey[];
      action: ActionKind;
      feature?: FeatureKey;
      /** 任一功能键生效即放行（用于作业列表这类「导入或导出都该能看」的路径）。 */
      featuresAny?: FeatureKey[];
      /** 菜单检查之外还要求 Admin 角色（Notification Configuration，PRD §3/§11.3）。 */
      adminOnly?: boolean;
    };

const PUBLIC_AUTH = new Set([
  'email-check',
  'sign-in',
  'sign-out',
  'activate',
  'forgot-password',
  'reset-password',
  'token-status',
  'setup',
]);

/** AI Tutor 页面要读课程与版本、切换线上版本，这几条对 Knowledge 与 AI Tutor 都开放。 */
function sharedWithAiTutor(method: string, segments: string[]): boolean {
  const [first, , third] = segments;
  if (first === 'courses') {
    if (method === 'GET' && segments.length === 1) return true;
    if (method === 'GET' && segments.length === 3 && third === 'releases')
      return true;
    if (method === 'POST' && segments.length === 3 && third === 'set-live')
      return true;
  }
  return method === 'GET' && first === 'releases' && segments.length === 2;
}

/**
 * Knowledge / AI Tutor 接口的操作类型。GET 一律是查看；
 * 未在此登记的写接口按 CREATE 处理（只有 Full 可用），避免新接口默认放开。
 */
function actionFor(method: string, segments: string[]): ActionKind {
  if (method === 'GET' || method === 'HEAD') return 'VIEW';
  const [first, second, third] = segments;
  if (first === 'ai') {
    // 后台测试对话不改任何数据，只读角色也可试用
    if (second === 'chat-stream') return 'VIEW';
    if (second === 'config') {
      if (method === 'PUT' && segments.length === 2) return 'EDIT_EXISTING';
      if (method === 'POST' && segments[3] === 'reset') return 'EDIT_EXISTING';
      // 切换线上版本 / 上下线 = 发布
      return 'PUBLISH';
    }
    return 'CREATE';
  }
  if (first === 'files' && ['convert', 'images'].includes(second ?? ''))
    return 'EDIT_EXISTING';
  if (first === 'sync') return 'CREATE';
  if (first === 'courses' && segments.length === 3) {
    if (['release', 'activate-release', 'set-live'].includes(third ?? ''))
      return 'PUBLISH';
  }
  if (method === 'DELETE') return 'DELETE';
  if (method === 'PUT' || method === 'PATCH') return 'EDIT_EXISTING';
  return 'CREATE';
}

/**
 * /api/backoffice/courses/** 的操作类型（REQ-0236：Course=Edit 可查看及编辑已有 Course
 * 内容，但不能新增、删除或发布 Course）：
 * - GET 一律 VIEW；
 * - 新建课程（POST /courses）= CREATE；
 * - 导入/导出/确认/发布/删草稿/上下线/恢复 = PUBLISH（导入会整门新建或覆盖课程）；
 * - 价格、试看与 Stripe 同步属商业配置，不是课程内容，按 CREATE（只有 Full 可用）；
 * - 其余写操作都在某门已有课程（/courses/:id/...）之内，改的是课程内容
 *   （基本信息、多语言、课时增删排序、视频、展品、阅读、测验、封面、媒体上传），= EDIT_EXISTING；
 * - 未在此登记的写接口按 CREATE，避免新接口默认放开。
 */
const COURSE_PUBLISH_SEGMENTS = new Set([
  'confirm',
  'cancel',
  'publish',
  'delete-draft',
  'live-status',
  'restore',
]);
const COURSE_COMMERCIAL_SEGMENTS = new Set(['plans', 'trial', 'sync-stripe']);
const COURSE_CONTENT_SEGMENTS = new Set([
  'information',
  'localizations',
  'lessons',
  'media',
  'cover',
  'docx',
  'readings',
  'understanding',
]);

function backofficeCourseAction(
  method: string,
  segments: string[],
): ActionKind {
  // segments: ['backoffice', 'courses', ...rest]
  const rest = segments.slice(2);
  // 整包导入 / 导出（含作业状态与下载）各自独立成开关；
  // 必须在 GET→VIEW 早退之前判定，否则只读账号可凭 jobId 下载导出包。
  if (rest[0] === 'import') return 'IMPORT';
  if (rest[0] === 'export') return 'EXPORT';
  if (method === 'GET' || method === 'HEAD') return 'VIEW';
  if (rest.length === 0) return 'CREATE';
  // 对一门课的导入 / 导出（/courses/:id/import、/courses/:id/export）
  if (rest.length === 2 && rest[1] === 'import') return 'IMPORT';
  if (rest.length === 2 && rest[1] === 'export') return 'EXPORT';
  // 对一门课的发布级动作（/courses/:id/publish ...）
  if (rest.length === 2 && COURSE_PUBLISH_SEGMENTS.has(rest[1]))
    return 'PUBLISH';
  if (rest.some((seg) => COURSE_COMMERCIAL_SEGMENTS.has(seg))) return 'CREATE';
  if (rest.length === 1 && method === 'PUT') return 'EDIT_EXISTING';
  if (rest.length === 1 && method === 'DELETE') return 'DELETE';
  if (rest.length >= 2 && COURSE_CONTENT_SEGMENTS.has(rest[1]))
    return 'EDIT_EXISTING';
  return 'CREATE';
}

/** /api/admin/employees/**：读 = VIEW；写 = FULL；功能权限 GET/PUT 只有 Full 可读写。 */
function accountsAdminAction(method: string, segments: string[]): ActionKind {
  // segments: ['admin', 'employees', :id, 'features']
  if (segments.length >= 4 && segments[3] === 'features') return 'PUBLISH';
  return method === 'GET' || method === 'HEAD' ? 'VIEW' : 'CREATE';
}

export function routeAccess(method: string, path: string): RouteAccess {
  // Express 路由默认不区分大小写（/API/courses 也会命中 /api/courses），
  // 这里同样按小写判定，否则大写路径会被当成非 /api 放行
  const trimmed = path.toLowerCase().replace(/\/+$/, '');
  if (trimmed !== '/api' && !trimmed.startsWith('/api/'))
    return { kind: 'public' };
  const segments = trimmed.slice('/api'.length).split('/').filter(Boolean);
  const [first, second] = segments;
  const verb = method.toUpperCase();

  if (!first || first === 'health') return { kind: 'public' };
  if (first === 'auth') {
    return second && PUBLIC_AUTH.has(second)
      ? { kind: 'public' }
      : { kind: 'signedIn' };
  }
  if (first === 'user') return { kind: 'service' };
  if (first === 'portal') return { kind: 'service' };
  if (first === 'ks') return { kind: 'internal' };
  if (first === 'integration' && second === 'helpdesk')
    return { kind: 'helpdeskIntegration' };
  if (first === 'session' || first === 'preferences')
    return { kind: 'signedIn' };
  if (first === 'admin') {
    // 员工账号管理归独立能力 accounts；其余 /api/admin/** 仍是 settings/Admin-only
    return second === 'employees'
      ? { kind: 'accountsAdmin', action: accountsAdminAction(verb, segments) }
      : { kind: 'employeeAdmin' };
  }
  // HelpDesk 工单（Tickets v1 §7）与 Common Questions（Figma addendum §A）：读 = VIEW；
  // 任何写（回复、内部备注、认领、请学员确认、标签、已读、问答增改 / 发布 / 归档 / 排序）
  // 都按 CREATE 处理，只有该菜单为 Full 的角色可用
  if (first === 'helpdesk') {
    return {
      kind: 'menu',
      menus: ['helpDesk'],
      action: verb === 'GET' || verb === 'HEAD' ? 'VIEW' : 'CREATE',
    };
  }
  // 学生管理（Student Management PRD §2）：读 = VIEW（所有能看 Student 菜单的角色），
  // 改单人访问、停用 / 启用、改邮箱、发链接都按 CREATE 处理，只有 Student 为 Full 的角色（Admin、Operation Admin）可用
  if (first === 'students') {
    return {
      kind: 'menu',
      menus: ['student'],
      action: verb === 'GET' || verb === 'HEAD' ? 'VIEW' : 'CREATE',
    };
  }
  // Settings › Learning Access & Experiments（PRD §7）：只读角色可看；全局开关与紧急关闭只给 Settings 为 Full 的角色
  if (first === 'learning-access') {
    return {
      kind: 'menu',
      menus: ['settings'],
      action: verb === 'GET' || verb === 'HEAD' ? 'VIEW' : 'PUBLISH',
    };
  }
  if (first === 'backoffice') {
    // 环境标识是所有后台页面的公共信息
    if (second === 'environment') return { kind: 'signedIn' };
    // Notification Configuration（Settings 子页）：仅 Admin 且 Settings 生效；
    // 读 = VIEW，写（保存/开关/测试/广播/撤回）= PUBLISH（Settings 必须 FULL）
    if (second === 'notifications') {
      return {
        kind: 'menu',
        menus: ['settings'],
        action: verb === 'GET' || verb === 'HEAD' ? 'VIEW' : 'PUBLISH',
        adminOnly: true,
      };
    }
    // 运营位（/api/backoffice/operations/**）：读 = VIEW；保存/发布 = PUBLISH；
    // 独立 module.operations 开关（账号级），环境能力另由 operations 能力门管
    if (second === 'operations') {
      return {
        kind: 'menu',
        menus: ['course'],
        action: verb === 'GET' || verb === 'HEAD' ? 'VIEW' : 'PUBLISH',
        feature: 'module.operations',
      };
    }
    // Sandbox 课程内容重置（/api/backoffice/sandbox/**）：破坏性运维动作，只给 ADMIN。
    // 不新增环境能力（未设置 ADMIN_CAPABILITIES = 全开，会连带把生产打开）；
    // 环境与开关守卫在 SandboxResetService（SANDBOX_RESET_ENABLED + APP_ENV=SANDBOX）。
    if (second === 'sandbox') return { kind: 'employeeAdmin' };
    // 只有 courses 前缀归课程菜单；其它未登记的 /api/backoffice/<x> 一律 Admin-only，
    // 避免以后新增控制器忘记登记时被所有 course VIEW 账号读到（fail-closed）。
    if (second !== 'courses') return { kind: 'employeeAdmin' };
    // 作业列表同时暴露导入/导出作业，必须与 IMPORT / EXPORT 开关一致：
    // 只有 course.view 的账号不能读作业元数据（docs/sandbox/permissions.md §4）。
    if (
      second === 'courses' &&
      segments[2] === 'jobs' &&
      segments[3] === 'list'
    ) {
      return {
        kind: 'menu',
        menus: ['course'],
        action: 'VIEW',
        featuresAny: ['course.import', 'course.export'],
      };
    }
    // 商品课程 v2（/api/backoffice/courses/**）：导入/导出/发布各自独立成动作开关；
    // 新建/删除没有账号级开关（只由角色矩阵控制），路由不带 feature。
    const action = backofficeCourseAction(verb, segments);
    const feature = COURSE_ACTION_FEATURE[action];
    return {
      kind: 'menu',
      menus: ['course'],
      action,
      ...(feature ? { feature } : {}),
    };
  }
  const action = actionFor(verb, segments);
  if (first === 'ai') return { kind: 'menu', menus: ['aiTutor'], action };
  if (sharedWithAiTutor(verb, segments))
    return { kind: 'menu', menus: ['knowledge', 'aiTutor'], action };
  if (
    ['courses', 'pages', 'releases', 'sync', 'files', 'tags'].includes(first)
  ) {
    return { kind: 'menu', menus: ['knowledge'], action };
  }
  // 新接口必须在这里登记菜单；未登记的只给 Admin，避免默认放开。
  return { kind: 'employeeAdmin' };
}
