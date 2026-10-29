import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import { databaseUrl } from './env';

let sharedPool: Pool | undefined;

/**
 * RDS 打开 `rds.force_ssl=1` 后，未加密的连接会被 pg_hba 拒绝
 * （`no pg_hba.conf entry ... no encryption`）。Prisma 默认协商 TLS，
 * node-postgres 不会，所以原生 SQL 连接必须显式声明 SSL。
 * 本机/容器内开发库默认关闭；可用 PGSSL=true/false 覆盖。
 */
export function sslConfig(
  url: string,
): false | { rejectUnauthorized: boolean } {
  const explicit = process.env.PGSSL?.trim().toLowerCase();
  if (explicit === 'false' || explicit === 'disable') return false;
  const isLocal = /@(?:localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(
    url,
  );
  if (isLocal && explicit !== 'true') return false;
  // RDS 使用 Amazon 签发证书；未挂载 CA 包时跳过链校验（连接仍然加密）。
  return { rejectUnauthorized: process.env.PGSSL_STRICT === 'true' };
}

/** 员工身份与会话表走原生 SQL（触发器、条件更新），与 Prisma 共用同一个 DATABASE_URL。 */
export function pool(): Pool {
  if (!sharedPool) {
    const connectionString = databaseUrl();
    sharedPool = new Pool({
      connectionString,
      ssl: sslConfig(connectionString),
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
