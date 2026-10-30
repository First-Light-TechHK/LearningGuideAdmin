import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
  pgReleaseQaSource,
  runCases,
  runnerFor,
  runRetrieval,
  summarize,
  summarizeRetrieval,
  writeReport,
} from './harness';
import {
  conversationRetrieval,
  loadConversations,
  runConversations,
  summarizeConversations,
  writeConversationReport,
} from './conversations';

/**
 * npm run eval:helpdesk -- [--out report.json|report.md] [--pg <postgres url>] [--limit N]
 *                          [--cases cases.jsonl] [--faqs faqs.json] [--retrieval-only]
 *
 * --retrieval-only：只跑检索（--pg 时是生产的候选 SQL），报 recall@1 / @3 / @8 与检索耗时，
 * 从不问模型（有 key 也不问）、不花钱，退出码 0。
 * --release（要 --pg）：不建临时 schema，直接用那个库里已发布的 FAQ 版本（seed:helpdesk-faqs 导入并发布的，
 * 带追问的边，和生产同一个来源）；按 FAQ key 标注的评测集（v5-sets.ts）也靠它把 key 换成 id。
 * --conversations 加 --retrieval-only：每个期望出卡片的轮次只跑检索（屏幕上的卡片按理想走法取上一张期望的
 * 卡片），报 recall@1 / @3 / @8，不问模型。
 * --turns <file.jsonl>（--conversations 时）：另写每一轮的完整结果（报告的失败清单只留 200 条）。
 * --conversations <file.jsonl | dir>：v5 对话评测（conversations.ts，Part F 的多轮与寒暄集），按 Portal 的
 * 方式带 context 逐轮问；同样的模型选择、预算与 --pg / --faqs / --limit（按对话数）；真模型闸门不过退出码 1。
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
  pgReleaseQaSource?: typeof pgReleaseQaSource;
  callCeilingUsd?: typeof callCeilingUsd;
  writeReport?: typeof writeReport;
  writeConversationReport?: typeof writeConversationReport;
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
      concurrency: { type: 'string', default: '1' },
      'retrieval-only': { type: 'boolean', default: false },
      conversations: { type: 'string' },
      release: { type: 'boolean', default: false },
      turns: { type: 'string' },
    },
  });
  const budgetUsd = budgetFrom(deps.env);
  if (values.release && !values.pg)
    throw new Error('--release needs --pg <postgres url>');
  if (values.release && values.conversations === undefined)
    throw new Error('--release is for --conversations runs');
  const faqs = values.release ? [] : loadFaqs(resolve(deps.cwd, values.faqs));
  if (values.conversations !== undefined)
    return conversationsRun(
      { ...values, conversations: values.conversations },
      faqs,
      budgetUsd,
      deps,
    );
  const all = loadCases(resolve(deps.cwd, values.cases));
  const limit = values.limit === undefined ? all.length : Number(values.limit);
  if (!Number.isInteger(limit) || limit <= 0)
    throw new Error('--limit must be a positive integer');
  const cases = all.slice(0, limit);
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw new Error('--concurrency must be an integer from 1 to 16');
  if (values['retrieval-only'])
    return retrievalOnly(values, faqs, cases, all.length, deps);

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
      concurrency,
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

async function retrievalOnly(
  values: { out: string; pg?: string },
  faqs: ReturnType<typeof loadFaqs>,
  cases: ReturnType<typeof loadCases>,
  totalCases: number,
  deps: CliDeps,
): Promise<number> {
  const pg = values.pg
    ? await (deps.pgQaSource ?? pgQaSource)(
        values.pg,
        faqs,
        helpdeskMigrationSql(),
      )
    : null;
  deps.log(
    `Helpdesk retrieval eval: ${cases.length} of ${totalCases} cases, ${faqs.length} FAQs, ` +
      `${pg ? 'PostgreSQL' : 'in-memory'} retrieval, no model`,
  );
  try {
    const results = await runRetrieval({
      cases,
      qa: pg?.qa ?? memoryQaSource(faqs),
      onCase: (_result, index) => {
        if ((index + 1) % 500 === 0 || index + 1 === cases.length)
          deps.log(`${index + 1}/${cases.length}`);
      },
    });
    const report = summarizeRetrieval({
      results,
      totalCases,
      retrieval: pg ? 'postgresql' : 'memory',
      faqs: faqs.length,
    });
    const out = resolve(deps.cwd, values.out);
    (deps.writeReport ?? writeReport)(out, report);
    const pct = (v: number | null) =>
      v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`;
    const o = report.overall;
    deps.log(
      `recall@1/@3/@8 ${pct(o.recallAt1)} / ${pct(o.recallAt3)} / ${pct(o.recallAt8)} ` +
        `(${o.answerable} answerable), p95 ${report.latencyMs.p95} ms`,
    );
    deps.log(`report: ${out}`);
    return 0;
  } finally {
    await pg?.close();
  }
}

async function conversationsRun(
  values: {
    out: string;
    pg?: string;
    limit?: string;
    concurrency: string;
    conversations: string;
    release: boolean;
    turns?: string;
    'retrieval-only': boolean;
  },
  faqs: ReturnType<typeof loadFaqs>,
  budgetUsd: number,
  deps: CliDeps,
): Promise<number> {
  const released =
    values.release && values.pg
      ? await (deps.pgReleaseQaSource ?? pgReleaseQaSource)(values.pg)
      : null;
  try {
    return await conversationsWith(values, faqs, budgetUsd, deps, released);
  } finally {
    await released?.close();
  }
}

async function conversationsWith(
  values: {
    out: string;
    pg?: string;
    limit?: string;
    concurrency: string;
    conversations: string;
    release: boolean;
    turns?: string;
    'retrieval-only': boolean;
  },
  faqs: ReturnType<typeof loadFaqs>,
  budgetUsd: number,
  deps: CliDeps,
  released: Awaited<ReturnType<typeof pgReleaseQaSource>> | null,
): Promise<number> {
  const all = loadConversations(
    resolve(deps.cwd, values.conversations),
    released ?? undefined,
  );
  const limit = values.limit === undefined ? all.length : Number(values.limit);
  if (!Number.isInteger(limit) || limit <= 0)
    throw new Error('--limit must be a positive integer');
  const conversations = all.slice(0, limit);
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw new Error('--concurrency must be an integer from 1 to 16');
  if (values['retrieval-only']) {
    if (!released)
      throw new Error(
        '--conversations --retrieval-only needs --pg <url> --release',
      );
    const results = await conversationRetrieval({
      conversations,
      qa: released.qa,
    });
    const report = summarizeRetrieval({
      results,
      totalCases: results.length,
      retrieval: 'postgresql',
      faqs: released.idOfKey.size,
    });
    const out = resolve(deps.cwd, values.out);
    (deps.writeReport ?? writeReport)(out, report);
    const pct = (v: number | null) =>
      v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`;
    const o = report.overall;
    deps.log(
      `release v${released.release}: ${conversations.length} conversations, recall@1/@3/@8 ` +
        `${pct(o.recallAt1)} / ${pct(o.recallAt3)} / ${pct(o.recallAt8)} (${o.answerable} card turns), ` +
        `p95 ${report.latencyMs.p95} ms`,
    );
    deps.log(`report: ${out}`);
    return 0;
  }
  const model = chooseModel(deps.env);
  const { runner, env } = await (deps.runnerFor ?? runnerFor)(model);
  const callCeiling =
    model.kind === 'real'
      ? await (deps.callCeilingUsd ?? callCeilingUsd)(model.model)
      : 0;
  const pg = released
    ? { qa: released.qa, close: () => Promise.resolve() }
    : values.pg
      ? await (deps.pgQaSource ?? pgQaSource)(
          values.pg,
          faqs,
          helpdeskMigrationSql(),
        )
      : null;
  deps.log(
    `Helpdesk v5 conversation eval: ${conversations.length} of ${all.length} conversations, ` +
      `${model.kind} model ${model.model}, ${released ? `released library v${released.release}` : pg ? 'PostgreSQL' : 'in-memory'} retrieval, budget $${budgetUsd}`,
  );
  try {
    const outcome = await runConversations({
      conversations,
      qa: pg?.qa ?? memoryQaSource(faqs),
      runner,
      env: env(deps.env),
      budgetUsd,
      paid: model.kind === 'real',
      callCeilingUsd: callCeiling,
      concurrency,
      onConversation: (turns, index) => {
        const ok = turns.every((t) => t.right !== false) ? 'ok  ' : 'FAIL';
        deps.log(
          `${String(index + 1).padStart(3)}/${conversations.length} ${ok} ${turns[0]?.conversationId ?? ''}`,
        );
      },
    });
    const report = summarizeConversations({
      outcome,
      totalConversations: all.length,
      model,
      retrieval: pg ? 'postgresql' : 'memory',
      budgetUsd,
    });
    const out = resolve(deps.cwd, values.out);
    (deps.writeConversationReport ?? writeConversationReport)(out, report);
    if (values.turns) {
      // 每一轮的完整结果（报告的 failures 只留前 200 条），给复核与重新打分用
      const turnsOut = resolve(deps.cwd, values.turns);
      mkdirSync(dirname(turnsOut), { recursive: true });
      writeFileSync(
        turnsOut,
        outcome.results.map((r) => JSON.stringify(r)).join('\n') + '\n',
      );
      deps.log(`turns: ${turnsOut}`);
    }
    const m = report.metrics;
    const pct = (v: number | null) =>
      v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`;
    deps.log(
      `turn accuracy ${pct(m.accuracy)}, wrong FAQ ${pct(m.wrongFaqRate)}, small-talk intent ` +
        `${pct(m.smalltalkIntentAccuracy)}, clarify grounded ${pct(m.clarifyGrounded)}, ` +
        `guard escapes ${m.guardEscapes}, cost $${m.costUsd.toFixed(4)}`,
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
