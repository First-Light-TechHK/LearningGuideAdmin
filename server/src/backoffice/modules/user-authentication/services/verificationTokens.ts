import {
  ACTIVATION_TOKEN_HOURS,
  RESET_TOKEN_HOURS,
} from '../../../lib/securityPolicy';
import * as tokenRepository from '../../../repositories/tokenRepository';
import type { TokenPurpose } from '../../../repositories/tokenRepository';
import { generateRawToken, hashToken } from './tokenHash';

export type TokenState =
  'USABLE' | 'NOT_FOUND' | 'USED' | 'REVOKED' | 'EXPIRED';

type ClassifiableToken = {
  consumedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
} | null;

/**
 * 纯判定函数（PRD PORT-ACT-003 要求区分「已过期」与「已使用」）。
 * 顺序即优先级：已消费 > 已吊销 > 已过期 > 可用。
 */
export function classifyTokenState(
  record: ClassifiableToken,
  nowMs: number = Date.now(),
): TokenState {
  if (!record) return 'NOT_FOUND';
  if (record.consumedAt) return 'USED';
  if (record.revokedAt) return 'REVOKED';
  if (record.expiresAt.getTime() <= nowMs) return 'EXPIRED';
  return 'USABLE';
}

export type TokenErrorCode =
  'INVALID_TOKEN' | 'TOKEN_EXPIRED' | 'TOKEN_ALREADY_USED';

/** 把令牌状态翻译成对外的稳定错误码，供页面选择专用面板。 */
export function tokenStateToErrorCode(state: TokenState): TokenErrorCode {
  if (state === 'EXPIRED') return 'TOKEN_EXPIRED';
  if (state === 'USED' || state === 'REVOKED') return 'TOKEN_ALREADY_USED';
  return 'INVALID_TOKEN';
}

function expiryFor(purpose: TokenPurpose): Date {
  const hours =
    purpose === 'ACTIVATION' ? ACTIVATION_TOKEN_HOURS : RESET_TOKEN_HOURS;
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

export async function issueActivationToken(
  employeeId: string,
): Promise<string> {
  const raw = generateRawToken();
  await tokenRepository.issueToken({
    employeeId,
    purpose: 'ACTIVATION',
    tokenHash: hashToken(raw),
    expiresAt: expiryFor('ACTIVATION'),
  });
  return raw;
}

export async function issueResetToken(employeeId: string): Promise<string> {
  const raw = generateRawToken();
  await tokenRepository.issueToken({
    employeeId,
    purpose: 'PASSWORD_RESET',
    tokenHash: hashToken(raw),
    expiresAt: expiryFor('PASSWORD_RESET'),
  });
  return raw;
}

/** appUrl 由控制器给出：优先 BACKOFFICE_APP_URL，其次发起请求的 BackOffice 站点。 */
export function activationLink(
  appUrl: string,
  locale: string,
  rawToken: string,
): string {
  return `${appUrl}/${locale}/activate?token=${encodeURIComponent(rawToken)}`;
}

export function resetLink(
  appUrl: string,
  locale: string,
  rawToken: string,
): string {
  return `${appUrl}/${locale}/reset-password?token=${encodeURIComponent(rawToken)}`;
}

export async function inspectToken(
  rawToken: string,
  purpose: TokenPurpose,
): Promise<{
  state: TokenState;
  employeeId: string | null;
  tokenId: string | null;
}> {
  const record = await tokenRepository.findByHash(hashToken(rawToken), purpose);
  return {
    state: classifyTokenState(record),
    employeeId: record?.employeeId ?? null,
    tokenId: record?.tokenId ?? null,
  };
}

/** 单次消费：并发请求只有一个能成功（INV-ONE-USE-TOKEN）。 */
export async function consumeOnce(tokenId: string): Promise<boolean> {
  return tokenRepository.consumeToken(tokenId);
}

export async function revokeTokensForEmployee(
  employeeId: string,
  purpose?: TokenPurpose,
): Promise<void> {
  await tokenRepository.revokeOutstandingTokens(
    employeeId,
    purpose ?? undefined,
  );
}
