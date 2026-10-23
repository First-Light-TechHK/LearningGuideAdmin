import { Pool, type PoolClient, type QueryResultRow } from "pg";

import { databaseUrl } from "@/lib/env";

declare global {
  var __lgboPool: Pool | undefined;
}

/** 单例连接池：开发态模块热重载时避免连接泄漏。 */
export function pool(): Pool {
  if (!global.__lgboPool) {
    global.__lgboPool = new Pool({
      connectionString: databaseUrl(),
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return global.__lgboPool;
}

export async function query<T extends QueryResultRow>(
  sql: string,
  params: readonly unknown[] = []
): Promise<T[]> {
  const result = await pool().query<T>(sql, params as unknown[]);
  return result.rows;
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
