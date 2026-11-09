import { readFileSync } from 'node:fs';
import {
  HELPDESK_SETTINGS,
  readHelpdeskSetting,
} from '../../../../contracts/helpdesk-settings';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';

import { query, withTransaction } from '../../../lib/db';
import { createPgJobLock } from '../flywheel/flywheelJobs';
import { createPgFaqGraphRepository } from '../faqs/faqGraphRepository';
import { createFaqGraphService } from '../faqs/faqGraphService';
import {
  parseFaqLibrary,
  releaseNow,
  seedExitCode,
  seedFaqLibrary,
  syncLibraryPopular,
  type PopularSyncReport,
  type SeedDeps,
  type SeedReport,
} from '../faqs/faqLibrarySeed';
import { createPgFaqMapRepository } from '../faqs/faqMapRepository';
import {
  parseMapSeed,
  pruneFaqMap,
  seedFaqMap,
  type MapPruneReport,
  type MapSeedReport,
} from '../faqs/faqMapSeed';
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
/** SOP 树 v2（2026-11-02，按 Portal 代码与 PRD 建：阶段 > 步骤 > 岔子 + 对象 × 属性）与 685 张卡的位置。 */
const MAP = join(__dirname, 'library', 'faq-map-v2.json');
/** 记在 backoffice_settings：灌过一次就不再自动灌（--remove 之后也不会被启动灌回来）。 */
export const DEMO_MARKER_KEY = 'helpdesk_demo_seeded';
/**
 * 非 DEV 环境（SIT / UAT，或设了 HELPDESK_FAQ_LIBRARY_SEED=on）第一次只导卡库（卡片、流程树、发布，不灌演示行）
 * 后写的标记。之后和 DEV 一样只看下面三个版本标记同步差异。
 */
export const LIBRARY_MARKER_KEY = 'helpdesk_faq_library_seeded';
/**
 * 热门 FAQ 那一版（库文件里的 popular；产品 2026-11-02 在 Helpdesk-FAQ-Popular.xlsx 里挑的 25 张）。
 * 库文件的 popular 再改就换这个值：已经灌过的 DEV 下次启动只同步 popular，不重灌整库（BackOffice 里的编辑不动）。
 */
export const DEMO_POPULAR_TAG = 'popular-2026-11-02';
export const DEMO_POPULAR_MARKER_KEY = 'helpdesk_demo_popular';
/**
 * 卡片内容那一版（库文件里的问题、答案、追问；2026-11-02 起按代码核对过的修正）。库文件的卡片内容再改就换这个值：
 * 已经灌过的 DEV 下次启动按库文件更新卡片，员工在 BackOffice 改过的卡不动（keepStaffEdits），再出一版发布。
 */
export const DEMO_CONTENT_TAG = 'content-2026-11-05a';
export const DEMO_CONTENT_MARKER_KEY = 'helpdesk_demo_content';
/**
 * 流程树那一版（库文件 faq-map-v2.json）。树或卡的位置再改就换这个值：已经灌过的 DEV 下次启动先删掉种子里
 * 没有的节点（pruneFaqMap），再按种子建节点、挂卡，有改动就出一版发布（结构随发布冻结进快照）。
 */
export const DEMO_MAP_TAG = 'map-v2-2026-11-05a';
export const DEMO_MAP_MARKER_KEY = 'helpdesk_demo_map';
// 与夜间任务的锁（FLYWHEEL_LOCK = [719320, 1]）同一命名空间，第二个数不同
const DEMO_LOCK: readonly [number, number] = [719320, 2];

export const demoDb: SqlDb = {
  query: (sql, params) => query(sql, params),
  withTransaction: (fn) => withTransaction((client) => fn(client)),
};

function readLibrary() {
  return parseFaqLibrary(JSON.parse(readFileSync(LIBRARY, 'utf8')));
}

function readMap() {
  const raw = JSON.parse(readFileSync(MAP, 'utf8')) as {
    skeleton: unknown;
    placements: unknown[];
  };
  return parseMapSeed(raw.skeleton, raw.placements);
}

/** 正常的服务层（PostgreSQL）+ 发布后建向量索引；跑完等索引建好再返回。 */
async function withLibraryDeps<T>(work: (deps: SeedDeps) => Promise<T>) {
  const repository = createPgFaqRepository();
  const graph = createPgFaqGraphRepository();
  const releaseSource = createPgFaqReleaseSource(graph);
  const indexer = createEnvFaqVectorIndexer();
  const indexing: Promise<unknown>[] = [];
  try {
    const value = await work({
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
    });
    await Promise.all(indexing);
    return value;
  } finally {
    await Promise.allSettled(indexing);
  }
}

function seedLibrary(
  employeeId: string | null,
  release: boolean,
  keepStaffEdits = false,
) {
  return withLibraryDeps((deps) =>
    seedFaqLibrary(deps, readLibrary(), {
      actor: { employeeId },
      release,
      keepStaffEdits,
    }),
  );
}

/** 只把库文件里的 popular 同步到已发布的行，有改动就出一版发布（命令行 --popular 和 DEV 启动共用）。 */
export function syncDemoPopular(
  employeeId: string | null,
): Promise<PopularSyncReport> {
  return withLibraryDeps((deps) =>
    syncLibraryPopular(deps, readLibrary(), {
      actor: { employeeId },
      release: true,
    }),
  );
}

/** 按库文件更新卡片内容，员工改过的卡不动，有改动就出一版发布（命令行 --content 和 DEV 启动共用）。 */
export function syncDemoContent(
  employeeId: string | null,
): Promise<SeedReport> {
  return withLibraryDeps((deps) =>
    seedFaqLibrary(deps, readLibrary(), {
      actor: { employeeId },
      release: true,
      keepStaffEdits: true,
    }),
  );
}

export type MapSyncReport = {
  pruned: MapPruneReport;
  seeded: MapSeedReport;
  release: SeedReport['release'];
};

/** 先删种子里没有的节点，再按种子建节点、挂卡；有改动就出一版发布（命令行 --map 和 DEV 启动共用）。 */
export function syncDemoMap(employeeId: string | null): Promise<MapSyncReport> {
  return withLibraryDeps(async (deps) => {
    const actor = { employeeId };
    const seed = readMap();
    const map = createPgFaqMapRepository();
    const pruned = await pruneFaqMap({ map }, seed, actor);
    const seeded = await seedFaqMap(
      { map, faqs: createPgFaqRepository() },
      seed,
      actor,
    );
    const changed =
      pruned.deleted.length > 0 ||
      pruned.detached > 0 ||
      seeded.nodes.created.length > 0 ||
      seeded.nodes.changed.length > 0 ||
      seeded.placements.changed > 0;
    const release =
      changed && deps.releases ? await releaseNow(deps.releases, actor) : null;
    return { pruned, seeded, release };
  });
}

/** 种子里的卡都挂上了（库里都有），有发布就发布成功，才算这一版树已经到位。 */
export function mapSyncOk(report: MapSyncReport): boolean {
  return (
    report.seeded.placements.missingCards.length === 0 &&
    (report.release === null || report.release.published)
  );
}

/** 同步干净（没有失败，有发布就发布成功）才算这一版热门已经到位。 */
export function popularSyncOk(report: PopularSyncReport): boolean {
  return (
    report.failed.length === 0 &&
    (report.release === null || report.release.published)
  );
}

async function setMarker(key: string, value: string) {
  await demoDb.query(
    `INSERT INTO backoffice_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}

async function marker(key: string): Promise<string | null> {
  const rows = await demoDb.query(
    'SELECT value FROM backoffice_settings WHERE key = $1',
    [key],
  );
  const value = rows[0]?.value;
  return typeof value === 'string' ? value : rows.length > 0 ? '' : null;
}

export type HelpdeskDemoReport = {
  library?: unknown;
  map?: unknown;
  release?: unknown;
  demo: DemoReport;
  ok: boolean;
};

export type HelpdeskLibraryReport = {
  library: unknown;
  map: unknown;
  release: unknown;
  ok: boolean;
};

/**
 * 先导卡（不发布），再导流程树，最后再导一次并发布（发布把卡和树一起冻结进版本）。按 key 幂等。
 * keepStaffEdits：员工在 BackOffice 改过的卡不动（非 DEV 环境第一次导入用，库里原来有卡也不覆盖员工的改动）。
 */
async function seedLibraryAndMap(
  employeeId: string | null,
  keepStaffEdits: boolean,
): Promise<HelpdeskLibraryReport> {
  const library = await seedLibrary(employeeId, false, keepStaffEdits);
  const seed = readMap();
  const actor = { employeeId };
  const mapRepository = createPgFaqMapRepository();
  // 整库重灌时库里可能还有上一版的树（--remove 不删结构）
  await pruneFaqMap({ map: mapRepository }, seed, actor);
  const map = await seedFaqMap(
    { map: mapRepository, faqs: createPgFaqRepository() },
    seed,
    actor,
  );
  const release = await seedLibrary(employeeId, true, keepStaffEdits);
  return {
    library: summary(library),
    map: { placements: map.placements },
    release: summary(release),
    ok: seedExitCode(release) === 0 && map.placements.missingCards.length === 0,
  };
}

/** 整库刚导过：库文件里的 popular、卡片内容和流程树就是这一版。 */
async function markLibraryTags() {
  await setMarker(DEMO_POPULAR_MARKER_KEY, DEMO_POPULAR_TAG);
  await setMarker(DEMO_CONTENT_MARKER_KEY, DEMO_CONTENT_TAG);
  await setMarker(DEMO_MAP_MARKER_KEY, DEMO_MAP_TAG);
}

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
    const report = await seedLibraryAndMap(options.employeeId, false);
    out.library = report.library;
    out.map = report.map;
    out.release = report.release;
    out.ok = report.ok;
  }
  out.demo = await seedDemoRows(demoDb);
  await setMarker(DEMO_MARKER_KEY, DEMO_LIBRARY_TAG);
  if (options.library && out.ok) await markLibraryTags();
  return out;
}

/**
 * 只导卡库：卡片、流程树、发布，不灌演示行（SIT / UAT 启动时用）。员工在 BackOffice 改过的卡不动。
 * 导过就写 LIBRARY_MARKER_KEY；干净才写三个版本标记，不干净下次启动由版本标记那几步接着补。
 */
export async function seedHelpdeskLibrary(
  employeeId: string | null,
): Promise<HelpdeskLibraryReport> {
  const report = await seedLibraryAndMap(employeeId, true);
  await setMarker(LIBRARY_MARKER_KEY, DEMO_LIBRARY_TAG);
  if (report.ok) await markLibraryTags();
  return report;
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
    readHelpdeskSetting(HELPDESK_SETTINGS.demoData, env)
  );
}

/**
 * 只导卡库（卡片、流程树、发布，不灌演示行）：只在部署运行（NODE_ENV=production）时。
 * HELPDESK_FAQ_LIBRARY_SEED=off 处处关，=on 任何环境都开（PROD、PPE 要明确设 on）；不设时 SIT 和 UAT 开。
 * 部署的 DEV 走演示数据那条（shouldAutoSeedDemo），里面已经含卡库。
 */
export function shouldAutoSeedLibrary(env: NodeJS.ProcessEnv): boolean {
  if (env.NODE_ENV !== 'production') return false;
  const flag = (env.HELPDESK_FAQ_LIBRARY_SEED ?? '').trim().toLowerCase();
  if (flag === 'off') return false;
  if (flag === 'on') return true;
  const appEnv = (env.APP_ENV ?? '').trim().toUpperCase();
  return appEnv === 'SIT' || appEnv === 'UAT';
}

/** 启动时导什么：demo = 卡库 + 演示行（部署的 DEV），library = 只导卡库，null = 什么都不导。 */
export function helpdeskBootSeed(
  env: NodeJS.ProcessEnv,
): 'demo' | 'library' | null {
  if (shouldAutoSeedDemo(env)) return 'demo';
  if (shouldAutoSeedLibrary(env)) return 'library';
  return null;
}

/** 已经整库导过（DEV 的演示标记或只导卡库的标记，任一个在都算）。 */
async function librarySeeded(): Promise<boolean> {
  return (
    (await marker(DEMO_MARKER_KEY)) !== null ||
    (await marker(LIBRARY_MARKER_KEY)) !== null
  );
}

/** 三个版本标记依次同步：热门、卡片内容、流程树（树在卡片内容之后：新卡先建出来才能挂）。 */
async function syncLibraryTags(
  logger: Pick<Logger, 'log' | 'warn'>,
): Promise<SyncOutcome> {
  const popular = await syncTagOnce(logger, POPULAR_STEP);
  const content = await syncTagOnce(logger, CONTENT_STEP);
  const map = await syncTagOnce(logger, MAP_STEP);
  return combined([popular, content, map]);
}

/**
 * SIT / UAT 启动后在后台导一次卡库（不阻塞启动和健康检查，不灌演示行）。和 DEV 一样用 advisory lock
 * 只让一个实例导；导过就只看三个版本标记同步差异，员工在 BackOffice 改过的卡不动。失败只记日志，下次启动再试。
 */
export async function autoSeedLibraryOnce(
  logger: Pick<Logger, 'log' | 'warn'> = new Logger('HelpdeskFaqLibrary'),
): Promise<'skipped' | 'busy' | 'seeded' | 'synced' | 'failed'> {
  try {
    if (await librarySeeded()) return await syncLibraryTags(logger);
    const result = await createPgJobLock(undefined, DEMO_LOCK).withLock(
      async () => {
        if (await librarySeeded()) return null;
        return seedHelpdeskLibrary(null);
      },
    );
    if (!result.acquired) return 'busy';
    if (!result.value) return 'skipped';
    logger[result.value.ok ? 'log' : 'warn'](
      JSON.stringify({
        type: 'helpdesk',
        event: 'faq_library_seeded',
        ok: result.value.ok,
        library: result.value.library,
        map: result.value.map,
        release: result.value.release,
      }),
    );
    return result.value.ok ? 'seeded' : 'failed';
  } catch (error) {
    logger.warn(
      JSON.stringify({
        type: 'helpdesk',
        event: 'faq_library_seed_failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return 'failed';
  }
}

/**
 * DEV 启动后在后台灌一次（不阻塞启动和健康检查）。几个实例同时起时用 advisory lock 只让一个灌；
 * 灌过（backoffice_settings 有标记）就不再灌，只看三个版本标记：热门（DEMO_POPULAR_TAG，只同步 popular）、
 * 卡片内容（DEMO_CONTENT_TAG，按库文件更新员工没改过的卡）和流程树（DEMO_MAP_TAG，换版并重挂卡）。
 * 失败只记日志、不写标记，下次启动再试。
 */
export async function autoSeedDemoOnce(
  logger: Pick<Logger, 'log' | 'warn'> = new Logger('HelpdeskDemo'),
): Promise<'skipped' | 'busy' | 'seeded' | 'synced' | 'failed'> {
  try {
    if ((await marker(DEMO_MARKER_KEY)) !== null)
      return await syncLibraryTags(logger);
    const result = await createPgJobLock(undefined, DEMO_LOCK).withLock(
      async () => {
        if ((await marker(DEMO_MARKER_KEY)) !== null) return null;
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

type SyncOutcome = 'skipped' | 'busy' | 'synced' | 'failed';

/** 一个版本标记：标记不是 tag 就在锁里跑一次，干净才写标记。 */
type TagStep<R> = {
  key: string;
  tag: string;
  event: string;
  run: () => Promise<R>;
  ok: (report: R) => boolean;
  log: (report: R) => Record<string, unknown>;
};

const POPULAR_STEP: TagStep<PopularSyncReport> = {
  key: DEMO_POPULAR_MARKER_KEY,
  tag: DEMO_POPULAR_TAG,
  event: 'demo_popular_synced',
  run: () => syncDemoPopular(null),
  ok: popularSyncOk,
  log: (report) => ({
    on: report.on.length,
    off: report.off.length,
    reordered: report.reordered.length,
    missing: report.missing.length,
    failed: report.failed,
    release: report.release,
  }),
};

const CONTENT_STEP: TagStep<SeedReport> = {
  key: DEMO_CONTENT_MARKER_KEY,
  tag: DEMO_CONTENT_TAG,
  event: 'demo_content_synced',
  run: () => syncDemoContent(null),
  ok: (report) => seedExitCode(report) === 0,
  log: (report) => ({
    created: report.nodes.created.length,
    updated: report.nodes.updated,
    kept: report.nodes.kept,
    skipped: report.nodes.skipped,
    edges: report.edges,
    release: report.release,
  }),
};

async function syncTagOnce<R>(
  logger: Pick<Logger, 'log' | 'warn'>,
  step: TagStep<R>,
): Promise<SyncOutcome> {
  if ((await marker(step.key)) === step.tag) return 'skipped';
  const result = await createPgJobLock(undefined, DEMO_LOCK).withLock(
    async () => {
      if ((await marker(step.key)) === step.tag) return null;
      const report = await step.run();
      if (step.ok(report)) await setMarker(step.key, step.tag);
      return report;
    },
  );
  if (!result.acquired) return 'busy';
  if (!result.value) return 'skipped';
  const ok = step.ok(result.value);
  logger[ok ? 'log' : 'warn'](
    JSON.stringify({
      type: 'helpdesk',
      event: step.event,
      tag: step.tag,
      ok,
      ...step.log(result.value),
    }),
  );
  return ok ? 'synced' : 'failed';
}

const MAP_STEP: TagStep<MapSyncReport> = {
  key: DEMO_MAP_MARKER_KEY,
  tag: DEMO_MAP_TAG,
  event: 'demo_map_synced',
  run: () => syncDemoMap(null),
  ok: mapSyncOk,
  log: (report) => ({
    deleted: report.pruned.deleted.length,
    detached: report.pruned.detached,
    created: report.seeded.nodes.created.length,
    changed: report.seeded.nodes.changed.length,
    placed: report.seeded.placements.cards,
    placementsChanged: report.seeded.placements.changed,
    missingCards: report.seeded.placements.missingCards,
    release: report.release,
  }),
};

/** 几步的结果合成一个：有失败算失败，其次有锁被占算 busy，有同步算 synced，都跳过才是 skipped。 */
function combined(outcomes: SyncOutcome[]): SyncOutcome {
  for (const outcome of ['failed', 'busy', 'synced'] as const)
    if (outcomes.includes(outcome)) return outcome;
  return 'skipped';
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
