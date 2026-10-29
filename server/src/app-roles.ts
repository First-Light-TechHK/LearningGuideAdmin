/**
 * 同一镜像按角色启动（docs/Engine_Split_Implementation.md）：
 * - admin：员工入口（BackOffice、知识编写、AI Tutor 配置与后台测试对话）
 * - agent：Portal 与学习小组调用的 Tutor 运行时（/api/user/**）
 * - ks：给 Agent 用的 KS 内部接口（/api/ks/v1/**）
 * APP_ROLES 不设时三个角色都起，即拆分前的行为。
 */
export type AppRole = 'admin' | 'agent' | 'ks';

export const ALL_ROLES: readonly AppRole[] = ['admin', 'agent', 'ks'];

export function parseAppRoles(raw: string | undefined): AppRole[] {
  const items = (raw ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (items.length === 0) return [...ALL_ROLES];
  const unknown = items.filter(
    (item) => !(ALL_ROLES as readonly string[]).includes(item),
  );
  if (unknown.length > 0) {
    throw new Error(
      `APP_ROLES 含未知角色：${unknown.join(', ')}（可选 ${ALL_ROLES.join(', ')}）`,
    );
  }
  return ALL_ROLES.filter((role) => items.includes(role));
}

/**
 * 学员端 /api/user/** 只靠 AUTH_ENABLED + AUTH_TOKEN 保护（api-key.guard）。
 * 部署环境（NODE_ENV=production）起了 agent 却没开鉴权时返回提示文案，否则 null。
 */
export function learnerApiOpenWarning(
  env: NodeJS.ProcessEnv,
  roles: readonly AppRole[],
): string | null {
  if (env.NODE_ENV !== 'production') return null;
  if (!roles.includes('agent')) return null;
  if (env.AUTH_ENABLED === 'true') return null;
  return '安全配置缺失：NODE_ENV=production 但 AUTH_ENABLED 不是 true，学员端 /api/user/** 无需 X-API-Key 即可调用（会消耗 LLM 额度）。请设置 AUTH_ENABLED=true 与 AUTH_TOKEN。';
}
