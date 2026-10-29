import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { Pool } from 'pg';

import {
  HelpdeskSuggestService,
  suggestModel,
} from '../../src/ai/helpdesk/helpdesk-suggest.service';
import type { HelpdeskSuggestionLog } from '../../src/ai/helpdesk/helpdesk-suggestion.store';
import { createMemoryAgentEventLog } from '../../src/ai/helpdesk/trace/agent-event.store';
import type { AgentStepRunner } from '../../src/ai/helpdesk/workflow/engine';
import {
  loadPi,
  PiStepRunner,
  type ModelSource,
} from '../../src/ai/helpdesk/workflow/pi-step-runner';
import { MemoryRateLimitStore } from '../../src/ai/rate-limit.service';
import type { HelpdeskFaq } from '../../src/backoffice/modules/helpdesk/faqs/faqContracts';
import {
  createPgFaqRepository,
  createPgHelpdeskQaSource,
  type SqlDb,
} from '../../src/backoffice/modules/helpdesk/faqs/faqRepository';
import { uuidv7 } from '../../src/common/uuidv7';
import {
  FAQ_CATEGORIES,
  type FaqCategory,
  type HelpdeskQaCandidate,
  type HelpdeskQaSource,
} from '../../src/contracts/helpdesk-qa';

/**
 * Helpdesk 推荐评测（helpdesk-agent-v2-pi-dsh §5）：每条用例走真正的 HelpdeskSuggestService
 *（同一套工作流、pi Agent 步、3 秒期限），只换掉外部依赖：
 * - 检索：内存近似（缺省）或 --pg 给的 PostgreSQL（真实的候选 SQL，独立 schema，跑完删掉）；
 * - 模型：有 OPENROUTER_API_KEY 时是真模型（HELPDESK_SUGGEST_MODEL），按 HELPDESK_EVAL_BUDGET_USD
 *  （缺省 5 美元）封顶；没有 key 时是假模型（pi 的 faux provider，永远选第一个候选），报告里标明，
 *   它的数字只说明评测本身能跑，不是模型的成绩。
 * 报告：准确率、答错率、none 的精确率 / 召回率、p50 / p95、费用、按 persona / locale 拆分、失败清单，
 * 以及闸门（答错率 ≤ 2%、p95 ≤ 3 秒）。
 */

export const EVAL_LOCALES = ['en-GB', 'zh-CN', 'zh-TW'] as const;
export type EvalLocale = (typeof EVAL_LOCALES)[number];
export const EVAL_PERSONAS = [
  'paraphrase',
  'terse',
  'typo',
  'mixed_language',
  'unanswerable',
  'injection',
  'over_reach',
] as const;
export type EvalPersona = (typeof EVAL_PERSONAS)[number];

export type EvalCase = {
  id: string;
  locale: EvalLocale;
  persona: EvalPersona;
  message: string;
  expectedFaqId: string | null;
};

export type SeedFaq = Pick<
  HelpdeskFaq,
  | 'id'
  | 'category'
  | 'popular'
  | 'questionEn'
  | 'answerEn'
  | 'questionZh'
  | 'answerZh'
  | 'keywords'
>;

export const GATE = { wrongAnswerRateMax: 0.02, p95MaxMs: 3_000 } as const;
export const DEFAULT_BUDGET_USD = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function loadFaqs(path: string): SeedFaq[] {
  const doc = JSON.parse(readFileSync(path, 'utf8')) as { faqs?: unknown };
  if (!Array.isArray(doc.faqs)) throw new Error(`${path}: no faqs array`);
  return doc.faqs.map((raw, index) => {
    const faq = raw as SeedFaq;
    if (!UUID.test(faq.id) || !FAQ_CATEGORIES.includes(faq.category))
      throw new Error(`${path}: FAQ ${index} has a bad id or category`);
    return faq;
  });
}

export function loadCases(path: string): EvalCase[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line, index) => ({ line: line.trim(), at: index + 1 }))
    .filter(({ line }) => line !== '')
    .map(({ line, at }) => {
      const value = JSON.parse(line) as EvalCase;
      const ok =
        typeof value.id === 'string' &&
        value.id !== '' &&
        EVAL_LOCALES.includes(value.locale) &&
        EVAL_PERSONAS.includes(value.persona) &&
        typeof value.message === 'string' &&
        value.message.trim() !== '' &&
        (value.expectedFaqId === null || UUID.test(value.expectedFaqId));
      if (!ok) throw new Error(`${path}:${at}: malformed case`);
      return value;
    });
}

/** Portal 只有 en-GB / zh-CN 两个界面语言：繁体中文的学员用的是 zh-CN 站点。 */
export function serviceLocale(locale: EvalLocale): 'en-GB' | 'zh-CN' {
  return locale === 'en-GB' ? 'en-GB' : 'zh-CN';
}

/* ---------------------------------- 检索 ---------------------------------- */

const STOP = new Set(
  'the a an and or to of in on for my me i is it do does how can what where why when with from at be are was this that you your we our am not no'.split(
    ' ',
  ),
);
const HAN = /[㐀-鿿豈-﫿]/;

/** 英文词（≥ 2 字母、去停用词）+ 中文双字。 */
function terms(text: string): Set<string> {
  const lower = text.toLowerCase();
  const out = new Set<string>();
  for (const word of lower.match(/[a-z0-9]+/g) ?? [])
    if (word.length >= 2 && !STOP.has(word)) out.add(word);
  const han = [...lower].filter((ch) => HAN.test(ch));
  for (let i = 0; i + 1 < han.length; i += 1) out.add(han[i] + han[i + 1]);
  return out;
}

/**
 * 内存检索：近似生产的候选 SQL（全文 + 关键词 + 中文双字 + 同类加权），用于没有数据库时。
 * 报告里写明是近似；要和生产一致用 --pg。
 */
export function memoryQaSource(faqs: SeedFaq[]): HelpdeskQaSource {
  const localised = (faq: SeedFaq, locale: string) =>
    locale === 'zh-CN'
      ? { question: faq.questionZh, answer: faq.answerZh }
      : { question: faq.questionEn, answer: faq.answerEn };
  return {
    findCandidates(search) {
      const wanted = terms(search.text);
      const scored: HelpdeskQaCandidate[] = [];
      for (const faq of faqs) {
        const text = localised(faq, search.locale);
        const question = terms(text.question);
        const body = terms(`${text.answer}\n${faq.keywords.join(' ')}`);
        let score = 0;
        for (const term of wanted) {
          if (question.has(term)) score += 2;
          else if (body.has(term)) score += 1;
        }
        if (score === 0) continue;
        if (search.category && faq.category === search.category) score += 1;
        scored.push({ id: faq.id, category: faq.category, ...text, score });
      }
      scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      return Promise.resolve(scored.slice(0, search.limit));
    },
    findPublished(id, locale) {
      const faq = faqs.find((item) => item.id === id);
      return Promise.resolve(
        faq
          ? {
              id: faq.id,
              category: faq.category,
              ...localised(faq, locale),
              score: 0,
            }
          : null,
      );
    },
  };
}

/** prisma/migrations 里所有 helpdesk 迁移的 SQL（按名字即时间顺序）。 */
export function helpdeskMigrationSql(
  dir = join(__dirname, '..', '..', 'prisma', 'migrations'),
): string {
  return readdirSync(dir)
    .filter((name) => name.includes('helpdesk'))
    .sort()
    .map((name) => readFileSync(join(dir, name, 'migration.sql'), 'utf8'))
    .join('\n');
}

/** 真实的 PostgreSQL 候选检索：独立 schema 里跑 helpdesk 迁移、写入种子 FAQ；close() 删掉 schema。 */
export async function pgQaSource(
  url: string,
  faqs: SeedFaq[],
  migrationSql: string,
): Promise<{ qa: HelpdeskQaSource; close: () => Promise<void> }> {
  const schema = `hdeval_${process.pid}_${Date.now()}`;
  const admin = new Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: url,
    options: `-c search_path=${schema}`,
  });
  const close = async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  };
  try {
    await pool.query(migrationSql);
    const db: SqlDb = {
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
    const repository = createPgFaqRepository(db);
    for (const faq of faqs) {
      await repository.insert(
        {
          ...faq,
          status: 'published',
          version: 1,
          createdBy: null,
          updatedBy: null,
          createdAt: '',
          updatedAt: '',
        },
        null,
        null,
      );
    }
    return { qa: createPgHelpdeskQaSource(repository), close };
  } catch (error) {
    await close();
    throw error;
  }
}

/* ---------------------------------- 模型 ---------------------------------- */

export type EvalModel =
  { kind: 'real'; model: string } | { kind: 'fake'; model: string };

export const FAKE_MODEL_ID = 'fake/top-candidate';

/** 有 OPENROUTER_API_KEY 就用真模型（和生产选同一个：suggestModel），否则用假模型。 */
export function chooseModel(env: NodeJS.ProcessEnv): EvalModel {
  if (env.OPENROUTER_API_KEY?.trim())
    return { kind: 'real', model: suggestModel(env) };
  return { kind: 'fake', model: FAKE_MODEL_ID };
}

/** 从 pick_faq 的提示里取出候选 id（按检索顺序）。 */
function candidateIds(prompt: string): string[] {
  try {
    const body = JSON.parse(prompt) as { candidates?: { id?: unknown }[] };
    return (body.candidates ?? [])
      .map((item) => item.id)
      .filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

/**
 * 假模型：pi 自带的 faux provider，每一步都调用 pick_faq 选第一个候选（检索排第一的那条）。
 * 走的是同一个 PiStepRunner（同样的工具、枚举、闸），只是不连网、不花钱。
 */
export async function fakeTopCandidateSource(): Promise<ModelSource> {
  const pi = await loadPi();
  const handle = pi.ai.fauxProvider({});
  const models = pi.ai.createModels();
  models.setProvider(handle.provider);
  return () => {
    handle.setResponses([
      (context) => {
        const last = context.messages[context.messages.length - 1];
        const content = last?.role === 'user' ? last.content : '';
        const prompt =
          typeof content === 'string'
            ? content
            : content.map((part) => ('text' in part ? part.text : '')).join('');
        const [first] = candidateIds(prompt);
        return pi.ai.fauxAssistantMessage(
          [pi.ai.fauxToolCall('pick_faq', { faqId: first ?? 'none' })],
          { stopReason: 'toolUse' },
        );
      },
    ]);
    return { models, model: handle.getModel() };
  };
}

/* ---------------------------------- 运行 ---------------------------------- */

export type CaseResult = {
  id: string;
  locale: EvalLocale;
  persona: EvalPersona;
  message: string;
  expectedFaqId: string | null;
  gotFaqId: string | null;
  /** turn/end.reason（answered / no_match / timeout …）。 */
  reason: string | null;
  latencyMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
};

export type RunOptions = {
  cases: EvalCase[];
  qa: HelpdeskQaSource;
  runner: AgentStepRunner;
  /** 给服务的环境（key、模型、base URL）。 */
  env: NodeJS.ProcessEnv;
  budgetUsd: number;
  /** 模型要花钱（真模型，缺省）：报了 token 却没有价格就停，守不住上限。假模型传 false。 */
  paid?: boolean;
  /** 每条用例跑完调一次（打印进度用）。 */
  onCase?: (result: CaseResult, index: number) => void;
};

export type RunOutcome = {
  results: CaseResult[];
  spentUsd: number;
  /** null：全部跑完；budget：花到上限；unknown_cost：有 token 却没有价格，无法守住上限。 */
  stopped: null | 'budget' | 'unknown_cost';
};

const noopLog: HelpdeskSuggestionLog = {
  record: () => Promise.resolve(),
  setOutcome: () =>
    Promise.resolve({ kind: 'recorded', outcome: 'helpful', changed: false }),
  purgeQueryText: () => Promise.resolve(0),
};

const num = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

export async function runCases(options: RunOptions): Promise<RunOutcome> {
  const events = createMemoryAgentEventLog();
  const service = new HelpdeskSuggestService({
    qa: options.qa,
    runner: options.runner,
    rateLimit: new MemoryRateLimitStore(),
    log: noopLog,
    events,
    env: () => options.env,
  });
  const results: CaseResult[] = [];
  let spentUsd = 0;
  for (const [index, item] of options.cases.entries()) {
    if (spentUsd >= options.budgetUsd)
      return { results, spentUsd, stopped: 'budget' };
    const runId = uuidv7();
    const started = performance.now();
    const answer = await service.suggest({
      learnerId: `eval-${item.id}`,
      locale: serviceLocale(item.locale),
      source: 'chat',
      message: item.message,
      runId,
    });
    const latencyMs = performance.now() - started;
    await service.flushTraces();
    const log = await events.read(runId);
    const replies = log.filter((e) => e.type === 'assistant/message');
    const usage = (data: Record<string, unknown>) =>
      (data.usage ?? {}) as Record<string, unknown>;
    const result: CaseResult = {
      id: item.id,
      locale: item.locale,
      persona: item.persona,
      message: item.message,
      expectedFaqId: item.expectedFaqId,
      gotFaqId: answer.suggestion?.faqId ?? null,
      reason: (log.find((e) => e.type === 'turn/end')?.data.reason ?? null) as
        string | null,
      latencyMs,
      costUsd: replies.reduce((sum, e) => sum + num(e.data.costUsd), 0),
      inputTokens: replies.reduce(
        (sum, e) => sum + num(usage(e.data).inputTokens),
        0,
      ),
      outputTokens: replies.reduce(
        (sum, e) => sum + num(usage(e.data).outputTokens),
        0,
      ),
    };
    results.push(result);
    spentUsd += result.costUsd;
    options.onCase?.(result, index);
    if (
      (options.paid ?? true) &&
      result.costUsd === 0 &&
      result.inputTokens + result.outputTokens > 0
    )
      return { results, spentUsd, stopped: 'unknown_cost' };
  }
  return { results, spentUsd, stopped: null };
}

/** 真模型：生产同款 PiStepRunner；假模型：同一个 runner 换成 faux provider。 */
export async function runnerFor(model: EvalModel): Promise<{
  runner: AgentStepRunner;
  env: (base: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
}> {
  if (model.kind === 'real')
    return {
      runner: new PiStepRunner(),
      env: (base) => ({ ...base, HELPDESK_SUGGEST_MODEL: model.model }),
    };
  const source = await fakeTopCandidateSource();
  return {
    runner: new PiStepRunner({ source }),
    env: () => ({
      // 假模型不连网：这些只是让工作流走到 pick_faq 那一步
      OPENROUTER_API_KEY: 'fake-key-local-only',
      OPENROUTER_BASE_URL: 'http://fake-model.invalid/api/v1',
      HELPDESK_SUGGEST_MODEL: FAKE_MODEL_ID,
    }),
  };
}

/* ---------------------------------- 报告 ---------------------------------- */

export type Slice = {
  cases: number;
  accuracy: number;
  wrongAnswerRate: number;
};

export type EvalReport = {
  generatedAt: string;
  model: EvalModel & { note: string | null };
  retrieval: 'memory' | 'postgresql';
  budget: {
    capUsd: number;
    spentUsd: number;
    stopped: RunOutcome['stopped'];
  };
  cases: { total: number; run: number };
  metrics: {
    accuracy: number;
    wrongAnswerRate: number;
    none: { precision: number | null; recall: number | null };
    latencyMs: { p50: number; p95: number };
    costUsd: number;
    tokens: { input: number; output: number };
  };
  byPersona: Record<string, Slice>;
  byLocale: Record<string, Slice>;
  failures: (Omit<CaseResult, 'costUsd' | 'inputTokens' | 'outputTokens'> & {
    kind: 'wrong_answer' | 'missed';
  })[];
  gate: {
    wrongAnswerRateMax: number;
    p95MaxMs: number;
    pass: boolean;
    reasons: string[];
  };
};

/** 最近秩百分位（p ∈ (0, 1]）。 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

const isWrong = (r: CaseResult) =>
  r.gotFaqId !== null && r.gotFaqId !== r.expectedFaqId;
const isRight = (r: CaseResult) => r.gotFaqId === r.expectedFaqId;
const round = (value: number, digits = 4) =>
  Math.round(value * 10 ** digits) / 10 ** digits;

function slice(results: CaseResult[]): Slice {
  return {
    cases: results.length,
    accuracy: round(results.filter(isRight).length / results.length),
    wrongAnswerRate: round(results.filter(isWrong).length / results.length),
  };
}

function sliceBy(
  results: CaseResult[],
  key: 'persona' | 'locale',
): Record<string, Slice> {
  const groups = new Map<string, CaseResult[]>();
  for (const result of results)
    groups.set(result[key], [...(groups.get(result[key]) ?? []), result]);
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, items]) => [name, slice(items)]),
  );
}

export function summarize(input: {
  outcome: RunOutcome;
  totalCases: number;
  model: EvalModel;
  retrieval: EvalReport['retrieval'];
  budgetUsd: number;
  now?: Date;
}): EvalReport {
  const { results } = input.outcome;
  const n = results.length;
  const predictedNone = results.filter((r) => r.gotFaqId === null);
  const expectedNone = results.filter((r) => r.expectedFaqId === null);
  const trueNone = results.filter(
    (r) => r.gotFaqId === null && r.expectedFaqId === null,
  ).length;
  const latencies = results.map((r) => r.latencyMs);
  const metrics: EvalReport['metrics'] = {
    accuracy: n ? round(results.filter(isRight).length / n) : 0,
    wrongAnswerRate: n ? round(results.filter(isWrong).length / n) : 0,
    none: {
      precision: predictedNone.length
        ? round(trueNone / predictedNone.length)
        : null,
      recall: expectedNone.length
        ? round(trueNone / expectedNone.length)
        : null,
    },
    latencyMs: {
      p50: Math.round(percentile(latencies, 0.5)),
      p95: Math.round(percentile(latencies, 0.95)),
    },
    costUsd: round(input.outcome.spentUsd, 6),
    tokens: {
      input: results.reduce((sum, r) => sum + r.inputTokens, 0),
      output: results.reduce((sum, r) => sum + r.outputTokens, 0),
    },
  };
  const reasons: string[] = [];
  if (metrics.wrongAnswerRate > GATE.wrongAnswerRateMax)
    reasons.push(
      `wrong-answer rate ${(metrics.wrongAnswerRate * 100).toFixed(2)}% > ${GATE.wrongAnswerRateMax * 100}%`,
    );
  if (metrics.latencyMs.p95 > GATE.p95MaxMs)
    reasons.push(`p95 ${metrics.latencyMs.p95} ms > ${GATE.p95MaxMs} ms`);
  if (input.outcome.stopped)
    reasons.push(
      `stopped early (${input.outcome.stopped}) after ${n} of ${input.totalCases} cases`,
    );
  if (input.model.kind === 'fake')
    reasons.push('fake model: not a real-model result');
  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    model: {
      ...input.model,
      note:
        input.model.kind === 'fake'
          ? 'No OPENROUTER_API_KEY: fake model (pi faux provider, always the top retrieval candidate). These numbers check the harness, not a model.'
          : null,
    },
    retrieval: input.retrieval,
    budget: {
      capUsd: input.budgetUsd,
      spentUsd: metrics.costUsd,
      stopped: input.outcome.stopped,
    },
    cases: { total: input.totalCases, run: n },
    metrics,
    byPersona: sliceBy(results, 'persona'),
    byLocale: sliceBy(results, 'locale'),
    failures: results
      .filter((r) => !isRight(r))
      .map((r) => ({
        id: r.id,
        locale: r.locale,
        persona: r.persona,
        message: r.message,
        expectedFaqId: r.expectedFaqId,
        gotFaqId: r.gotFaqId,
        reason: r.reason,
        latencyMs: Math.round(r.latencyMs),
        kind: isWrong(r) ? ('wrong_answer' as const) : ('missed' as const),
      })),
    gate: {
      ...GATE,
      pass: reasons.length === 0,
      reasons,
    },
  };
}

const pct = (value: number | null) =>
  value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;

export function markdownReport(report: EvalReport): string {
  const rows = (slices: Record<string, Slice>) =>
    Object.entries(slices)
      .map(
        ([name, s]) =>
          `| ${name} | ${s.cases} | ${pct(s.accuracy)} | ${pct(s.wrongAnswerRate)} |`,
      )
      .join('\n');
  const lines = [
    `# Helpdesk suggestion eval`,
    '',
    `- Generated: ${report.generatedAt}`,
    `- Model: ${report.model.kind} \`${report.model.model}\`${report.model.note ? ` (${report.model.note})` : ''}`,
    `- Retrieval: ${report.retrieval}`,
    `- Cases: ${report.cases.run} of ${report.cases.total}`,
    `- Budget: $${report.budget.spentUsd.toFixed(4)} of $${report.budget.capUsd.toFixed(2)}${report.budget.stopped ? ` (stopped: ${report.budget.stopped})` : ''}`,
    '',
    `## Gate: ${report.gate.pass ? 'PASS' : 'FAIL'}`,
    '',
    `Wrong-answer rate ≤ ${report.gate.wrongAnswerRateMax * 100}% and p95 ≤ ${report.gate.p95MaxMs} ms.`,
    ...report.gate.reasons.map((reason) => `- ${reason}`),
    '',
    '## Metrics',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Accuracy | ${pct(report.metrics.accuracy)} |`,
    `| Wrong-answer rate | ${pct(report.metrics.wrongAnswerRate)} |`,
    `| none precision | ${pct(report.metrics.none.precision)} |`,
    `| none recall | ${pct(report.metrics.none.recall)} |`,
    `| Latency p50 / p95 | ${report.metrics.latencyMs.p50} / ${report.metrics.latencyMs.p95} ms |`,
    `| Cost | $${report.metrics.costUsd.toFixed(6)} |`,
    `| Tokens in / out | ${report.metrics.tokens.input} / ${report.metrics.tokens.output} |`,
    '',
    '## By persona',
    '',
    '| Persona | Cases | Accuracy | Wrong |',
    '| --- | --- | --- | --- |',
    rows(report.byPersona),
    '',
    '## By locale',
    '',
    '| Locale | Cases | Accuracy | Wrong |',
    '| --- | --- | --- | --- |',
    rows(report.byLocale),
    '',
    `## Failures (${report.failures.length})`,
    '',
    '| Case | Kind | Expected | Got | Reason |',
    '| --- | --- | --- | --- | --- |',
    ...report.failures.map(
      (f) =>
        `| ${f.id} | ${f.kind} | ${f.expectedFaqId ?? 'none'} | ${f.gotFaqId ?? 'none'} | ${f.reason ?? ''} |`,
    ),
    '',
  ];
  return lines.join('\n');
}

/** .md 写 Markdown，其它写 JSON。 */
export function writeReport(path: string, report: EvalReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    path.endsWith('.md')
      ? markdownReport(report)
      : `${JSON.stringify(report, null, 2)}\n`,
  );
}

export function budgetFrom(env: NodeJS.ProcessEnv): number {
  const raw = env.HELPDESK_EVAL_BUDGET_USD?.trim();
  if (!raw) return DEFAULT_BUDGET_USD;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error('HELPDESK_EVAL_BUDGET_USD must be a positive number');
  return value;
}

export type { FaqCategory };
