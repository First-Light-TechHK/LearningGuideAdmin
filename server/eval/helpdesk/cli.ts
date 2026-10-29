import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  budgetFrom,
  callCeilingUsd,
  chooseModel,
  helpdeskMigrationSql,
  loadCases,
  loadFaqs,
  memoryQaSource,
  pgQaSource,
  runCases,
  runnerFor,
  summarize,
  writeReport,
} from './harness';

/**
 * npm run eval:helpdesk -- [--out report.json|report.md] [--pg <postgres url>] [--limit N]
 *                          [--cases cases.jsonl] [--faqs faqs.json]
 *
 * 有 OPENROUTER_API_KEY：真模型（和生产选同一个），按次计费，花费上限 HELPDESK_EVAL_BUDGET_USD
 *（缺省 5 美元），闸门不过退出码 1；只有整套用例 + --pg 才可能过闸。没有 key：假模型，报告标明
 * “不是模型成绩”，退出码 0。参数、文件或运行出错退出码 2。--out 相对当前目录。
 */
export type CliDeps = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  log: (line: string) => void;
  runnerFor?: typeof runnerFor;
  pgQaSource?: typeof pgQaSource;
  callCeilingUsd?: typeof callCeilingUsd;
  writeReport?: typeof writeReport;
};

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  try {
    return await run(argv, deps);
  } catch (error) {
    deps.log(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

async function run(argv: string[], deps: CliDeps): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string', default: 'helpdesk-eval-report.json' },
      cases: { type: 'string', default: join(__dirname, 'cases.jsonl') },
      faqs: { type: 'string', default: join(__dirname, 'faqs.json') },
      pg: { type: 'string' },
      limit: { type: 'string' },
    },
  });
  const budgetUsd = budgetFrom(deps.env);
  const faqs = loadFaqs(resolve(deps.cwd, values.faqs));
  const all = loadCases(resolve(deps.cwd, values.cases));
  const limit = values.limit === undefined ? all.length : Number(values.limit);
  if (!Number.isInteger(limit) || limit <= 0)
    throw new Error('--limit must be a positive integer');
  const cases = all.slice(0, limit);

  const model = chooseModel(deps.env);
  const { runner, env } = await (deps.runnerFor ?? runnerFor)(model);
  const callCeiling =
    model.kind === 'real'
      ? await (deps.callCeilingUsd ?? callCeilingUsd)(model.model)
      : 0;
  const pg = values.pg
    ? await (deps.pgQaSource ?? pgQaSource)(
        values.pg,
        faqs,
        helpdeskMigrationSql(),
      )
    : null;
  deps.log(
    `Helpdesk eval: ${cases.length} of ${all.length} cases, ${model.kind} model ${model.model}, ` +
      `${pg ? 'PostgreSQL' : 'in-memory'} retrieval, budget $${budgetUsd}`,
  );
  try {
    const outcome = await runCases({
      cases,
      qa: pg?.qa ?? memoryQaSource(faqs),
      runner,
      env: env(deps.env),
      budgetUsd,
      paid: model.kind === 'real',
      callCeilingUsd: callCeiling,
      onCase: (result, index) => {
        const ok = result.gotFaqId === result.expectedFaqId ? 'ok  ' : 'FAIL';
        deps.log(
          `${String(index + 1).padStart(3)}/${cases.length} ${ok} ${result.id} ` +
            `${result.reason ?? ''} ${Math.round(result.latencyMs)} ms`,
        );
      },
    });
    const report = summarize({
      outcome,
      totalCases: all.length,
      model,
      retrieval: pg ? 'postgresql' : 'memory',
      budgetUsd,
    });
    const out = resolve(deps.cwd, values.out);
    (deps.writeReport ?? writeReport)(out, report);
    const m = report.metrics;
    deps.log(
      `accuracy ${(m.accuracy * 100).toFixed(1)}%, wrong ${(m.wrongAnswerRate * 100).toFixed(2)}%, ` +
        `p50/p95 ${m.latencyMs.p50}/${m.latencyMs.p95} ms, cost $${m.costUsd.toFixed(4)}`,
    );
    deps.log(
      `gate ${report.gate.pass ? 'PASS' : 'FAIL'}${report.gate.reasons.length ? `: ${report.gate.reasons.join('; ')}` : ''}`,
    );
    deps.log(`report: ${out}`);
    return model.kind === 'real' && !report.gate.pass ? 1 : 0;
  } finally {
    await pg?.close();
  }
}
