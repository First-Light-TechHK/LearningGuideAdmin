import { randomBytes } from 'node:crypto';

/**
 * UUIDv7（RFC 9562 §5.7）：前 48 位为 Unix 毫秒时间戳，随后版本号 7、74 位随机数、变体 10。
 * 按时间可排序，便于做主键与分页游标。Agent、KS、BackOffice 共用，不含业务逻辑。
 */
export function uuidv7(at: number = Date.now()): string {
  const bytes = randomBytes(16);
  const millis = BigInt(Math.max(0, Math.floor(at)));
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((millis >> BigInt(8 * (5 - i))) & 0xffn);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 任意版本的 UUID 文本（大小写不敏感）。 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
