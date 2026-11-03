import { closePool } from '../../src/backoffice/lib/db';
import { createPgFaqGraphRepository } from '../../src/backoffice/modules/helpdesk/faqs/faqGraphRepository';
import {
  createPgFaqVectorStore,
  indexFaqRelease,
  openRouterFaqEmbedder,
} from '../../src/backoffice/modules/helpdesk/faqs/faqVectors';

/**
 * 给一个 FAQ 发布版本算向量（RAG 基建，faqVectors.ts）。发布时会自动算；这个命令用来补算
 * （自动那次失败了、换了向量模型、或第一次打开向量检索）：
 *
 *   DATABASE_URL=… HELPDESK_EMBED_MODEL=baai/bge-m3 OPENROUTER_API_KEY=… \
 *     npm run helpdesk:faq-vectors -- [--release <版本号|live>]
 *
 * 缺省是现在上线的版本。幂等：库里已有的文本不再算，只补缺的。输出一份 JSON 报告。
 * 放在 eval/ 下的理由同 seed-faq-library.ts（不进 nest build）。
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const at = args.indexOf('--release');
  const wanted = at === -1 ? 'live' : (args[at + 1] ?? '');
  if (wanted !== 'live' && !/^[1-9]\d*$/.test(wanted)) {
    console.error('usage: helpdesk:faq-vectors [--release <version|live>]');
    process.exitCode = 2;
    return;
  }
  const embedder = openRouterFaqEmbedder(process.env);
  if (!embedder) {
    console.error(
      'HELPDESK_EMBED_MODEL and OPENROUTER_API_KEY are both needed',
    );
    process.exitCode = 2;
    return;
  }
  try {
    const release =
      wanted === 'live'
        ? ((await createPgFaqGraphRepository().published())?.version ?? null)
        : Number(wanted);
    if (release === null) {
      console.error('no FAQ release is published yet');
      process.exitCode = 1;
      return;
    }
    const report = await indexFaqRelease({
      store: createPgFaqVectorStore(),
      embedder,
      release,
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await closePool();
  }
}

void main();
