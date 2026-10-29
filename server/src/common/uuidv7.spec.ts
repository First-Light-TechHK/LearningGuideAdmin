import { isUuid, uuidv7 } from './uuidv7';

/** RFC 9562 UUIDv7：48 位毫秒时间戳 + 版本 7 + 变体 10xx，按时间可排序。 */
describe('uuidv7', () => {
  it('has the v7 version nibble and the RFC 9562 variant', () => {
    const id = uuidv7();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(isUuid(id)).toBe(true);
  });

  it('puts the millisecond timestamp in the first 48 bits', () => {
    const at = Date.UTC(2026, 9, 28, 6, 45, 0, 123);
    const id = uuidv7(at);
    const millis = parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    expect(millis).toBe(at);
  });

  it('sorts by creation time and does not repeat', () => {
    const early = uuidv7(1_000);
    const late = uuidv7(2_000);
    expect(early < late).toBe(true);
    const many = new Set(Array.from({ length: 500 }, () => uuidv7()));
    expect(many.size).toBe(500);
  });

  it('isUuid accepts any RFC 4122/9562 UUID text and rejects junk', () => {
    expect(isUuid('01920000-0000-7000-8000-000000000001')).toBe(true);
    expect(isUuid('01920000-0000-7000-8000-00000000000Z')).toBe(false);
    expect(isUuid('../etc/passwd')).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
});
