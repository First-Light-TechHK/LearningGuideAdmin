import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { closePool } from '../../src/backoffice/lib/db';
import { createPgFaqGraphRepository } from '../../src/backoffice/modules/helpdesk/faqs/faqGraphRepository';
import { createFaqGraphService } from '../../src/backoffice/modules/helpdesk/faqs/faqGraphService';
import {
  parseFaqLibrary,
  seedFaqLibrary,
} from '../../src/backoffice/modules/helpdesk/faqs/faqLibrarySeed';
import {
  createFaqReleaseService,
  createPgFaqReleaseSource,
} from '../../src/backoffice/modules/helpdesk/faqs/faqReleaseService';
import { createPgFaqRepository } from '../../src/backoffice/modules/helpdesk/faqs/faqRepository';
import { createFaqService } from '../../src/backoffice/modules/helpdesk/faqs/faqService';
import { isUuid } from '../../src/common/uuidv7';

/**
 * 从 FAQ 库文件导入问题树并建发布版本 v1（helpdesk-v5-faq-graph-design §8.2）：
 *
 *   DATABASE_URL=… npm run seed:helpdesk-faqs -- <library.json> [--employee-id <uuid>] [--no-release]
 *
 * 经正常的服务层，按 key 幂等（再跑一次只改有变化的）；工作表没变就不新建版本。评测门是免费的检索评测
 * （不问模型）。放在 eval/ 下：不进 nest build（tsconfig.build.json 排除 eval），也就不改变 dist 的结构。
 * 输出一份 JSON 报告（建了 / 改了 / 跳过的 key、边、问法、版本）。
 */
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'employee-id': { type: 'string' },
      'no-release': { type: 'boolean', default: false },
    },
  });
  const path = positionals[0];
  if (!path) {
    console.error(
      'Usage: seed-faq-library <library.json> [--employee-id <uuid>] [--no-release]',
    );
    process.exitCode = 2;
    return;
  }
  const employeeId = values['employee-id'] ?? null;
  if (employeeId !== null && !isUuid(employeeId)) {
    console.error('--employee-id must be a UUID');
    process.exitCode = 2;
    return;
  }
  const library = parseFaqLibrary(JSON.parse(readFileSync(path, 'utf8')));
  const repository = createPgFaqRepository();
  const graph = createPgFaqGraphRepository();
  const releaseSource = createPgFaqReleaseSource(graph);
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
        releases: createFaqReleaseService({ graph }),
      },
      library,
      { actor: { employeeId }, release: !values['no-release'] },
    );
    console.log(JSON.stringify(report, null, 2));
    const failed =
      report.nodes.skipped.length +
      report.edges.failed.length +
      report.phrasings.failed.length;
    if (failed > 0 || (report.release !== null && !report.release.published))
      process.exitCode = 1;
  } finally {
    await closePool();
  }
}

void main();
