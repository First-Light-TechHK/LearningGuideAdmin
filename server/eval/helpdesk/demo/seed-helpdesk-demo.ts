import { parseArgs } from 'node:util';

import { isUuid } from '../../../src/common/uuidv7';
import { closePool } from '../../../src/backoffice/lib/db';
import { isLocalDatabase } from '../../../src/backoffice/modules/helpdesk/demo/helpdeskDemo';
import {
  removeHelpdeskDemo,
  seedHelpdeskDemo,
} from '../../../src/backoffice/modules/helpdesk/demo/helpdeskDemoSeed';

/**
 * 演示数据：FAQ 卡片库 v3.1（650 张）+ 流程树 + 四周的对话记录、候选卡、夜间任务、卡片审核。
 *
 *   DATABASE_URL=… npm run seed:helpdesk-demo                 灌（再跑一次不重复）
 *   DATABASE_URL=… npm run seed:helpdesk-demo -- --remove     删掉全部演示行（id 以 de000000- 开头）
 *
 * 部署的 DEV 启动时会自动灌一次（HelpdeskDemoBoot），不用手动跑。FAQ 卡片是正式内容，--remove 不删卡；
 * 删过之后重启也不会再灌回来。命令行默认只连本机数据库，远端库要加 --allow-remote。
 */
const USAGE =
  'usage: npm run seed:helpdesk-demo -- [--remove] [--no-library] [--employee-id <uuid>] [--allow-remote]';

async function main(): Promise<void> {
  let values: {
    remove?: boolean;
    'no-library'?: boolean;
    'employee-id'?: string;
    'allow-remote'?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      strict: true,
      options: {
        remove: { type: 'boolean' },
        'no-library': { type: 'boolean' },
        'employee-id': { type: 'string' },
        'allow-remote': { type: 'boolean' },
      },
    }));
  } catch (error) {
    console.error(
      `${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
    process.exitCode = 2;
    return;
  }
  const employeeId = values['employee-id'] ?? null;
  if (employeeId !== null && !isUuid(employeeId)) {
    console.error(`--employee-id must be a UUID\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const url = process.env.DATABASE_URL ?? '';
  if (!url) {
    console.error(`DATABASE_URL is not set\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (!isLocalDatabase(url) && !values['allow-remote']) {
    console.error(
      'DATABASE_URL is not a local database. Demo rows go to a shared database only with --allow-remote.',
    );
    process.exitCode = 2;
    return;
  }
  try {
    if (values.remove) {
      console.log(
        JSON.stringify({ removed: await removeHelpdeskDemo() }, null, 2),
      );
      return;
    }
    const report = await seedHelpdeskDemo({
      employeeId,
      library: !values['no-library'],
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally {
    await closePool();
  }
}

void main();
