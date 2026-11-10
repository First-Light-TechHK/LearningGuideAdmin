import { readFileSync } from 'node:fs';

import { closePool } from '../../src/backoffice/lib/db';
import { createPgFaqGraphRepository } from '../../src/backoffice/modules/helpdesk/faqs/faqGraphRepository';
import { createFaqGraphService } from '../../src/backoffice/modules/helpdesk/faqs/faqGraphService';
import {
  parseFaqLibrary,
  parseSeedArgs,
  seedExitCode,
  seedFaqLibrary,
  seedVectorsProblem,
} from '../../src/backoffice/modules/helpdesk/faqs/faqLibrarySeed';
import {
  createFaqReleaseService,
  createPgFaqReleaseSource,
} from '../../src/backoffice/modules/helpdesk/faqs/faqReleaseService';
import { createPgFaqRepository } from '../../src/backoffice/modules/helpdesk/faqs/faqRepository';
import { createFaqService } from '../../src/backoffice/modules/helpdesk/faqs/faqService';
import {
  createEnvFaqVectorIndexer,
  openRouterFaqEmbedder,
} from '../../src/backoffice/modules/helpdesk/faqs/faqVectors';

/**
 * 从 FAQ 库文件导入问题树并建发布版本 v1（helpdesk-v5-faq-graph-design §8.2）：
 *
 *   DATABASE_URL=… npm run seed:helpdesk-faqs -- <library.json> [--employee-id <uuid>] [--no-release]
 *
 * 经正常的服务层，按 key 幂等（再跑一次只改有变化的）；工作表没变就不新建版本。评测门是免费的检索评测
 * （不问模型）。放在 eval/ 下：不进 nest build（tsconfig.build.json 排除 eval），也就不改变 dist 的结构。
 * 输出一份 JSON 报告（建了 / 改了 / 跳过的 key、边、问法、版本）。
 * 配了向量模型而新版本的向量没算成 → stderr 说明并以 1 退出（卡片和版本已经写好，补跑
 * npm run helpdesk:faq-vectors 即可；不报错的话没人知道检索只剩字词一路）。
 */
async function main(): Promise<void> {
  const args = parseSeedArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error(args.message);
    process.exitCode = args.exitCode;
    return;
  }
  const { path, employeeId } = args;
  const library = parseFaqLibrary(JSON.parse(readFileSync(path, 'utf8')));
  const repository = createPgFaqRepository();
  const graph = createPgFaqGraphRepository();
  const releaseSource = createPgFaqReleaseSource(graph);
  // 新版本的向量（配了 HELPDESK_EMBED_MODEL 才算）在关连接池之前算完
  const indexer = createEnvFaqVectorIndexer();
  const indexing: Promise<object | null>[] = [];
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
      { actor: { employeeId }, release: args.release },
    );
    const vectors = seedVectorsProblem(
      openRouterFaqEmbedder(process.env) !== null,
      await Promise.all(indexing),
    );
    console.log(JSON.stringify(report, null, 2));
    if (vectors) console.error(vectors);
    process.exitCode = vectors ? 1 : seedExitCode(report);
  } finally {
    await Promise.allSettled(indexing);
    await closePool();
  }
}

void main();
