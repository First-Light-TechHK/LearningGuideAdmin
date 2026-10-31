import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { isUuid } from '../../../src/common/uuidv7';
import {
  closePool,
  query,
  withTransaction,
} from '../../../src/backoffice/lib/db';
import { createPgFaqGraphRepository } from '../../../src/backoffice/modules/helpdesk/faqs/faqGraphRepository';
import { createFaqGraphService } from '../../../src/backoffice/modules/helpdesk/faqs/faqGraphService';
import {
  parseFaqLibrary,
  seedExitCode,
  seedFaqLibrary,
} from '../../../src/backoffice/modules/helpdesk/faqs/faqLibrarySeed';
import { createPgFaqMapRepository } from '../../../src/backoffice/modules/helpdesk/faqs/faqMapRepository';
import {
  parseMapSeed,
  seedFaqMap,
} from '../../../src/backoffice/modules/helpdesk/faqs/faqMapSeed';
import {
  createFaqReleaseService,
  createPgFaqReleaseSource,
} from '../../../src/backoffice/modules/helpdesk/faqs/faqReleaseService';
import {
  createPgFaqRepository,
  type SqlDb,
} from '../../../src/backoffice/modules/helpdesk/faqs/faqRepository';
import { createFaqService } from '../../../src/backoffice/modules/helpdesk/faqs/faqService';
import { createEnvFaqVectorIndexer } from '../../../src/backoffice/modules/helpdesk/faqs/faqVectors';
import { isLocalDatabase, removeDemoRows, seedDemoRows } from './helpdeskDemo';

/**
 * 演示数据：FAQ 卡片库 v3.1（650 张）+ 流程树 + 四周的对话记录、候选卡、夜间任务、卡片审核。
 *
 *   DATABASE_URL=… npm run seed:helpdesk-demo                 灌（再跑一次不重复）
 *   DATABASE_URL=… npm run seed:helpdesk-demo -- --remove     删掉全部演示行（id 以 de000000- 开头）
 *
 * FAQ 卡片是正式内容，--remove 不删卡。默认只连本机数据库；DEV 等远端库要加 --allow-remote，
 * 由负责人确认后运行。放在 eval/ 下，不进 nest build。
 */
const LIBRARY = join(__dirname, '..', 'library', 'faq-library-v3.1.json');
const MAP = join(__dirname, '..', 'library', 'faq-map-v3.1.json');
const USAGE =
  'usage: npm run seed:helpdesk-demo -- [--remove] [--no-library] [--employee-id <uuid>] [--allow-remote]';

const db: SqlDb = {
  query: (sql, params) => query(sql, params),
  withTransaction: (fn) => withTransaction((client) => fn(client)),
};

async function seedLibrary(employeeId: string | null, release: boolean) {
  const library = parseFaqLibrary(JSON.parse(readFileSync(LIBRARY, 'utf8')));
  const repository = createPgFaqRepository();
  const graph = createPgFaqGraphRepository();
  const releaseSource = createPgFaqReleaseSource(graph);
  const indexer = createEnvFaqVectorIndexer();
  const indexing: Promise<unknown>[] = [];
  try {
    const report = await seedFaqLibrary(
      {
        faqs: createFaqService({
          repository,
          releaseVersion: () => releaseSource.publishedVersion(),
          liveParents: (id) => graph.liveParents(id),
        }),
        repository,
        graph: createFaqGraphService({ graph }),
        releases: createFaqReleaseService({
          graph,
          vectors: {
            index(version) {
              const done = indexer.index(version);
              indexing.push(done);
              return done;
            },
          },
        }),
      },
      library,
      { actor: { employeeId }, release },
    );
    await Promise.all(indexing);
    return report;
  } finally {
    await Promise.allSettled(indexing);
  }
}

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
        JSON.stringify({ removed: await removeDemoRows(db) }, null, 2),
      );
      return;
    }
    const out: Record<string, unknown> = {};
    if (!values['no-library']) {
      // 先导卡，再导流程树，最后发布：发布把卡和树一起冻结进版本
      const library = await seedLibrary(employeeId, false);
      const map = await seedFaqMap(
        { map: createPgFaqMapRepository(), faqs: createPgFaqRepository() },
        (() => {
          const seed = JSON.parse(readFileSync(MAP, 'utf8')) as {
            skeleton: unknown;
            placements: unknown[];
          };
          return parseMapSeed(seed.skeleton, seed.placements);
        })(),
        { employeeId },
      );
      const release = await seedLibrary(employeeId, true);
      out.library = summary(library);
      out.map = { placements: map.placements };
      out.release = summary(release);
      if (seedExitCode(release) !== 0 || map.placements.missingCards.length > 0)
        process.exitCode = 1;
    }
    out.demo = await seedDemoRows(db);
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await closePool();
  }
}

/** 库报告里 key 列表很长，列表只留个数。 */
function summary(value: unknown): unknown {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, summary(inner)]),
    );
  return value;
}

void main();
