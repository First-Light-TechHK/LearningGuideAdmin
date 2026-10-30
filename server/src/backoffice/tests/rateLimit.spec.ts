import assert from 'node:assert/strict';

import { clear, consume, peek } from '../lib/rateLimit';

describe('rate limiting', () => {
  it('allows exactly the configured number of attempts', async () => {
    const key = `test-allow-${Date.now()}`;
    for (let i = 0; i < 3; i += 1) {
      assert.equal(
        (await consume(key, 3, 5)).allowed,
        true,
        `attempt ${i + 1}`,
      );
    }
    assert.equal((await consume(key, 3, 5)).allowed, false);
  });

  it('reports a positive retry delay once the window is exhausted', async () => {
    const key = `test-retry-${Date.now()}`;
    await consume(key, 1, 5);
    const blocked = await consume(key, 1, 5);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSeconds > 0);
  });

  it('keeps buckets independent per key', async () => {
    const stamp = Date.now();
    await consume(`test-a-${stamp}`, 1, 5);
    assert.equal((await consume(`test-a-${stamp}`, 1, 5)).allowed, false);
    assert.equal((await consume(`test-b-${stamp}`, 1, 5)).allowed, true);
  });

  it('peeks without counting and clears a window on demand', async () => {
    const key = `test-peek-${Date.now()}`;
    for (let i = 0; i < 5; i += 1)
      assert.equal((await peek(key, 2)).allowed, true);
    await consume(key, 2, 5);
    await consume(key, 2, 5);
    assert.equal((await peek(key, 2)).allowed, false);
    await clear(key);
    assert.equal((await peek(key, 2)).allowed, true);
  });
});
