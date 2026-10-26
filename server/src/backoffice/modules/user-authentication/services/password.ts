import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * PRD PORT-SEC-001：现代哈希 + 每账号独立盐，绝不存明文。
 * 存储格式：scrypt$N$r$p$saltBase64$hashBase64
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptWithParams(plain, salt);
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export async function verifyPassword(
  plain: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const saltPart = parts[4];
  const hashPart = parts[5];
  if (!saltPart || !hashPart) return false;

  const expected = Buffer.from(hashPart, 'base64');
  if (expected.length === 0) return false;

  const salt = Buffer.from(saltPart, 'base64');
  const derived = await scryptWithParams(plain, salt);
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

async function scryptWithParams(plain: string, salt: Buffer): Promise<Buffer> {
  // Node 默认参数 N=16384 / r=8 / p=1（约 16MB 内存），与存储格式记录的 N/r/p 一致
  const derived = await scrypt(plain, salt, KEY_LENGTH);
  return Buffer.from(derived);
}
