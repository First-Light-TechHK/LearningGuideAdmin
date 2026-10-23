import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import { databaseUrl } from './env';

let sharedPool: Pool | undefined;

/** 员工身份与会话表走原生 SQL（触发器、条件更新），与 Prisma 共用同一个 DATABASE_URL。 */
export function pool(): Pool {
  if (!sharedPool) {
    sharedPool = new Pool({
      connectionString: databaseUrl(),
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return sharedPool;
}

export async function closePool(): Promise<void> {
  const current = sharedPool;
  sharedPool = undefined;
  if (current) await current.end();
}

export async function query<T extends QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await pool().query<T>(sql, params as unknown[]);
  return result.rows;
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
