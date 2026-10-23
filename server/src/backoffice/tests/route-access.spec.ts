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

  it('puts AI configuration behind the AI Tutor menu', () => {
    assert.deepEqual(routeAccess('PUT', '/api/ai/config'), {
      kind: 'menu',
      menus: ['aiTutor'],
    });
    assert.deepEqual(routeAccess('POST', '/api/ai/chat-stream'), {
      kind: 'menu',
      menus: ['aiTutor'],
    });
  });

  it('shares the course and release reads the AI Tutor page needs', () => {
    const shared = { kind: 'menu', menus: ['knowledge', 'aiTutor'] };
    assert.deepEqual(routeAccess('GET', '/api/courses'), shared);
    assert.deepEqual(routeAccess('GET', '/api/courses/c1/releases'), shared);
    assert.deepEqual(routeAccess('GET', '/api/releases/r1'), shared);
    assert.deepEqual(routeAccess('POST', '/api/courses/c1/set-live'), shared);
  });

  it('keeps every other knowledge endpoint behind the Knowledge menu', () => {
    const knowledge = { kind: 'menu', menus: ['knowledge'] };
    assert.deepEqual(routeAccess('GET', '/api/courses/c1'), knowledge);
    assert.deepEqual(routeAccess('PUT', '/api/courses/c1'), knowledge);
    assert.deepEqual(routeAccess('DELETE', '/api/releases/r1'), knowledge);
    assert.deepEqual(routeAccess('POST', '/api/courses/c1/release'), knowledge);
    assert.deepEqual(routeAccess('PUT', '/api/pages/p1'), knowledge);
    assert.deepEqual(routeAccess('POST', '/api/sync/all'), knowledge);
    assert.deepEqual(routeAccess('POST', '/api/files/convert'), knowledge);
    assert.deepEqual(routeAccess('GET', '/api/tags'), knowledge);
  });

  it('classifies upper-case paths like Express routes them (case-insensitive)', () => {
    assert.deepEqual(routeAccess('GET', '/API/Courses'), {
      kind: 'menu',
      menus: ['knowledge', 'aiTutor'],
    });
    assert.deepEqual(routeAccess('POST', '/Api/Sync/all'), {
      kind: 'menu',
      menus: ['knowledge'],
    });
    assert.deepEqual(routeAccess('GET', '/API/USER/ai-tutors'), {
      kind: 'service',
    });
    assert.deepEqual(routeAccess('GET', '/API/admin/employees'), {
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
