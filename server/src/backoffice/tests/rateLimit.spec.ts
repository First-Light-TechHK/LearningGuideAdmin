import assert from 'node:assert/strict';

import { consume } from '../lib/rateLimit';

describe('rate limiting', () => {
  it('allows exactly the configured number of attempts', () => {
    const key = `test-allow-${Date.now()}`;
    for (let i = 0; i < 3; i += 1) {
      assert.equal(consume(key, 3, 5).allowed, true, `attempt ${i + 1}`);
    }
    assert.equal(consume(key, 3, 5).allowed, false);
  });

  it('reports a positive retry delay once the window is exhausted', () => {
    const key = `test-retry-${Date.now()}`;
    consume(key, 1, 5);
    const blocked = consume(key, 1, 5);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSeconds > 0);
  });

  it('keeps buckets independent per key', () => {
    const stamp = Date.now();
    consume(`test-a-${stamp}`, 1, 5);
    assert.equal(consume(`test-a-${stamp}`, 1, 5).allowed, false);
    assert.equal(consume(`test-b-${stamp}`, 1, 5).allowed, true);
  });
});
