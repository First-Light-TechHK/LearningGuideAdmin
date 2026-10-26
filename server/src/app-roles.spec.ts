import { ALL_ROLES, parseAppRoles } from './app-roles';

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
