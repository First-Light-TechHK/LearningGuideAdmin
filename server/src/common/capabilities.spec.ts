import {
  ALL_CAPABILITIES,
  CAPABILITY_IDS,
  capabilityForPath,
  capabilityGateAllows,
  isCapabilityEnabled,
  parseEnabledCapabilities,
  type CapabilityId,
} from './capabilities';

const set = (...ids: CapabilityId[]) => new Set(ids);

describe('ADMIN_CAPABILITIES 能力解析', () => {
  it('未配置或为空 = 全部能力启用（dev / sit / uat / prod 行为零变化）', () => {
    for (const raw of [undefined, '', '   ', ' , ']) {
      const enabled = parseEnabledCapabilities(raw);
      expect(enabled.size).toBe(CAPABILITY_IDS.length);
      expect(enabled).toEqual(ALL_CAPABILITIES);
    }
  });

  it('解析子集：去空白、忽略大小写、自动去重', () => {
    expect(parseEnabledCapabilities('course')).toEqual(set('course'));
    expect(parseEnabledCapabilities(' COURSE , Students ,course ')).toEqual(
      set('course', 'students'),
    );
  });

  it('未知能力标识直接报错（与 APP_ROLES 同一先例，拼错不能静默关掉模块）', () => {
    expect(() => parseEnabledCapabilities('course,marketing')).toThrow(
      /ADMIN_CAPABILITIES 含未知能力：marketing/,
    );
  });
});

describe('能力门：路径前缀 → 能力映射表', () => {
  it('映射表只包含已知能力标识', () => {
    for (const path of [
      '/api/backoffice/courses',
      '/api/backoffice/operations',
      '/api/backoffice/notifications/templates',
      '/api/helpdesk/tickets',
      '/api/integration/helpdesk/faqs',
      '/api/students',
      '/api/ai/config',
      '/api/user/ai-tutors',
      '/api/ks/v1/courses',
      '/api/portal/v1/courses',
      '/api/courses',
      '/api/pages/p1',
      '/api/releases/r1',
      '/api/sync/all',
      '/api/files/convert',
      '/api/tags',
      '/api/admin/employees',
      '/api/learning-access',
    ]) {
      const owners = capabilityForPath(path);
      expect(owners).not.toBeNull();
      for (const capability of owners ?? []) {
        expect(CAPABILITY_IDS).toContain(capability);
      }
    }
  });

  it('必须放行：健康检查、登录/登出/会话/账户自身、环境端点、非 API 前端资源', () => {
    const courseOnly = parseEnabledCapabilities('course');
    for (const path of [
      '/api',
      '/api/',
      '/api/health',
      '/api/health/ready',
      '/api/auth/sign-in',
      '/api/auth/sign-out',
      '/api/auth/change-password',
      '/api/auth/forgot-password',
      '/api/auth/reset-password',
      '/api/session',
      '/api/preferences/sidebar',
      '/api/preferences/locale',
      '/api/backoffice/environment',
      '/api/backoffice/environment?locale=zh-CN',
      '/',
      '/index.html',
      '/assets/index-abc123.js',
      '/version.json',
    ]) {
      expect(capabilityGateAllows(path, courseOnly)).toBe(true);
      expect(capabilityForPath(path)).toBeNull();
    }
  });

  it('course 只放行课程管理前缀（大小写、查询串、尾斜杠同 Express 语义）', () => {
    const courseOnly = parseEnabledCapabilities('course');
    for (const path of [
      '/api/backoffice/courses',
      '/api/backoffice/courses/',
      '/api/backoffice/courses/abc/publish',
      '/api/backoffice/courses/import/raw/session?x=1',
      '/API/BackOffice/Courses/abc',
    ]) {
      expect(capabilityGateAllows(path, courseOnly)).toBe(true);
    }
  });

  it('未启用能力的前缀在沙箱配置（course）下一律拒绝', () => {
    const courseOnly = parseEnabledCapabilities('course');
    for (const path of [
      '/api/backoffice/operations',
      '/api/backoffice/operations/popular-courses',
      '/api/backoffice/notifications/templates',
      '/api/helpdesk/tickets',
      '/api/helpdesk/faqs/f1',
      '/api/integration/helpdesk/suggest',
      '/api/students',
      '/api/students/s1',
      '/api/ai/config',
      '/api/ai/chat-stream',
      '/api/user/ai-tutors',
      '/api/user/courses',
      '/api/ks/v1/courses',
      '/api/courses',
      '/api/courses/c1/pages',
      '/api/pages/p1',
      '/api/releases/r1',
      '/api/sync/all',
      '/api/files/convert',
      '/api/tags',
      '/api/admin/employees',
      '/api/learning-access',
      '/API/HelpDesk/tickets',
    ]) {
      expect(capabilityGateAllows(path, courseOnly)).toBe(false);
    }
  });

  it('accounts 是独立能力：员工账号管理归 accounts，不再归 settings', () => {
    expect(capabilityForPath('/api/admin/employees')).toEqual(['accounts']);
    expect(capabilityForPath('/API/Admin/Employees/abc/features')).toEqual([
      'accounts',
    ]);
    expect(capabilityForPath('/api/admin/other')).toEqual(['settings']);
    expect(capabilityForPath('/api/learning-access')).toEqual(['settings']);

    const accountsOnly = parseEnabledCapabilities('accounts');
    expect(capabilityGateAllows('/api/admin/employees', accountsOnly)).toBe(
      true,
    );
    expect(capabilityGateAllows('/api/learning-access', accountsOnly)).toBe(
      false,
    );

    const settingsOnly = parseEnabledCapabilities('settings');
    expect(capabilityGateAllows('/api/learning-access', settingsOnly)).toBe(
      true,
    );
    expect(capabilityGateAllows('/api/admin/employees', settingsOnly)).toBe(
      false,
    );

    const sandbox = parseEnabledCapabilities('course,accounts');
    expect(capabilityGateAllows('/api/admin/employees', sandbox)).toBe(true);
    expect(capabilityGateAllows('/api/learning-access', sandbox)).toBe(false);
  });

  it('共享前缀（courses / releases）只要任一所属能力启用就放行', () => {
    const aiOnly = parseEnabledCapabilities('ai');
    expect(capabilityForPath('/api/courses')).toEqual(['knowledge', 'ai']);
    expect(capabilityGateAllows('/api/courses', aiOnly)).toBe(true);
    expect(capabilityGateAllows('/api/releases/r1', aiOnly)).toBe(true);
    expect(capabilityGateAllows('/api/pages/p1', aiOnly)).toBe(false);

    const knowledgeOnly = parseEnabledCapabilities('knowledge');
    expect(capabilityGateAllows('/api/pages/p1', knowledgeOnly)).toBe(true);
    expect(capabilityGateAllows('/api/ai/config', knowledgeOnly)).toBe(false);
  });

  it('未登记路径不归能力门管，放行给既有 401/403 与 404', () => {
    const courseOnly = parseEnabledCapabilities('course');
    for (const path of [
      '/api/something-new',
      '/api/backoffice/unknown',
      '/api/coursesx',
      '/api/backoffice/coursesx',
      '/api/adminx',
    ]) {
      expect(capabilityForPath(path)).toBeNull();
      expect(capabilityGateAllows(path, courseOnly)).toBe(true);
    }
  });

  it('空能力集拒绝所有已登记模块前缀', () => {
    const none = new Set<CapabilityId>();
    expect(capabilityGateAllows('/api/health', none)).toBe(true);
    expect(capabilityGateAllows('/api/backoffice/courses', none)).toBe(false);
  });
});

describe('isCapabilityEnabled（启动期后台入口的同一语义）', () => {
  it('未配置 ADMIN_CAPABILITIES = 启用', () => {
    expect(isCapabilityEnabled('helpdesk', undefined)).toBe(true);
    expect(isCapabilityEnabled('helpdesk', '')).toBe(true);
  });

  it('只开 course 时关闭 helpdesk，显式包含时启用', () => {
    expect(isCapabilityEnabled('helpdesk', 'course')).toBe(false);
    expect(isCapabilityEnabled('course', 'course')).toBe(true);
    expect(isCapabilityEnabled('helpdesk', 'course, helpdesk')).toBe(true);
  });

  it('未知能力启动即报错（不静默关闭）', () => {
    expect(() => isCapabilityEnabled('course', 'cours')).toThrow(
      /ADMIN_CAPABILITIES/,
    );
  });
});
