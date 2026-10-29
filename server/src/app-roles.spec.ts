import { ALL_ROLES, learnerApiOpenWarning, parseAppRoles } from './app-roles';

describe('parseAppRoles', () => {
  it('不设或为空时三个角色全开（拆分前的行为）', () => {
    expect(parseAppRoles(undefined)).toEqual([...ALL_ROLES]);
    expect(parseAppRoles(' , ')).toEqual([...ALL_ROLES]);
  });

  it('按固定顺序去重，忽略大小写与空格', () => {
    expect(parseAppRoles(' KS, agent ,ks')).toEqual(['agent', 'ks']);
  });

  it('未知角色直接启动失败，避免拼错后静默少起服务', () => {
    expect(() => parseAppRoles('agent,tutor')).toThrow(/tutor/);
  });
});

describe('learnerApiOpenWarning', () => {
  it('生产环境起了 agent 却没开 AUTH_ENABLED 时给出提示', () => {
    expect(
      learnerApiOpenWarning({ NODE_ENV: 'production' }, ['agent']),
    ).toMatch(/AUTH_ENABLED/);
    expect(
      learnerApiOpenWarning({ NODE_ENV: 'production', AUTH_ENABLED: 'false' }, [
        'admin',
        'agent',
      ]),
    ).not.toBeNull();
  });

  it('已开鉴权、非生产或没起 agent 时不提示', () => {
    expect(
      learnerApiOpenWarning({ NODE_ENV: 'production', AUTH_ENABLED: 'true' }, [
        'agent',
      ]),
    ).toBeNull();
    expect(
      learnerApiOpenWarning({ NODE_ENV: 'development' }, ['agent']),
    ).toBeNull();
    expect(
      learnerApiOpenWarning({ NODE_ENV: 'production' }, ['admin', 'ks']),
    ).toBeNull();
  });
});
