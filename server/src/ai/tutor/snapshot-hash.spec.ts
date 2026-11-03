import { snapshotHash } from './snapshot-hash';

describe('snapshotHash', () => {
  it('ignores object key order but preserves array order', () => {
    expect(snapshotHash({ b: 2, a: [1, 2] })).toBe(
      snapshotHash({ a: [1, 2], b: 2 }),
    );
    expect(snapshotHash({ a: [1, 2] })).not.toBe(snapshotHash({ a: [2, 1] }));
  });
  it('rejects values that cannot be represented unambiguously as JSON', () => {
    expect(() => snapshotHash({ a: undefined })).toThrow();
    expect(() => snapshotHash({ a: NaN })).toThrow();
    expect(() => snapshotHash(new Date())).toThrow();
    expect(() => snapshotHash(Array(1))).toThrow();
  });
});
