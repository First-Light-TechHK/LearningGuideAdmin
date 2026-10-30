import type { ActionKind, MenuKey } from '../modules/rbac/permissions';

/**
 * 每个 /api 请求归哪一类、要哪个菜单、算哪种操作。
 * PRD §1.4：View 只读；Edit = View + 修改既有记录；Full = 新建、删除、发布等全部操作。
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
  /** 员工账号管理：PRD §3.3 仅 Admin。 */
  | { kind: 'employeeAdmin' }
  /** 任一菜单在该角色下允许这种操作即可。 */
  | { kind: 'menu'; menus: MenuKey[]; action: ActionKind };

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
  if (first === 'files' && second === 'convert') return 'EDIT_EXISTING';
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
 * /api/backoffice/courses/** 的操作类型：
 * - GET 一律 VIEW；
 * - import/export/confirm/publish-uat/approve/go-live/live-status/restore = PUBLISH；
 * - 其余写操作按 CREATE。
 */
function backofficeCourseAction(
  method: string,
  segments: string[],
): ActionKind {
  if (method === 'GET' || method === 'HEAD') return 'VIEW';
  const publishSegments = new Set([
    'import',
    'export',
    'confirm',
    'cancel',
    'publish-uat',
    'approve',
    'go-live',
    'live-status',
    'restore',
  ]);
  if (segments.some((seg) => publishSegments.has(seg))) return 'PUBLISH';
  return 'CREATE';
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
  if (first === 'admin') return { kind: 'employeeAdmin' };
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
  if (first === 'backoffice') {
    // 商品课程 v2（/api/backoffice/courses/**）：导入/导出/发布=发布级动作
    const action = backofficeCourseAction(verb, segments);
    return { kind: 'menu', menus: ['course'], action };
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
