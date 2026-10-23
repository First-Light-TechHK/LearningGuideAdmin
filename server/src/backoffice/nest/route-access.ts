import type { MenuKey } from '../modules/rbac/permissions';

/**
 * 每个 /api 请求归哪一类、要哪个菜单：BackOffice 只做菜单级权限，
 * 菜单可见就能用该菜单背后的全部接口，不可见就一律拒绝。
 */
export type RouteAccess =
  | { kind: 'public' }
  /** Portal 学员端经服务间密钥调用（X-API-Key），不走员工会话。 */
  | { kind: 'service' }
  /** 只要求登录（会话、改密、语言偏好）。 */
  | { kind: 'signedIn' }
  /** 员工账号管理：PRD §3.3 仅 Admin。 */
  | { kind: 'employeeAdmin' }
  /** 任一菜单可见即可。 */
  | { kind: 'menu'; menus: MenuKey[] };

const PUBLIC_AUTH = new Set([
  'email-check',
  'sign-in',
  'sign-out',
  'activate',
  'forgot-password',
  'reset-password',
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

export function routeAccess(method: string, path: string): RouteAccess {
  const trimmed = path.replace(/\/+$/, '');
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
  if (first === 'session' || first === 'preferences')
    return { kind: 'signedIn' };
  if (first === 'admin') return { kind: 'employeeAdmin' };
  if (first === 'ai') return { kind: 'menu', menus: ['aiTutor'] };
  if (sharedWithAiTutor(verb, segments))
    return { kind: 'menu', menus: ['knowledge', 'aiTutor'] };
  if (
    ['courses', 'pages', 'releases', 'sync', 'files', 'tags'].includes(first)
  ) {
    return { kind: 'menu', menus: ['knowledge'] };
  }
  // 新接口必须在这里登记菜单；未登记的只给 Admin，避免默认放开。
  return { kind: 'employeeAdmin' };
}
