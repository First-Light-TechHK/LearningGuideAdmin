import assert from 'node:assert/strict';

import { canViewMenu, type MenuKey } from '../modules/rbac/permissions';
import { routeAccess } from '../nest/route-access';

describe('route access classification', () => {
  it('keeps health, the API root and the sign-in flow public', () => {
    for (const path of [
      '/api',
      '/api/health',
      '/api/auth/email-check',
      '/api/auth/sign-in',
      '/api/auth/sign-out',
      '/api/auth/activate',
      '/api/auth/forgot-password',
      '/api/auth/reset-password',
      '/api/auth/setup',
    ]) {
      assert.deepEqual(routeAccess('POST', path), { kind: 'public' }, path);
    }
  });

  it('leaves the Portal learner API on the service key', () => {
    assert.deepEqual(routeAccess('GET', '/api/user/ai-tutors'), {
      kind: 'service',
    });
    assert.deepEqual(routeAccess('POST', '/api/user/ai/chat-stream'), {
      kind: 'service',
    });
  });

  it('puts the KS internal API behind the service token, never a session', () => {
    for (const path of [
      '/api/ks/v1/courses',
      '/api/ks/v1/releases/r1',
      '/API/KS/v1/courses/c1/tutor-online',
    ]) {
      assert.deepEqual(routeAccess('GET', path), { kind: 'internal' }, path);
    }
  });

  it('needs only a session for session, preferences and change password', () => {
    assert.deepEqual(routeAccess('GET', '/api/session'), { kind: 'signedIn' });
    assert.deepEqual(routeAccess('POST', '/api/preferences/locale'), {
      kind: 'signedIn',
    });
    assert.deepEqual(routeAccess('POST', '/api/auth/change-password'), {
      kind: 'signedIn',
    });
  });

  it('keeps employee accounts Admin-only', () => {
    assert.deepEqual(routeAccess('GET', '/api/admin/employees'), {
      kind: 'employeeAdmin',
    });
    assert.deepEqual(routeAccess('PATCH', '/api/admin/employees/x'), {
      kind: 'employeeAdmin',
    });
  });

  const menu = (menus: string[], action: string) => ({
    kind: 'menu',
    menus,
    action,
  });

  it('puts AI configuration behind the AI Tutor menu', () => {
    assert.deepEqual(
      routeAccess('PUT', '/api/ai/config'),
      menu(['aiTutor'], 'EDIT_EXISTING'),
    );
    assert.deepEqual(
      routeAccess('POST', '/api/ai/chat-stream'),
      menu(['aiTutor'], 'VIEW'),
    );
    assert.deepEqual(
      routeAccess('PUT', '/api/ai/config/c1/online'),
      menu(['aiTutor'], 'PUBLISH'),
    );
    assert.deepEqual(
      routeAccess('PUT', '/api/ai/config/c1/active-release'),
      menu(['aiTutor'], 'PUBLISH'),
    );
    assert.deepEqual(
      routeAccess('POST', '/api/ai/config/c1/reset'),
      menu(['aiTutor'], 'EDIT_EXISTING'),
    );
  });

  it('shares the course and release reads the AI Tutor page needs', () => {
    const shared = ['knowledge', 'aiTutor'];
    assert.deepEqual(routeAccess('GET', '/api/courses'), menu(shared, 'VIEW'));
    assert.deepEqual(
      routeAccess('GET', '/api/courses/c1/releases'),
      menu(shared, 'VIEW'),
    );
    assert.deepEqual(
      routeAccess('GET', '/api/releases/r1'),
      menu(shared, 'VIEW'),
    );
    assert.deepEqual(
      routeAccess('POST', '/api/courses/c1/set-live'),
      menu(shared, 'PUBLISH'),
    );
  });

  it('keeps every other knowledge endpoint behind the Knowledge menu with its action', () => {
    const k = ['knowledge'];
    const cases: [string, string, string][] = [
      ['GET', '/api/courses/c1', 'VIEW'],
      ['POST', '/api/courses', 'CREATE'],
      ['PUT', '/api/courses/c1', 'EDIT_EXISTING'],
      ['DELETE', '/api/courses/c1', 'DELETE'],
      ['POST', '/api/courses/c1/release', 'PUBLISH'],
      ['POST', '/api/courses/c1/activate-release', 'PUBLISH'],
      ['DELETE', '/api/releases/r1', 'DELETE'],
      ['POST', '/api/courses/c1/pages', 'CREATE'],
      ['PUT', '/api/courses/c1/pages/reorder', 'EDIT_EXISTING'],
      ['PUT', '/api/pages/p1', 'EDIT_EXISTING'],
      ['DELETE', '/api/pages/p1', 'DELETE'],
      ['GET', '/api/sync/external-courses', 'VIEW'],
      ['POST', '/api/sync/structure', 'CREATE'],
      ['POST', '/api/sync/all', 'CREATE'],
      ['POST', '/api/files/convert', 'EDIT_EXISTING'],
      ['GET', '/api/tags', 'VIEW'],
      ['POST', '/api/tags', 'CREATE'],
      ['PUT', '/api/tags/t1', 'EDIT_EXISTING'],
      ['DELETE', '/api/tags/t1', 'DELETE'],
    ];
    for (const [method, path, action] of cases) {
      assert.deepEqual(
        routeAccess(method, path),
        menu(k, action),
        `${method} ${path}`,
      );
    }
  });

  it('classifies upper-case paths like Express routes them (case-insensitive)', () => {
    assert.deepEqual(
      routeAccess('GET', '/API/Courses'),
      menu(['knowledge', 'aiTutor'], 'VIEW'),
    );
    assert.deepEqual(
      routeAccess('POST', '/Api/Sync/all'),
      menu(['knowledge'], 'CREATE'),
    );
    assert.deepEqual(routeAccess('GET', '/API/USER/ai-tutors'), {
      kind: 'service',
    });
    assert.deepEqual(routeAccess('GET', '/API/admin/employees'), {
      kind: 'employeeAdmin',
    });
  });

  it('puts HelpDesk tickets behind the HelpDesk menu: reads are VIEW, every write needs FULL', () => {
    const h = ['helpDesk'];
    const cases: [string, string, string][] = [
      ['GET', '/api/helpdesk/tickets', 'VIEW'],
      ['GET', '/api/helpdesk/tickets/t1', 'VIEW'],
      ['GET', '/api/helpdesk/attachments/a1', 'VIEW'],
      ['POST', '/api/helpdesk/tickets/t1/messages', 'CREATE'],
      ['POST', '/api/helpdesk/tickets/t1/actions', 'CREATE'],
      ['PUT', '/api/helpdesk/tickets/t1', 'CREATE'],
      ['PATCH', '/api/helpdesk/tickets/t1', 'CREATE'],
      ['DELETE', '/api/helpdesk/tickets/t1', 'CREATE'],
      ['POST', '/API/HelpDesk/tickets/t1/actions', 'CREATE'],
    ];
    for (const [method, path, action] of cases) {
      assert.deepEqual(
        routeAccess(method, path),
        menu(h, action),
        `${method} ${path}`,
      );
    }
  });

  it('puts the FAQs (Tickets v2 §3) behind the HelpDesk menu too', () => {
    const h = ['helpDesk'];
    const cases: [string, string, string][] = [
      ['GET', '/api/helpdesk/faqs', 'VIEW'],
      ['GET', '/api/helpdesk/faqs/f1', 'VIEW'],
      ['GET', '/api/helpdesk/faqs/f1/revisions', 'VIEW'],
      ['POST', '/api/helpdesk/faqs', 'CREATE'],
      ['PUT', '/api/helpdesk/faqs/f1', 'CREATE'],
      ['POST', '/api/helpdesk/faqs/f1/archive', 'CREATE'],
    ];
    for (const [method, path, action] of cases) {
      assert.deepEqual(
        routeAccess(method, path),
        menu(h, action),
        `${method} ${path}`,
      );
    }
  });

  it('exempts only the Portal helpdesk integration routes from the employee login (Bearer only)', () => {
    for (const [method, path] of [
      ['GET', '/api/integration/helpdesk/faqs'],
      ['GET', '/api/integration/helpdesk/faqs?locale=en-GB'],
      ['GET', '/api/integration/helpdesk/faqs/f1?locale=zh-CN'],
      ['POST', '/api/integration/helpdesk/suggest'],
      ['POST', '/api/integration/helpdesk/suggestions/s1/outcome'],
      ['GET', '/API/Integration/HelpDesk/faqs/'],
    ]) {
      assert.deepEqual(
        routeAccess(method, path.split('?')[0]),
        { kind: 'helpdeskIntegration' },
        `${method} ${path}`,
      );
    }
    // 其它 integration 路径、或 helpdesk 前缀的变体都不享受豁免
    assert.deepEqual(routeAccess('GET', '/api/integration/other'), {
      kind: 'employeeAdmin',
    });
    assert.deepEqual(routeAccess('GET', '/api/integration'), {
      kind: 'employeeAdmin',
    });
    assert.deepEqual(routeAccess('GET', '/api/integration/helpdeskx/faqs'), {
      kind: 'employeeAdmin',
    });
  });

  it('gives unregistered endpoints to Admin only', () => {
    assert.deepEqual(routeAccess('GET', '/api/something-new'), {
      kind: 'employeeAdmin',
    });
  });

  it('locks Operation Admin out of Knowledge and AI Tutor endpoints', () => {
    const access = routeAccess('GET', '/api/courses');
    assert.equal(access.kind, 'menu');
    const menus = access.kind === 'menu' ? access.menus : ([] as MenuKey[]);
    assert.equal(
      menus.some((menu) => canViewMenu('OPERATION_ADMIN', menu)),
      false,
    );
    assert.equal(
      menus.some((menu) => canViewMenu('OPERATION_AI', menu)),
      true,
    );
  });
});
