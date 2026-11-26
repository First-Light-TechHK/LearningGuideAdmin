import { Inject, Injectable, Optional, OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { sslConfig } from '../backoffice/lib/db';
import { databaseUrl } from '../backoffice/lib/env';

/** Global per-database lock shared by all Sandbox course writers and reset workers. */
export const SANDBOX_WRITE_LOCK_KEY = '721743920411';
export type SandboxLockMode = 'shared' | 'exclusive';

export class SandboxLockLease {
  private released = false;
  constructor(private readonly client: PoolClient, private readonly mode: SandboxLockMode) {}

  /** Finish while still holding the exclusive lock on this same connection. */
  async finishReset(jobId: string, status: 'SUCCEEDED' | 'FAILED', report: Record<string, unknown>, error: string | null): Promise<void> {
    if (this.mode !== 'exclusive' || this.released) throw new Error('Reset lock is not held');
    const result = await this.client.query(
      `UPDATE "SandboxResetJob" SET status=$2, stage=$3, progress=100, report=$4::jsonb, error=$5, "finishedAt"=now(), "heartbeatAt"=now(), "updatedAt"=now() WHERE id=$1 AND status='RUNNING'`,
      [jobId, status, status === 'SUCCEEDED' ? 'DONE' : 'FAILED', JSON.stringify(report), error],
    );
    if (result.rowCount !== 1) throw new Error('Reset job no longer owns the maintenance state');
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      await this.client.query(this.mode === 'shared' ? 'SELECT pg_advisory_unlock_shared($1::bigint)' : 'SELECT pg_advisory_unlock($1::bigint)', [SANDBOX_WRITE_LOCK_KEY]);
      this.client.release();
    } catch (error) {
      this.client.release(error instanceof Error ? error : new Error('Lock release failed'));
      throw error;
    }
  }
}

@Injectable()
export class SandboxWriteLock implements OnModuleDestroy {
  private ownPool?: Pool;
  constructor(@Optional() @Inject('SANDBOX_LOCK_POOL') private readonly injectedPool?: Pick<Pool, 'connect'>) {}
  async acquire(mode: SandboxLockMode): Promise<SandboxLockLease | null> {
    if (!this.injectedPool && !this.ownPool) {
      const connectionString = databaseUrl();
      this.ownPool = new Pool({ connectionString, ssl: sslConfig(connectionString), max: 20, connectionTimeoutMillis: 5000 });
    }
    const client = await (this.injectedPool ?? this.ownPool!).connect();
    try {
      const sql = mode === 'shared' ? 'SELECT pg_try_advisory_lock_shared($1::bigint) AS locked' : 'SELECT pg_try_advisory_lock($1::bigint) AS locked';
      const result = await client.query<{ locked: boolean }>(sql, [SANDBOX_WRITE_LOCK_KEY]);
      if (!result.rows[0]?.locked) { client.release(); return null; }
      return new SandboxLockLease(client, mode);
    } catch (error) {
      client.release(error instanceof Error ? error : new Error('Lock acquisition failed'));
      throw error;
    }
  }
  async onModuleDestroy(): Promise<void> { if (this.ownPool) await this.ownPool.end(); }

}
