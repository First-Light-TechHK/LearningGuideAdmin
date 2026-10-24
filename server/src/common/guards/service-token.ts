import { timingSafeEqual } from 'node:crypto';

/**
 * 服务间令牌校验：Authorization: Bearer <token>，定长比较。
 * 未配置令牌时只在本地放行（deployed=false），部署环境一律拒绝。
 */
export function serviceTokenAllows(
  authorization: string | string[] | undefined,
  expected: string | undefined,
  deployed: boolean,
): boolean {
  const token = expected?.trim();
  if (!token) return !deployed;
  const header = Array.isArray(authorization)
    ? authorization[0]
    : authorization;
  const match = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? '');
  if (!match) return false;
  const provided = Buffer.from(match[1].trim());
  const wanted = Buffer.from(token);
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}
