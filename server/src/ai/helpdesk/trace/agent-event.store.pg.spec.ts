import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import { uuidv7 } from '../../../common/uuidv7';
import type { PrismaService } from '../../../prisma/prisma.service';
import { describeAgentEventLog } from './agent-event-log.conformance-spec';
import { PrismaAgentEventLog } from './agent-event.store';

/**
 * helpdesk_agent_events 实测（helpdesk-agent-v2-pi-dsh §2）：同一套 conformance 用例 + 库里的
 * 只追加触发器（DELETE、改信封、改 data 一律拒绝，只放行 90 天清学员原文）。
 * 需要 HELPDESK_TEST_DATABASE_URL；CI 必须真的跑（没给库就失败）。
 */
const url = process.env.HELPDESK_TEST_DATABASE_URL;
if (!url && process.env.CI === 'true')
  throw new Error('HELPDESK_TEST_DATABASE_URL is required when CI=true');
const describeDb = url ? describe : describe.skip;
const MIGRATIONS = join(__dirname, '../../../../prisma/migrations');

const schema = `hdevt_${process.pid}_${Date.now()}`;
let admin: Pool;
let prisma: PrismaClient;

async function setUp(): Promise<PrismaAgentEventLog> {
  admin = new Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const sql = readdirSync(MIGRATIONS)
    .filter((dir) => dir.includes('helpdesk'))
    .sort()
    .map((dir) => readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8'))
    .join('\n');
  await admin.query(`SET search_path TO ${schema}; ${sql}`);
  await admin.query('SET search_path TO public');
  const withSchema = new URL(url as string);
  withSchema.searchParams.set('schema', schema);
  prisma = new PrismaClient({
    datasources: { db: { url: withSchema.toString() } },
  });
  return new PrismaAgentEventLog(prisma as unknown as PrismaService);
}

describeDb('PrismaAgentEventLog (PostgreSQL)', () => {
  afterAll(async () => {
    await prisma?.$disconnect();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  describeAgentEventLog('PostgreSQL log', setUp);

  describe('the table itself refuses rewrites', () => {
    const runId = uuidv7();
    const sql = (text: string) =>
      admin.query(`SET search_path TO ${schema}; ${text}`);

    beforeAll(async () => {
      await sql(`INSERT INTO helpdesk_agent_events (run_id, seq, type, time, data) VALUES
        ('${runId}', 1, 'turn/start', now(), '{"turn":1,"input":{"message":"hi"}}'),
        ('${runId}', 2, 'turn/end', now(), '{"turn":1,"reason":"no_match"}')`);
    });

    it.each([
      [
        'a DELETE',
        `DELETE FROM helpdesk_agent_events WHERE run_id = '${runId}'`,
      ],
      [
        'a data rewrite',
        `UPDATE helpdesk_agent_events SET data = '{"turn":1,"reason":"answered"}' WHERE seq = 2 AND run_id = '${runId}'`,
      ],
      [
        'moving an event',
        `UPDATE helpdesk_agent_events SET seq = 9 WHERE seq = 2 AND run_id = '${runId}'`,
      ],
      [
        'changing the type',
        `UPDATE helpdesk_agent_events SET type = 'feedback' WHERE seq = 2 AND run_id = '${runId}'`,
      ],
      [
        'changing the time',
        `UPDATE helpdesk_agent_events SET time = now() - interval '1 day' WHERE seq = 1 AND run_id = '${runId}'`,
      ],
      [
        'dropping a non-learner field',
        `UPDATE helpdesk_agent_events SET data = data - 'turn' WHERE seq = 1 AND run_id = '${runId}'`,
      ],
    ])('rejects %s', async (_name, statement) => {
      await expect(sql(statement)).rejects.toThrow(/append-only/);
    });

    it('rejects a seq of 0, an unknown type and a non-object data', async () => {
      for (const values of [
        `('${runId}', 0, 'feedback', now(), '{}')`,
        `('${runId}', 3, 'chat/message', now(), '{}')`,
        `('${runId}', 3, 'feedback', now(), '[]')`,
      ]) {
        await expect(
          sql(
            `INSERT INTO helpdesk_agent_events (run_id, seq, type, time, data) VALUES ${values}`,
          ),
        ).rejects.toThrow(/check constraint/);
      }
    });

    it('allows only the learner-text purge', async () => {
      await sql(
        `UPDATE helpdesk_agent_events SET data = data - 'input' WHERE seq = 1 AND run_id = '${runId}'`,
      );
      const { rows } = await admin.query(
        `SELECT data FROM ${schema}.helpdesk_agent_events WHERE run_id = $1 ORDER BY seq`,
        [runId],
      );
      expect(rows.map((r: { data: unknown }) => r.data)).toEqual([
        { turn: 1 },
        { turn: 1, reason: 'no_match' },
      ]);
    });
  });
});
