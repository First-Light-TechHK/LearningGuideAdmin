import type { PoolClient } from 'pg';

import { withTransaction } from './db';

/**
 * 「最后一个可用账号管理员」相关写入的串行化锁。
 * 角色/状态降级与功能开关保存都必须先拿同一把事务级 advisory lock，
 * 否则两个管理员可以并发互相降级/关闭账号管理，各自都看到对方仍可用，最后留下 0 个管理员。
 * 事务结束（COMMIT/ROLLBACK）自动释放。
 */
export const ADMIN_GUARD_LOCK_KEY = 780_311_020;

export function withAdminGuard<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [
      ADMIN_GUARD_LOCK_KEY,
    ]);
    return fn(client);
  });
}
