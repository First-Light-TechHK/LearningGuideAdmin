import { createHmac, randomBytes } from 'node:crypto';

import { sessionSecret } from '../../../lib/env';

/** 任何落库的令牌都只保存 HMAC（INV-NO-PLAINTEXT-SECRET）。 */
export function hashToken(rawToken: string): string {
  return createHmac('sha256', sessionSecret()).update(rawToken).digest('hex');
}

export function generateRawToken(): string {
  return randomBytes(32).toString('base64url');
}
