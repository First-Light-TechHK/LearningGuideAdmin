import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool } from 'pg';

import type { AgentStepRunner } from '../../src/ai/helpdesk/workflow/engine';
import {
  budgetFrom,
  chooseModel,
  DEFAULT_BUDGET_USD,
  EVAL_LOCALES,
  EVAL_PERSONAS,
  FAKE_MODEL_ID,
  helpdeskMigrationSql,
  loadCases,
  loadFaqs,
  markdownReport,
  memoryQaSource,
  percentile,
  pgQaSource,
  runCases,
  runnerFor,
  summarize,
  writeReport,
  type CaseResult,
  type EvalReport,
} from './harness';

/**
 * Helpdesk 推荐评测（helpdesk-agent-v2-pi-dsh §5）在 CI 里跑：数据集合法且覆盖到位、
 * 报告的每个数字按定义算、预算到了就停、整套用假模型（pi faux provider）真跑一遍并写出报告。
 * 真模型的成绩只在有 OPENROUTER_API_KEY 时由 `npm run eval:helpdesk` 给出，这里不碰网络。
 */

const DIR = __dirname;
const faqs = loadFaqs(join(DIR, 'faqs.json'));
const cases = loadCases(join(DIR, 'cases.jsonl'));
const FAQ = (n: number) =>
  `0192f0e0-0000-7000-8000-${String(n).padStart(12, '0')}`;

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hd-eval-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('eval dataset', () => {
  it('has about 120 cases with unique ids', () => {
    expect(cases.length).toBeGreaterThanOrEqual(120);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it('only expects FAQs that exist in the seed library, and asks about every one of them', () => {
    const ids = new Set(faqs.map((f) => f.id));
    expect(ids.size).toBe(faqs.length);
    for (const item of cases)
      if (item.expectedFaqId) expect(ids).toContain(item.expectedFaqId);
    const asked = new Set(cases.map((c) => c.expectedFaqId));
    for (const faq of faqs) expect(asked).toContain(faq.id);
  });

  it('covers every locale and persona, with enough none cases to measure none precision and recall', () => {
    const count = (pick: (c: (typeof cases)[number]) => boolean) =>
      cases.filter(pick).length;
    for (const locale of EVAL_LOCALES)
      expect(count((c) => c.locale === locale)).toBeGreaterThanOrEqual(10);
    for (const persona of EVAL_PERSONAS)
      expect(count((c) => c.persona === persona)).toBeGreaterThanOrEqual(4);
    expect(count((c) => c.expectedFaqId === null)).toBeGreaterThanOrEqual(25);
    // 不可回答、越权的问题都应该是 none
    expect(
      count((c) => c.persona === 'unanswerable' && c.expectedFaqId !== null),
    ).toBe(0);
    expect(
      count((c) => c.persona === 'over_reach' && c.expectedFaqId !== null),
    ).toBe(0);
  });

  it('every seed FAQ has both languages and keywords', () => {
    for (const faq of faqs) {
      for (const text of [
        faq.questionEn,
        faq.answerEn,
        faq.questionZh,
        faq.answerZh,
      ])
        expect(text.trim()).not.toBe('');
      expect(faq.keywords.length).toBeGreaterThan(0);
    }
  });

  it('rejects a malformed case line with its line number', () => {
    const path = join(tmp, 'bad.jsonl');
    writeFileSync(
      path,
      `${JSON.stringify(cases[0])}\n\n${JSON.stringify({ ...cases[0], locale: 'fr-FR' })}\n`,
    );
    expect(() => loadCases(path)).toThrow(`${path}:3: malformed case`);
  });
});

function result(
  over: Partial<CaseResult> & Pick<CaseResult, 'expectedFaqId' | 'gotFaqId'>,
): CaseResult {
  return {
    id: 'x',
    locale: 'en-GB',
    persona: 'paraphrase',
    message: 'm',
    reason: over.gotFaqId ? 'answered' : 'no_match',
    latencyMs: 100,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    ...over,
  };
}

describe('report', () => {
  const A = FAQ(1);
  const B = FAQ(2);
  // 10 条：6 条答对（4 条有答案、2 条 none），2 条答错，2 条漏答
  const results: CaseResult[] = [
    result({ id: 'r1', expectedFaqId: A, gotFaqId: A, latencyMs: 10 }),
    result({ id: 'r2', expectedFaqId: A, gotFaqId: A, latencyMs: 20 }),
    result({
      id: 'r3',
      expectedFaqId: B,
      gotFaqId: B,
      latencyMs: 30,
      locale: 'zh-CN',
    }),
    result({
      id: 'r4',
      expectedFaqId: B,
      gotFaqId: B,
      latencyMs: 40,
      locale: 'zh-TW',
      persona: 'terse',
    }),
    result({
      id: 'r5',
      expectedFaqId: null,
      gotFaqId: null,
      latencyMs: 50,
      persona: 'unanswerable',
    }),
    result({
      id: 'r6',
      expectedFaqId: null,
      gotFaqId: null,
      latencyMs: 60,
      persona: 'unanswerable',
    }),
    result({
      id: 'r7',
      expectedFaqId: A,
      gotFaqId: B,
      latencyMs: 70,
      persona: 'typo',
    }),
    result({
      id: 'r8',
      expectedFaqId: null,
      gotFaqId: A,
      latencyMs: 80,
      persona: 'injection',
    }),
    result({
      id: 'r9',
      expectedFaqId: A,
      gotFaqId: null,
      latencyMs: 90,
      reason: 'timeout',
    }),
    result({
      id: 'r10',
      expectedFaqId: B,
      gotFaqId: null,
      latencyMs: 3_500,
      locale: 'zh-CN',
    }),
  ].map((r) => ({ ...r, costUsd: 0.001, inputTokens: 100, outputTokens: 5 }));
  const real = { kind: 'real', model: 'openai/gpt-4o-mini' } as const;
  const now = new Date('2026-10-29T10:00:00.000Z');

  it('computes accuracy, wrong-answer rate, none precision / recall, latency percentiles, cost and tokens', () => {
    const report = summarize({
      outcome: { results, spentUsd: 0.01, stopped: null },
      totalCases: 10,
      model: real,
      retrieval: 'memory',
      budgetUsd: 5,
      now,
    });
    expect(report.generatedAt).toBe('2026-10-29T10:00:00.000Z');
    expect(report.metrics).toEqual({
      accuracy: 0.6,
      wrongAnswerRate: 0.2,
      // 预测 none 4 条（r5 r6 r9 r10），其中 2 条该是 none；该是 none 的 3 条（r5 r6 r8）里找回 2 条
      none: { precision: 0.5, recall: 0.6667 },
      latencyMs: { p50: 50, p95: 3_500 },
      costUsd: 0.01,
      tokens: { input: 1_000, output: 50 },
    });
    expect(report.cases).toEqual({ total: 10, run: 10 });
    expect(report.budget).toEqual({ capUsd: 5, spentUsd: 0.01, stopped: null });
    expect(report.model).toEqual({ ...real, note: null });
  });

  it('breaks results down by persona and by locale', () => {
    const report = summarize({
      outcome: { results, spentUsd: 0, stopped: null },
      totalCases: 10,
      model: real,
      retrieval: 'memory',
      budgetUsd: 5,
    });
    expect(report.byLocale).toEqual({
      'en-GB': { cases: 7, accuracy: 0.5714, wrongAnswerRate: 0.2857 },
      'zh-CN': { cases: 2, accuracy: 0.5, wrongAnswerRate: 0 },
      'zh-TW': { cases: 1, accuracy: 1, wrongAnswerRate: 0 },
    });
    expect(report.byPersona).toEqual({
      injection: { cases: 1, accuracy: 0, wrongAnswerRate: 1 },
      paraphrase: { cases: 5, accuracy: 0.6, wrongAnswerRate: 0 },
      terse: { cases: 1, accuracy: 1, wrongAnswerRate: 0 },
      typo: { cases: 1, accuracy: 0, wrongAnswerRate: 1 },
      unanswerable: { cases: 2, accuracy: 1, wrongAnswerRate: 0 },
    });
  });

  it('lists every failure as a wrong answer or a miss, without cost columns', () => {
    const report = summarize({
      outcome: { results, spentUsd: 0, stopped: null },
      totalCases: 10,
      model: real,
      retrieval: 'memory',
      budgetUsd: 5,
    });
    expect(report.failures.map((f) => [f.id, f.kind, f.reason])).toEqual([
      ['r7', 'wrong_answer', 'answered'],
      ['r8', 'wrong_answer', 'answered'],
      ['r9', 'missed', 'timeout'],
      ['r10', 'missed', 'no_match'],
    ]);
    expect(report.failures[0]).not.toHaveProperty('costUsd');
  });

  it('gates on wrong-answer rate ≤ 2% and p95 ≤ 3 s', () => {
    const gate = (rs: CaseResult[], model: EvalReport['model'] = real) =>
      summarize({
        outcome: { results: rs, spentUsd: 0, stopped: null },
        totalCases: rs.length,
        model,
        retrieval: 'memory',
        budgetUsd: 5,
      }).gate;
    expect(gate(results)).toEqual({
      wrongAnswerRateMax: 0.02,
      p95MaxMs: 3_000,
      pass: false,
      reasons: ['wrong-answer rate 20.00% > 2%', 'p95 3500 ms > 3000 ms'],
    });

    // 50 条里 1 条答错（2%）、p95 正好 3 秒：过
    const ok = Array.from({ length: 50 }, (_, i) =>
      result({
        id: `ok${i}`,
        expectedFaqId: A,
        gotFaqId: i === 0 ? B : A,
        latencyMs: i < 47 ? 1_000 : 3_000,
      }),
    );
    expect(gate(ok)).toMatchObject({ pass: true, reasons: [] });
    // 再多 1 条答错就不过
    ok[1] = { ...ok[1], gotFaqId: B };
    expect(gate(ok).reasons).toEqual(['wrong-answer rate 4.00% > 2%']);

    // 漏答不算答错
    const misses = ok.map((r) => ({ ...r, gotFaqId: null }));
    expect(gate(misses).pass).toBe(true);

    // 假模型永远不过
    expect(
      gate(misses, { kind: 'fake', model: FAKE_MODEL_ID }).reasons,
    ).toEqual(['fake model: not a real-model result']);
  });

  it('a run stopped by the budget does not pass', () => {
    const report = summarize({
      outcome: {
        results: results.slice(0, 4),
        spentUsd: 5.2,
        stopped: 'budget',
      },
      totalCases: 10,
      model: real,
      retrieval: 'memory',
      budgetUsd: 5,
    });
    expect(report.gate.pass).toBe(false);
    expect(report.gate.reasons).toEqual([
      'stopped early (budget) after 4 of 10 cases',
    ]);
    expect(report.cases).toEqual({ total: 10, run: 4 });
  });

  it('nearest-rank percentiles', () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([5], 0.95)).toBe(5);
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2);
    expect(percentile([4, 1, 3, 2], 0.95)).toBe(4);
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 0.5)).toBe(50);
    expect(percentile(hundred, 0.95)).toBe(95);
  });

  it('writes JSON for .json and Markdown for .md', () => {
    const report = summarize({
      outcome: { results, spentUsd: 0.01, stopped: null },
      totalCases: 10,
      model: real,
      retrieval: 'memory',
      budgetUsd: 5,
      now,
    });
    const json = join(tmp, 'nested', 'report.json');
    const md = join(tmp, 'report.md');
    writeReport(json, report);
    writeReport(md, report);
    expect(JSON.parse(readFileSync(json, 'utf8'))).toEqual(report);
    const text = readFileSync(md, 'utf8');
    expect(text).toBe(markdownReport(report));
    expect(text).toContain('## Gate: FAIL');
    expect(text).toContain('| Wrong-answer rate | 20.0% |');
    expect(text).toContain('| none recall | 66.7% |');
    expect(text).toContain('| Latency p50 / p95 | 50 / 3500 ms |');
    expect(text).toContain('| zh-TW | 1 | 100.0% | 0.0% |');
    expect(text).toContain(`| r7 | wrong_answer | ${A} | ${B} | answered |`);
    expect(text).toContain(`| r10 | missed | ${B} | none | no_match |`);
  });
});

describe('model and budget settings', () => {
  it('uses the real model only with an OpenRouter key', () => {
    expect(chooseModel({})).toEqual({ kind: 'fake', model: FAKE_MODEL_ID });
    expect(chooseModel({ OPENROUTER_API_KEY: '  ' })).toEqual({
      kind: 'fake',
      model: FAKE_MODEL_ID,
    });
    expect(chooseModel({ OPENROUTER_API_KEY: 'k' })).toEqual({
      kind: 'real',
      model: 'openai/gpt-4o-mini',
    });
    expect(
      chooseModel({
        OPENROUTER_API_KEY: 'k',
        HELPDESK_SUGGEST_MODEL: 'anthropic/claude-haiku',
      }),
    ).toEqual({ kind: 'real', model: 'anthropic/claude-haiku' });
    // 没配 HELPDESK_SUGGEST_MODEL 时和生产选同一个模型
    expect(
      chooseModel({
        OPENROUTER_API_KEY: 'k',
        AI_AVAILABLE_MODELS: 'deepseek/deepseek-r1,google/gemini-3.5-flash',
      }),
    ).toEqual({ kind: 'real', model: 'google/gemini-3.5-flash' });
  });

  it('caps spend at HELPDESK_EVAL_BUDGET_USD, 5 USD by default', () => {
    expect(DEFAULT_BUDGET_USD).toBe(5);
    expect(budgetFrom({})).toBe(5);
    expect(budgetFrom({ HELPDESK_EVAL_BUDGET_USD: '0.5' })).toBe(0.5);
    for (const bad of ['0', '-1', 'abc', 'Infinity'])
      expect(() => budgetFrom({ HELPDESK_EVAL_BUDGET_USD: bad })).toThrow(
        'HELPDESK_EVAL_BUDGET_USD must be a positive number',
      );
  });
});

/** 每一步都花 costUsd、用 tokens，选第一个候选。 */
function payingRunner(costUsd: number, tokens = 100): AgentStepRunner {
  return {
    run: (spec, context) => {
      context.trace.emit('assistant/message', {
        turn: context.trace.turn,
        step: context.step,
        model: 'stub',
        usage: { inputTokens: tokens, outputTokens: 1 },
        costUsd,
      });
      const [first] = Object.values(spec.tool.enumArgs)[0];
      return Promise.resolve({ kind: 'called', args: { faqId: first } });
    },
  };
}

const ENV = { OPENROUTER_API_KEY: 'stub', HELPDESK_SUGGEST_MODEL: 'stub' };

describe('running the cases', () => {
  const answerable = cases.filter((c) => c.persona === 'paraphrase');

  it('stops once the spend reaches the budget', async () => {
    const outcome = await runCases({
      cases: answerable.slice(0, 10),
      qa: memoryQaSource(faqs),
      runner: payingRunner(0.4),
      env: ENV,
      budgetUsd: 1,
    });
    // 0.4 + 0.4 + 0.4 = 1.2 ≥ 1：第 4 条不再跑
    expect(outcome.results).toHaveLength(3);
    expect(outcome.stopped).toBe('budget');
    expect(outcome.spentUsd).toBeCloseTo(1.2, 10);
    expect(outcome.results.map((r) => r.costUsd)).toEqual([0.4, 0.4, 0.4]);
    expect(outcome.results[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 1,
      reason: 'answered',
    });
  });

  it('stops when a model reports tokens but no price, because the cap cannot be kept', async () => {
    const outcome = await runCases({
      cases: answerable.slice(0, 5),
      qa: memoryQaSource(faqs),
      runner: payingRunner(0),
      env: ENV,
      budgetUsd: 5,
    });
    expect(outcome.results).toHaveLength(1);
    expect(outcome.stopped).toBe('unknown_cost');
  });

  it('runs through when every case is within budget', async () => {
    const seen: number[] = [];
    const outcome = await runCases({
      cases: answerable.slice(0, 4),
      qa: memoryQaSource(faqs),
      runner: payingRunner(0.001),
      env: ENV,
      budgetUsd: 5,
      onCase: (_result, index) => seen.push(index),
    });
    expect(outcome.stopped).toBeNull();
    expect(outcome.results).toHaveLength(4);
    expect(seen).toEqual([0, 1, 2, 3]);
  });

  it('without a key the service answers nothing, like production', async () => {
    const outcome = await runCases({
      cases: answerable.slice(0, 2),
      qa: memoryQaSource(faqs),
      runner: payingRunner(0.001),
      env: {},
      budgetUsd: 5,
    });
    expect(outcome.results.map((r) => [r.gotFaqId, r.reason])).toEqual([
      [null, 'no_key'],
      [null, 'no_key'],
    ]);
  });

  it('runs the whole set through the pi workflow with the fake model and writes both reports', async () => {
    const model = chooseModel({});
    const { runner, env } = await runnerFor(model);
    const outcome = await runCases({
      cases,
      qa: memoryQaSource(faqs),
      runner,
      env: env({}),
      budgetUsd: DEFAULT_BUDGET_USD,
      // pi 的 faux provider 估 token、价格为 0：不花钱，不按缺价停
      paid: false,
    });
    expect(outcome.stopped).toBeNull();
    expect(outcome.results).toHaveLength(cases.length);
    // 假模型只会选检索出来的候选，或在没有候选时 none
    const known = new Set(faqs.map((f) => f.id));
    for (const r of outcome.results) {
      if (r.gotFaqId) expect(known).toContain(r.gotFaqId);
      expect(r.reason).toMatch(/^(answered|no_match|no_candidates)$/);
      expect(r.costUsd).toBe(0);
    }
    expect(outcome.results.some((r) => r.gotFaqId !== null)).toBe(true);

    const report = summarize({
      outcome,
      totalCases: cases.length,
      model,
      retrieval: 'memory',
      budgetUsd: DEFAULT_BUDGET_USD,
    });
    expect(report.model.kind).toBe('fake');
    expect(report.model.note).toMatch(/not a model/);
    expect(report.gate.pass).toBe(false);
    expect(report.gate.reasons).toContain(
      'fake model: not a real-model result',
    );
    expect(Object.keys(report.byPersona).sort()).toEqual(
      [...EVAL_PERSONAS].sort(),
    );
    expect(Object.keys(report.byLocale)).toEqual([...EVAL_LOCALES]);
    expect(report.metrics.latencyMs.p95).toBeLessThan(3_000);

    writeReport(join(tmp, 'fake.json'), report);
    writeReport(join(tmp, 'fake.md'), report);
    expect(
      (JSON.parse(readFileSync(join(tmp, 'fake.json'), 'utf8')) as EvalReport)
        .cases,
    ).toEqual({ total: cases.length, run: cases.length });
    expect(readFileSync(join(tmp, 'fake.md'), 'utf8')).toContain(
      'fake `fake/top-candidate`',
    );
  }, 60_000);
});

const PG_URL = process.env.HELPDESK_TEST_DATABASE_URL;
const pgIt = PG_URL ? it : it.skip;

describe('PostgreSQL retrieval (HELPDESK_TEST_DATABASE_URL)', () => {
  pgIt(
    'runs the production candidate SQL in a scratch schema and drops it afterwards',
    async () => {
      const url = PG_URL as string;
      const { qa, close } = await pgQaSource(url, faqs, helpdeskMigrationSql());
      let schemas: string[] = [];
      try {
        const password = await qa.findCandidates({
          text: 'forgot password reset email',
          locale: 'en-GB',
          category: null,
          limit: 5,
        });
        expect(password[0]?.id).toBe(FAQ(1));
        const zh = await qa.findPublished(FAQ(1), 'zh-CN');
        expect(zh?.answer).toBe(faqs[0].answerZh);
      } finally {
        await close();
        const pool = new Pool({ connectionString: url });
        schemas = (
          await pool.query<{ nspname: string }>(
            "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'hdeval_%'",
          )
        ).rows.map((row) => row.nspname);
        await pool.end();
      }
      expect(schemas).toEqual([]);
    },
    60_000,
  );
});
