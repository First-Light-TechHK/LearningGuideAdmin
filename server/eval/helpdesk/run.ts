import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  budgetFrom,
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
 * 有 OPENROUTER_API_KEY：真模型（HELPDESK_SUGGEST_MODEL），花费上限 HELPDESK_EVAL_BUDGET_USD（缺省 5 美元），
 * 闸门不过退出码 1。没有 key：假模型，报告标明“不是模型成绩”，退出码 0。
 */
async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: 'helpdesk-eval-report.json' },
      cases: { type: 'string', default: join(__dirname, 'cases.jsonl') },
      faqs: { type: 'string', default: join(__dirname, 'faqs.json') },
      pg: { type: 'string' },
      limit: { type: 'string' },
    },
  });
  const budgetUsd = budgetFrom(process.env);
  const faqs = loadFaqs(values.faqs);
  const all = loadCases(values.cases);
  const limit = values.limit ? Number(values.limit) : all.length;
  if (!Number.isInteger(limit) || limit <= 0)
    throw new Error('--limit must be a positive integer');
  const cases = all.slice(0, limit);

  const model = chooseModel(process.env);
  const { runner, env } = await runnerFor(model);
  const pg = values.pg
    ? await pgQaSource(values.pg, faqs, helpdeskMigrationSql())
    : null;
  console.log(
    `Helpdesk eval: ${cases.length} cases, ${model.kind} model ${model.model}, ` +
      `${pg ? 'PostgreSQL' : 'in-memory'} retrieval, budget $${budgetUsd}`,
  );
  try {
    const outcome = await runCases({
      cases,
      qa: pg?.qa ?? memoryQaSource(faqs),
      runner,
      env: env(process.env),
      budgetUsd,
      paid: model.kind === 'real',
      onCase: (result, index) => {
        const ok = result.gotFaqId === result.expectedFaqId ? 'ok  ' : 'FAIL';
        console.log(
          `${String(index + 1).padStart(3)}/${cases.length} ${ok} ${result.id} ` +
            `${result.reason ?? ''} ${Math.round(result.latencyMs)} ms`,
        );
      },
    });
    const report = summarize({
      outcome,
      totalCases: cases.length,
      model,
      retrieval: pg ? 'postgresql' : 'memory',
      budgetUsd,
    });
    const out = resolve(values.out);
    writeReport(out, report);
    const m = report.metrics;
    console.log(
      `accuracy ${(m.accuracy * 100).toFixed(1)}%, wrong ${(m.wrongAnswerRate * 100).toFixed(2)}%, ` +
        `p50/p95 ${m.latencyMs.p50}/${m.latencyMs.p95} ms, cost $${m.costUsd.toFixed(4)}`,
    );
    console.log(
      `gate ${report.gate.pass ? 'PASS' : 'FAIL'}${report.gate.reasons.length ? `: ${report.gate.reasons.join('; ')}` : ''}`,
    );
    console.log(`report: ${out}`);
    return model.kind === 'real' && !report.gate.pass ? 1 : 0;
  } finally {
    await pg?.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  },
);
