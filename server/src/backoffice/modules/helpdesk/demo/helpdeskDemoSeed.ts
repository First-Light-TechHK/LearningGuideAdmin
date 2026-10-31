import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';

import { query, withTransaction } from '../../../lib/db';
import { createPgJobLock } from '../flywheel/flywheelJobs';
import { createPgFaqGraphRepository } from '../faqs/faqGraphRepository';
import { createFaqGraphService } from '../faqs/faqGraphService';
import {
  parseFaqLibrary,
  seedExitCode,
  seedFaqLibrary,
} from '../faqs/faqLibrarySeed';
import { createPgFaqMapRepository } from '../faqs/faqMapRepository';
import { parseMapSeed, seedFaqMap } from '../faqs/faqMapSeed';
import {
  createFaqReleaseService,
  createPgFaqReleaseSource,
} from '../faqs/faqReleaseService';
import { createPgFaqRepository, type SqlDb } from '../faqs/faqRepository';
import { createFaqService } from '../faqs/faqService';
import { createEnvFaqVectorIndexer } from '../faqs/faqVectors';
import { removeDemoRows, seedDemoRows, type DemoReport } from './helpdeskDemo';

/**
 * FAQ 卡片库 v3.1 + 流程树 + 发布 v1 + 演示行。命令行（eval/helpdesk/demo/seed-helpdesk-demo.ts）和
 * DEV 启动时自动灌（HelpdeskDemoBoot）共用这一份。库文件随 nest build 复制到 dist（nest-cli.json assets）。
 */
export const DEMO_LIBRARY_TAG = 'faq-library-v3.1';
const LIBRARY = join(__dirname, 'library', 'faq-library-v3.1.json');
const MAP = join(__dirname, 'library', 'faq-map-v3.1.json');
/** 记在 backoffice_settings：灌过一次就不再自动灌（--remove 之后也不会被启动灌回来）。 */
export const DEMO_MARKER_KEY = 'helpdesk_demo_seeded';
// 与夜间任务的锁（FLYWHEEL_LOCK = [719320, 1]）同一命名空间，第二个数不同
const DEMO_LOCK: readonly [number, number] = [719320, 2];

export const demoDb: SqlDb = {
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

export type HelpdeskDemoReport = {
  library?: unknown;
  map?: unknown;
  release?: unknown;
  demo: DemoReport;
  ok: boolean;
};

/** 先导卡，再导流程树，最后发布（发布把卡和树一起冻结进版本），然后写演示行。按 key / id 幂等。 */
export async function seedHelpdeskDemo(options: {
  employeeId: string | null;
  library: boolean;
}): Promise<HelpdeskDemoReport> {
  const out: HelpdeskDemoReport = {
    demo: {
      turns: 0,
      candidates: 0,
      skippedCandidates: [],
      runs: 0,
      reviews: 0,
    },
    ok: true,
  };
  if (options.library) {
    const library = await seedLibrary(options.employeeId, false);
    const raw = JSON.parse(readFileSync(MAP, 'utf8')) as {
      skeleton: unknown;
      placements: unknown[];
    };
    const map = await seedFaqMap(
      { map: createPgFaqMapRepository(), faqs: createPgFaqRepository() },
      parseMapSeed(raw.skeleton, raw.placements),
      { employeeId: options.employeeId },
    );
    const release = await seedLibrary(options.employeeId, true);
    out.library = summary(library);
    out.map = { placements: map.placements };
    out.release = summary(release);
    out.ok =
      seedExitCode(release) === 0 && map.placements.missingCards.length === 0;
  }
  out.demo = await seedDemoRows(demoDb);
  await demoDb.query(
    `INSERT INTO backoffice_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [DEMO_MARKER_KEY, DEMO_LIBRARY_TAG],
  );
  return out;
}

export function removeHelpdeskDemo() {
  return removeDemoRows(demoDb);
}

/**
 * 只有部署的 DEV 自动灌：APP_ENV 明确写着 DEV（不用 appEnvName 的默认值，漏配的环境不算）且
 * NODE_ENV=production（本机开发不灌）。HELPDESK_DEMO_DATA=off 可以关掉。SIT / UAT / PROD 永远不灌。
 */
export function shouldAutoSeedDemo(env: NodeJS.ProcessEnv): boolean {
  return (
    (env.APP_ENV ?? '').trim().toUpperCase() === 'DEV' &&
    env.NODE_ENV === 'production' &&
    (env.HELPDESK_DEMO_DATA ?? '').trim().toLowerCase() !== 'off'
  );
}

/**
 * DEV 启动后在后台灌一次（不阻塞启动和健康检查）。几个实例同时起时用 advisory lock 只让一个灌；
 * 灌过（backoffice_settings 有标记）就跳过。失败只记日志，下次启动再试。
 */
export async function autoSeedDemoOnce(
  logger: Pick<Logger, 'log' | 'warn'> = new Logger('HelpdeskDemo'),
): Promise<'skipped' | 'busy' | 'seeded' | 'failed'> {
  try {
    const marker = await demoDb.query(
      'SELECT value FROM backoffice_settings WHERE key = $1',
      [DEMO_MARKER_KEY],
    );
    if (marker.length > 0) return 'skipped';
    const result = await createPgJobLock(undefined, DEMO_LOCK).withLock(
      async () => {
        const again = await demoDb.query(
          'SELECT value FROM backoffice_settings WHERE key = $1',
          [DEMO_MARKER_KEY],
        );
        if (again.length > 0) return null;
        return seedHelpdeskDemo({ employeeId: null, library: true });
      },
    );
    if (!result.acquired) return 'busy';
    if (!result.value) return 'skipped';
    logger.log(
      JSON.stringify({
        type: 'helpdesk',
        event: 'demo_seeded',
        ok: result.value.ok,
        demo: result.value.demo,
      }),
    );
    return 'seeded';
  } catch (error) {
    logger.warn(
      JSON.stringify({
        type: 'helpdesk',
        event: 'demo_seed_failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return 'failed';
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
