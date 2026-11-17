import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

/**
 * Migration test harness: a throwaway database that is built migration by migration, so a test can
 * stop just before a migration, load legacy rows (written for the OLD schema), apply the migration
 * and look at what it did to them. The database is dropped afterwards.
 *
 * It uses the server in DATABASE_URL but never that database itself.
 */
const MIGRATIONS_DIR = path.resolve(__dirname, '../../prisma/migrations');
const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');

export interface ScratchDatabase {
  name: string;
  client: Client;
  notices: string[];
  /** Apply the migrations in order. `before` stops ahead of that migration (exclusive). */
  applyMigrations(options?: { before?: string; only?: string }): Promise<void>;
  /** Run a SQL file from test/fixtures. */
  loadFixture(file: string): Promise<void>;
  drop(): Promise<void>;
}

function connectionFor(database: string): string {
  const url = new URL(
    process.env.DATABASE_URL ?? 'postgresql://admin@localhost:5433/postgres',
  );
  url.pathname = `/${database}`;
  url.search = '';
  return url.toString();
}

export function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function createScratchDatabase(): Promise<ScratchDatabase> {
  const name = `lg_mig_${randomBytes(5).toString('hex')}`;
  const admin = new Client({ connectionString: connectionFor('postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionFor(name) });
  await client.connect();
  const notices: string[] = [];
  client.on('notice', (notice) => notices.push(notice.message ?? ''));

  return {
    name,
    client,
    notices,
    async applyMigrations(options = {}) {
      for (const migration of migrationNames()) {
        if (options.before && migration >= options.before) break;
        if (options.only && migration !== options.only) continue;
        const sql = readFileSync(
          path.join(MIGRATIONS_DIR, migration, 'migration.sql'),
          'utf8',
        );
        try {
          await client.query(sql);
        } catch (error) {
          throw new Error(
            `migration ${migration} failed: ${(error as Error).message}`,
          );
        }
      }
    },
    async loadFixture(file) {
      await client.query(readFileSync(path.join(FIXTURES_DIR, file), 'utf8'));
    },
    async drop() {
      await client.end();
      const dropper = new Client({
        connectionString: connectionFor('postgres'),
      });
      await dropper.connect();
      await dropper.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await dropper.end();
    },
  };
}
