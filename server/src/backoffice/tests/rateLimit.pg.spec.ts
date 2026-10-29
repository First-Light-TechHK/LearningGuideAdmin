import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as db from '../lib/db';
import * as rateLimit from '../lib/rateLimit';

/**
 * PostgreSQL 实测：部署后限流计数在 backoffice_rate_limits 表里，多实例共用一份。
 * 需要 HELPDESK_TEST_DATABASE_URL（本地临时库）；未设置时跳过，CI=true 时必须给。
 */
const url = process.env.HELPDESK_TEST_DATABASE_URL;
if (!url && process.env.CI === 'true')
  throw new Error('HELPDESK_TEST_DATABASE_URL is required when CI=true');
const describeDb = url ? describe : describe.skip;

describeDb('rate limiting (PostgreSQL store)', () => {
  const saved = {
    url: process.env.DATABASE_URL,
    store: process.env.BACKOFFICE_RATE_LIMIT_STORE,
  };

  // 连接池在第一次查询时才读 DATABASE_URL，存储方式每次调用时判断，所以这里改环境变量即可
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BACKOFFICE_RATE_LIMIT_STORE = 'db';
    await db.query(
      readFileSync(
        join(
          __dirname,
          '../../../prisma/migrations/20261030090000_backoffice_rate_limits/migration.sql',
        ),
        'utf8',
      ),
    );
    await db.query(`DELETE FROM backoffice_rate_limits WHERE key LIKE 'pg-test-%'`);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM backoffice_rate_limits WHERE key LIKE 'pg-test-%'`);
    await db.closePool();
    process.env.DATABASE_URL = saved.url;
    if (saved.store === undefined) delete process.env.BACKOFFICE_RATE_LIMIT_STORE;
    else process.env.BACKOFFICE_RATE_LIMIT_STORE = saved.store;
  });

  it('allows exactly the configured number of attempts, even when they race', async () => {
    const key = `pg-test-race-${Date.now()}`;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => rateLimit.consume(key, 3, 5)),
    );
    assert.equal(results.filter((r) => r.allowed).length, 3);
    const blocked = results.find((r) => !r.allowed);
    assert.ok(blocked && blocked.retryAfterSeconds > 0);
  });

  it('peeks without counting and clears a window on demand', async () => {
    const key = `pg-test-peek-${Date.now()}`;
    for (let i = 0; i < 5; i += 1)
      assert.equal((await rateLimit.peek(key, 2)).allowed, true);
    await rateLimit.consume(key, 2, 5);
    await rateLimit.consume(key, 2, 5);
    assert.equal((await rateLimit.peek(key, 2)).allowed, false);
    await rateLimit.clear(key);
    assert.equal((await rateLimit.peek(key, 2)).allowed, true);
  });

  it('starts a new window once the old one has expired', async () => {
    const key = `pg-test-expired-${Date.now()}`;
    await db.query(
      `INSERT INTO backoffice_rate_limits (key, count, resets_at) VALUES ($1, 99, now() - interval '1 second')`,
      [key],
    );
    assert.equal((await rateLimit.peek(key, 1)).allowed, true);
    assert.equal((await rateLimit.consume(key, 1, 5)).allowed, true);
    assert.equal((await rateLimit.consume(key, 1, 5)).allowed, false);
  });
});
