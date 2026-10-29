import { timingSafeEqual } from 'node:crypto';

/**
 * 服务间令牌校验，定长比较。
 *
 * 接受两种写法，值与 expected 一致即可：
 * - `Authorization: Bearer <token>`（Agent / 本服务既有调用）
 * - `X-API-Key: <token>`（Portal 的 KS_TUTOR_API_KEY 契约）
 *
 * 未配置令牌时只在本地放行（deployed=false），部署环境一律拒绝。
 */
export function serviceTokenAllows(
  authorization: string | string[] | undefined,
  expected: string | undefined,
  deployed: boolean,
  apiKeyHeader?: string | string[],
): boolean {
  const token = expected?.trim();
  if (!token) return !deployed;
  const header = Array.isArray(authorization)
    ? authorization[0]
    : authorization;
  const match = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? '');
  const apiKey = (
    Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader
  )?.trim();
  const providedRaw = match?.[1]?.trim() || apiKey;
  if (!providedRaw) return false;
  const provided = Buffer.from(providedRaw);
  const wanted = Buffer.from(token);
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}
