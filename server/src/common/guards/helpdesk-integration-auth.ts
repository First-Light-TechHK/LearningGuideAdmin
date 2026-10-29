import { timingSafeEqual } from 'node:crypto';

/**
 * Helpdesk 服务间鉴权（Figma addendum §E）：Portal 调 Admin 的
 * /api/integration/helpdesk/** 只认 `Authorization: Bearer <ADMIN_HELPDESK_TOKEN>`（RFC 6750）。
 * - 令牌每次请求现读，轮换后无需重启；
 * - 令牌为空 → disabled（503 integration_disabled），本地开发也不放行；
 * - 定长比较（timingSafeEqual），长度不同直接拒绝。
 */
export type HelpdeskIntegrationAuth = 'ok' | 'disabled' | 'unauthorized';

export function helpdeskIntegrationToken(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const token = env.ADMIN_HELPDESK_TOKEN?.trim();
  return token ? token : undefined;
}

export function checkHelpdeskIntegrationToken(
  authorization: string | string[] | undefined,
  expected: string | undefined,
): HelpdeskIntegrationAuth {
  const token = expected?.trim();
  if (!token) return 'disabled';
  const header = Array.isArray(authorization)
    ? authorization[0]
    : authorization;
  const match = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? '');
  if (!match) return 'unauthorized';
  const provided = Buffer.from(match[1]);
  const wanted = Buffer.from(token);
  return provided.length === wanted.length && timingSafeEqual(provided, wanted)
    ? 'ok'
    : 'unauthorized';
}
