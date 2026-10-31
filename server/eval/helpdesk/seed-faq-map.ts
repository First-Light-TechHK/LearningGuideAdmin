import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { isUuid } from '../../src/common/uuidv7';
import { closePool } from '../../src/backoffice/lib/db';
import { createPgFaqMapRepository } from '../../src/backoffice/modules/helpdesk/faqs/faqMapRepository';
import {
  parseMapSeed,
  seedFaqMap,
} from '../../src/backoffice/modules/helpdesk/faqs/faqMapSeed';
import { createPgFaqRepository } from '../../src/backoffice/modules/helpdesk/faqs/faqRepository';

/**
 * 导入流程树与对象表（设计文档「Helpdesk 定位方式对比」第三节）：
 *
 *   DATABASE_URL=… npm run seed:helpdesk-faq-map -- <map 目录> [--employee-id <uuid>]
 *
 * 目录里是 skeleton.json 与 placements/<卡的 key>.json（项目文件 faq-library/v3.1/map/）。按 key 幂等；
 * 不建发布版本（下一次「发布新版本」把结构冻结进快照）。找不到的卡列在报告里，退出码 1。
 */
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: { 'employee-id': { type: 'string' } },
  });
  const dir = positionals[0];
  const employeeId = values['employee-id'] ?? null;
  if (!dir || positionals.length > 1 || (employeeId && !isUuid(employeeId))) {
    console.error(
      'usage: npm run seed:helpdesk-faq-map -- <map dir> [--employee-id <uuid>]',
    );
    process.exitCode = 2;
    return;
  }
  const read = (path: string): unknown =>
    JSON.parse(readFileSync(path, 'utf8'));
  const placements = readdirSync(join(dir, 'placements'))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => read(join(dir, 'placements', name)));
  const seed = parseMapSeed(read(join(dir, 'skeleton.json')), placements);
  try {
    const report = await seedFaqMap(
      { map: createPgFaqMapRepository(), faqs: createPgFaqRepository() },
      seed,
      { employeeId },
    );
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.placements.missingCards.length > 0 ? 1 : 0;
  } finally {
    await closePool();
  }
}

void main();
