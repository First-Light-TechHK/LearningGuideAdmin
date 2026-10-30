import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

import { createPgFaqGraphRepository } from '../modules/helpdesk/faqs/faqGraphRepository';
import { createFaqGraphService } from '../modules/helpdesk/faqs/faqGraphService';
import {
  parseFaqLibrary,
  seedFaqLibrary,
} from '../modules/helpdesk/faqs/faqLibrarySeed';
import {
  RETRIEVAL_GATE,
  createRetrievalGate,
  type FaqRegressionCase,
  type FaqReleaseEvalReport,
} from '../modules/helpdesk/faqs/faqReleaseGate';
import {
  createFaqReleaseService,
  createPgFaqReleaseSource,
} from '../modules/helpdesk/faqs/faqReleaseService';
import {
  createPgFaqRepository,
  type SqlDb,
} from '../modules/helpdesk/faqs/faqRepository';
import { createFaqService } from '../modules/helpdesk/faqs/faqService';

/**
 * CI 的检索评测门（v5 Part G5，免费、不问模型）：把仓库里的 FAQ 库（eval/helpdesk/faq-library.json，
 * 去掉了审核证据的 v2 库）经正常的服务层导入一个空库，建发布版本 v1——发布时跑的就是生产的检索评测
 * （入口 answer 节点的两种语言的问题 + 每种问法 + eval/helpdesk/regression-cases.jsonl 里员工接受过的
 * 学员原话，按节点 key），recall@8 必须 ≥ 95%，回归用例的 key 必须都在库里。
 * 回归用例的来源：员工在「FAQ 候选」接受一组之后，GET /api/helpdesk/faq-eval-cases 导出的 jsonl。
 * 需要 HELPDESK_TEST_DATABASE_URL；CI 里必须有。
 */
const url = process.env.HELPDESK_TEST_DATABASE_URL;
if (!url && process.env.CI === 'true')
  throw new Error('HELPDESK_TEST_DATABASE_URL is required when CI=true');
const describeDb = url ? describe : describe.skip;

const ROOT = join(__dirname, '../../..');
const MIGRATIONS = join(ROOT, 'prisma/migrations');
const LIBRARY = join(ROOT, 'eval/helpdesk/faq-library.json');
const CASES = join(ROOT, 'eval/helpdesk/regression-cases.jsonl');

type CaseLine = { faqKey: string; locale: string; text: string };

function regressionLines(): CaseLine[] {
  return readFileSync(CASES, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as CaseLine);
}

describe('regression cases file', () => {
  it('is JSON Lines of {faqKey, locale, text} whose keys are all in the library', () => {
    const library = parseFaqLibrary(JSON.parse(readFileSync(LIBRARY, 'utf8')));
    const keys = new Set(library.nodes.map((node) => node.key));
    const lines = regressionLines();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual(['faqKey', 'locale', 'text']);
      expect(['en-GB', 'zh-CN', 'zh-TW']).toContain(line.locale);
      expect(line.text.trim()).not.toBe('');
      expect(keys.has(line.faqKey)).toBe(true);
    }
  });
});

describeDb('CI retrieval eval gate over the FAQ library (PostgreSQL)', () => {
  const schema = `hdevalgate_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let db: SqlDb;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
    });
    await pool.query(
      readdirSync(MIGRATIONS)
        .filter((dir) => dir.includes('helpdesk'))
        .sort()
        .map((dir) =>
          readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8'),
        )
        .join('\n'),
    );
    db = {
      query: async (sql, params = []) =>
        (await pool.query<Record<string, unknown>>(sql, params as unknown[]))
          .rows,
      withTransaction: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const value = await fn(client);
          await client.query('COMMIT');
          return value;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
    };
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('publishes the library as release v1 with recall@8 >= 95% over its questions, phrasings and the regression cases', async () => {
    const repository = createPgFaqRepository(db);
    const graph = createPgFaqGraphRepository(db);
    const source = createPgFaqReleaseSource(graph);
    const lines = regressionLines();
    const regressionCases = async (): Promise<FaqRegressionCase[]> =>
      Promise.all(
        lines.map(async (line) => {
          const node = await repository.getByKey(line.faqKey);
          return {
            faqId: node?.id ?? '00000000-0000-7000-8000-000000000000',
            locale: line.locale as FaqRegressionCase['locale'],
            text: line.text,
          };
        }),
      );
    const library = parseFaqLibrary(JSON.parse(readFileSync(LIBRARY, 'utf8')));
    const report = await seedFaqLibrary(
      {
        faqs: createFaqService({
          repository,
          releaseVersion: () => source.publishedVersion(),
          liveParents: (id) => graph.liveParents(id),
        }),
        repository,
        graph: createFaqGraphService({ graph }),
        releases: createFaqReleaseService({
          graph,
          gate: createRetrievalGate(repository, undefined, {
            regressionCases,
          }),
        }),
      },
      library,
      { actor: { employeeId: null }, release: true },
    );
    expect(report.nodes.skipped).toEqual([]);
    expect(report.edges.failed).toEqual([]);
    expect(report.phrasings.failed).toEqual([]);
    const [release] = await graph.releases();
    const evalReport = release.evalReport as FaqReleaseEvalReport;
    // 没过时把没找到的列出来（便于改问法或检索）
    if (!evalReport.passed)
      throw new Error(
        `${evalReport.summary}\n${evalReport.misses
          .map((m) => `${m.key} [${m.locale} ${m.source}] ${m.text}`)
          .join('\n')}`,
      );
    expect(evalReport.metrics.recallAt8).toBeGreaterThanOrEqual(
      RETRIEVAL_GATE.recallAt8Min,
    );
    expect(evalReport.metrics.regressionCases).toBe(lines.length);
    expect(evalReport.metrics.regressionSkipped).toBe(0);
    expect(report.release).toMatchObject({ version: 1, published: true });
  }, 300_000);
});
