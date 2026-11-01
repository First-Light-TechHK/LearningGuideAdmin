import {
  cardRewriteSpec,
  createModelCardRewriter,
} from '../../ai/helpdesk/card-rewriter';
import type {
  AgentStepOutcome,
  AgentStepRunner,
} from '../../ai/helpdesk/workflow/engine';
import type {
  CardRewriteResult,
  CardRewriter,
} from '../../contracts/helpdesk-card-rewrite';
import {
  REWRITE_LIMITS,
  buildDraft,
  createFaqRewriteService,
  newFacts,
  rewriteInput,
} from '../modules/helpdesk/faqs/faqRewrite';
import { HelpdeskError } from '../modules/helpdesk/portalHelpdeskClient';

/**
 * 「AI 按指令改卡」（owner 2026-10-31，像 Claude Artifact）：只用 DeepSeek、不保存；
 * 代码兜底（长度、变空、语言）与「新出现的数字 / 链接 / 邮箱」提示；一段只改那一段；每分钟限次。
 */
const CARD = {
  questionZh: '退款要多久？',
  answerZh: '退款申请通过后，**5 个工作日**内原路退回。',
  questionEn: 'How long does a refund take?',
  answerEn:
    'Once approved, the refund goes back to your card within **5 working days**.',
  category: 'payments_subscriptions',
};

const body = (extra: Record<string, unknown> = {}) => ({
  ...CARD,
  instruction: '语气更亲切一点',
  lang: 'zh',
  ...extra,
});

async function rejects(
  work: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  const error = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HelpdeskError);
  expect(error).toMatchObject({ status, code });
}

describe('rewriteInput', () => {
  it('accepts a card and an instruction; a selection must mark text inside the field', () => {
    expect(rewriteInput(body())).toMatchObject({
      mode: 'card',
      instruction: '语气更亲切一点',
    });
    expect(
      rewriteInput(
        body({ selection: { field: 'answerZh', start: 9, end: 18 } }),
      ),
    ).toMatchObject({
      mode: 'selection',
      selection: { field: 'answerZh', start: 9, end: 18 },
    });
    for (const bad of [
      body({ instruction: '   ' }),
      body({ instruction: 'x'.repeat(REWRITE_LIMITS.instructionMax + 1) }),
      body({ category: 'refunds' }),
      body({ lang: 'fr' }),
      body({ questionZh: 'x'.repeat(201) }),
      body({ answerEn: 42 }),
      body({ selection: { field: 'key', start: 0, end: 1 } }),
      body({ selection: { field: 'answerZh', start: 5, end: 5 } }),
      body({ selection: { field: 'answerZh', start: 0, end: 999 } }),
    ])
      expect(() => rewriteInput(bad)).toThrow(HelpdeskError);
  });

  it('strips control characters and normalises line breaks', () => {
    const input = rewriteInput(
      body({
        answerEn: 'Line one\r\nLine\u0000 two',
        instruction: 'Shorter\u0007',
      }),
    );
    expect(input.card.answerEn).toBe('Line one\nLine two');
    expect(input.instruction).toBe('Shorter');
  });
});

describe('newFacts', () => {
  it('flags numbers, links and emails that neither the card nor the instruction had', () => {
    const known = `${CARD.answerEn}\n请写上客服邮箱 help@ilovelearningguide.com`;
    expect(
      newFacts(
        'answerEn',
        'Within 5 working days (usually 3). Email help@ilovelearningguide.com or see https://example.org/refunds.',
        known,
      ),
    ).toEqual([
      { field: 'answerEn', kind: 'link', text: 'https://example.org/refunds' },
      { field: 'answerEn', kind: 'number', text: '3' },
    ]);
  });
});

describe('buildDraft', () => {
  it('takes only the fields the model changed and lists them, category included', () => {
    const input = rewriteInput(
      body({ instruction: '改成 3 到 5 个工作日，分类改为其他' }),
    );
    const out = buildDraft(input, {
      texts: {
        answerZh: '退款申请通过后，**3 到 5 个工作日**内原路退回。',
        answerEn:
          'Once approved, the refund goes back to your card within **3 to 5 working days**.',
        questionEn: CARD.questionEn,
      },
      category: 'other',
    });
    expect(out.changed).toEqual(['answerZh', 'answerEn', 'category']);
    expect(out.draft.questionZh).toBe(CARD.questionZh);
    expect(out.draft.category).toBe('other');
    expect(out.warnings).toEqual([]);
  });

  it('drops a field that went empty, too long or into the wrong language, and keeps the original', () => {
    const input = rewriteInput(body());
    const out = buildDraft(input, {
      texts: {
        questionZh: '',
        answerZh: 'Refund within five working days.',
        questionEn: '退款要多久？',
        answerEn: 'x'.repeat(4001),
      },
    });
    expect(out.changed).toEqual([]);
    expect(out.draft).toEqual(input.card);
    expect(out.warnings).toEqual([
      { field: 'questionZh', kind: 'dropped', reason: 'empty' },
      { field: 'answerZh', kind: 'dropped', reason: 'language' },
      { field: 'questionEn', kind: 'dropped', reason: 'language' },
      { field: 'answerEn', kind: 'dropped', reason: 'too_long' },
    ]);
  });

  it('splices a selection back into the field and never changes the rest', () => {
    const start = CARD.answerZh.indexOf('5 个工作日');
    const input = rewriteInput(
      body({
        instruction: '改成 3 到 5 个工作日',
        selection: {
          field: 'answerZh',
          start,
          end: start + '5 个工作日'.length,
        },
      }),
    );
    const out = buildDraft(input, {
      texts: { selection: '⟦3 到 5 个工作日⟧' },
    });
    expect(out.draft.answerZh).toBe(
      '退款申请通过后，**3 到 5 个工作日**内原路退回。',
    );
    expect(out.changed).toEqual(['answerZh']);
    expect(out.draft.answerEn).toBe(CARD.answerEn);
  });
});

describe('FAQ rewrite service', () => {
  const ok = (texts: Record<string, string>): CardRewriter => ({
    rewrite: () =>
      Promise.resolve({
        ok: true,
        texts,
        model: 'deepseek/deepseek-v4.1-flash',
        costUsd: 0.0004,
      } as CardRewriteResult),
  });
  const failing = (reason: 'disabled' | 'timeout' | 'error' | 'no_call') => ({
    rewrite: () =>
      Promise.resolve({ ok: false as const, reason, costUsd: null }),
  });
  const staff = { employeeId: '0192aaaa-0000-7000-8000-000000000001' };

  it('returns the draft, the changed fields, the model and the cost', async () => {
    const service = createFaqRewriteService({
      rewriter: ok({
        answerZh: '别担心：退款申请通过后，**5 个工作日**内原路退回。',
      }),
    });
    await expect(service.rewrite(staff, body())).resolves.toEqual({
      draft: {
        ...CARD,
        answerZh: '别担心：退款申请通过后，**5 个工作日**内原路退回。',
      },
      changed: ['answerZh'],
      model: 'deepseek/deepseek-v4.1-flash',
      costUsd: 0.0004,
      warnings: [],
    });
  });

  it('maps model failures to 503, 504 and 502', async () => {
    await rejects(
      createFaqRewriteService({ rewriter: failing('disabled') }).rewrite(
        staff,
        body(),
      ),
      503,
      'REWRITE_UNAVAILABLE',
    );
    await rejects(
      createFaqRewriteService({ rewriter: failing('timeout') }).rewrite(
        staff,
        body(),
      ),
      504,
      'REWRITE_TIMEOUT',
    );
    for (const reason of ['error', 'no_call'] as const)
      await rejects(
        createFaqRewriteService({ rewriter: failing(reason) }).rewrite(
          staff,
          body(),
        ),
        502,
        'REWRITE_FAILED',
      );
  });

  it('allows each staff member a limited number of edits a minute', async () => {
    let t = 0;
    const service = createFaqRewriteService({ rewriter: ok({}), now: () => t });
    for (let i = 0; i < REWRITE_LIMITS.perMinute; i += 1)
      await service.rewrite(staff, body());
    await rejects(service.rewrite(staff, body()), 429, 'REWRITE_RATE_LIMITED');
    await expect(
      service.rewrite(
        { employeeId: '0192aaaa-0000-7000-8000-000000000002' },
        body(),
      ),
    ).resolves.toBeDefined();
    t += 60_001;
    await expect(service.rewrite(staff, body())).resolves.toBeDefined();
  });
});

describe('model card rewriter (DeepSeek through the step runner)', () => {
  function runner(outcome: AgentStepOutcome) {
    const calls: Parameters<AgentStepRunner['run']>[] = [];
    return {
      calls,
      runner: {
        run: (...args: Parameters<AgentStepRunner['run']>) => {
          calls.push(args);
          return Promise.resolve(outcome);
        },
      } satisfies AgentStepRunner,
    };
  }
  const env = () => ({
    OPENROUTER_API_KEY: 'placeholder-key-for-tests',
    HELPDESK_SUGGEST_MODEL: 'deepseek/deepseek-v4.1-flash',
  });
  const model = (e: NodeJS.ProcessEnv) => e.HELPDESK_SUGGEST_MODEL ?? '';

  it('is disabled without a key and never calls the model', async () => {
    const fake = runner({ kind: 'no_call' });
    const rewriter = createModelCardRewriter({
      runner: fake.runner,
      model,
      env: () => ({}),
    });
    await expect(rewriter.rewrite(rewriteInput(body()))).resolves.toEqual({
      ok: false,
      reason: 'disabled',
      costUsd: null,
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('asks for the changed fields only, thinking off, and keeps the category on keep', async () => {
    const fake = runner({
      kind: 'called',
      args: { category: 'keep' },
      extras: {
        lists: {},
        texts: { answerZh: '新的中文答案。' },
        flags: {},
      },
    });
    const rewriter = createModelCardRewriter({
      runner: fake.runner,
      model,
      env,
    });
    await expect(rewriter.rewrite(rewriteInput(body()))).resolves.toEqual({
      ok: true,
      texts: { answerZh: '新的中文答案。' },
      model: 'deepseek/deepseek-v4.1-flash',
      costUsd: null,
    });
    const [spec, context] = fake.calls[0];
    expect(spec.tool.name).toBe('rewrite_card');
    expect(Object.keys(spec.tool.textArgs ?? {})).toEqual([
      'questionZh',
      'answerZh',
      'questionEn',
      'answerEn',
    ]);
    expect(context.model).toMatchObject({
      model: 'deepseek/deepseek-v4.1-flash',
      thinking: 'off',
    });
  });

  it('marks the selection in the prompt and returns only the new part', async () => {
    const fake = runner({
      kind: 'called',
      args: {},
      extras: { lists: {}, texts: { text: '3 到 5 个工作日' }, flags: {} },
    });
    const rewriter = createModelCardRewriter({
      runner: fake.runner,
      model,
      env,
    });
    const start = CARD.answerZh.indexOf('5 个工作日');
    const input = rewriteInput(
      body({ selection: { field: 'answerZh', start, end: start + 6 } }),
    );
    await expect(rewriter.rewrite(input)).resolves.toMatchObject({
      ok: true,
      texts: { selection: '3 到 5 个工作日' },
    });
    expect(cardRewriteSpec(input).prompt).toContain('**⟦5 个工作日⟧**');
  });
});
