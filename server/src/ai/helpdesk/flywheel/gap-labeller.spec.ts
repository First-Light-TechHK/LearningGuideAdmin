import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { GapLabelInput } from '../../../contracts/helpdesk-flywheel';
import type {
  AgentStepContext,
  AgentStepOutcome,
  AgentStepRunner,
  AgentStepSpec,
} from '../workflow/engine';
import { guardGapLabel, learnerOf } from '../workflow/guard';
import {
  createModelGapLabeller,
  LABEL_GAP_SYSTEM,
  labelGapSpec,
} from './gap-labeller';

/**
 * 数据飞轮的标签（v5 Part G3 第 3 步）：一组一次小的模型调用，只起话题、提一个学员口吻的问题、
 * 选一个分类（枚举）；守卫只信代码（语料 fixtures/gap-label-corpus.json，CI 里不调模型）。
 * 这里的 runner 是假的（faux）：从不发请求。
 */
type CorpusCase = {
  field: 'topic' | 'question';
  examples: string[];
  locale: string;
  text: string;
  expect: string;
};
const corpus = JSON.parse(
  readFileSync(
    join(__dirname, '../workflow/fixtures/gap-label-corpus.json'),
    'utf8',
  ),
) as { cases: CorpusCase[] };

describe('gap label guard corpus', () => {
  it('covers passes and every reason a label can fail on, in zh-CN, zh-TW and en', () => {
    expect(new Set(corpus.cases.map((c) => c.expect))).toEqual(
      new Set([
        'passed',
        'ungrounded',
        'markup',
        'email',
        'link',
        'too_long',
        'ai_filler',
        'script',
        'missing',
      ]),
    );
    const variants = new Set(
      corpus.cases.map(
        (c) => learnerOf(c.examples.join(' '), c.locale).variant,
      ),
    );
    expect(variants).toEqual(new Set(['zh-CN', 'zh-TW', 'en']));
  });

  it.each(corpus.cases.map((c, i) => [i, c.field, c.text, c] as const))(
    '#%i %s %j',
    (_i, _field, _text, c) => {
      const result = guardGapLabel(
        c.field,
        c.text,
        learnerOf(c.examples.join(' '), c.locale),
        c.examples,
      );
      if (c.expect === 'passed')
        expect(result).toEqual({ ok: true, text: c.text.trim() });
      else expect(result).toEqual({ ok: false, reason: c.expect });
    },
  );
});

class FakeRunner implements AgentStepRunner {
  calls: { spec: AgentStepSpec; context: AgentStepContext }[] = [];
  constructor(
    private readonly reply: (
      spec: AgentStepSpec,
      context: AgentStepContext,
    ) => Promise<AgentStepOutcome>,
  ) {}
  run(spec: AgentStepSpec, context: AgentStepContext) {
    this.calls.push({ spec, context });
    return this.reply(spec, context);
  }
}

const input: GapLabelInput = {
  locale: 'zh-CN',
  examples: ['付款成功了但是课程没有开通', '已经付款了课程还是没开通 <phone>'],
};

function called(
  texts: Record<string, string>,
  category = 'payments_subscriptions',
): AgentStepOutcome {
  return {
    kind: 'called',
    args: { category },
    extras: { lists: {}, texts, flags: {} },
  };
}

const env = () => ({ OPENROUTER_API_KEY: 'test-key-local-only' });

describe('model gap labeller (faux runner)', () => {
  it('is off without a key: no call at all', async () => {
    const runner = new FakeRunner(() => Promise.resolve(called({})));
    const labeller = createModelGapLabeller({
      runner,
      model: () => 'test/model',
      env: () => ({}),
    });
    expect(await labeller.label(input)).toEqual({
      ok: false,
      reason: 'disabled',
      costUsd: null,
    });
    expect(runner.calls).toHaveLength(0);
  });

  it('sends the scrubbed examples only in the prompt, with the category enum and two short texts', () => {
    const spec = labelGapSpec(input);
    expect(spec.system).toBe(LABEL_GAP_SYSTEM);
    for (const example of input.examples) {
      expect(spec.system).not.toContain(example);
      expect(spec.prompt).toContain(example);
    }
    expect(spec.tool.name).toBe('label_gap');
    expect(spec.tool.enumArgs).toEqual({
      category: [
        'account_technical',
        'courses_learning',
        'payments_subscriptions',
        'other',
        'none',
      ],
    });
    expect(Object.keys(spec.tool.textArgs ?? {})).toEqual([
      'topic',
      'question',
    ]);
    expect(spec.maxTokens).toBeLessThanOrEqual(200);
    expect(
      labelGapSpec({ ...input, examples: Array(8).fill('x') }).prompt.split(
        '\n',
      ),
    ).toHaveLength(2 + 5);
  });

  it('returns the guarded topic, question and category, and the cost the call reported', async () => {
    const runner = new FakeRunner((_spec, context) => {
      context.trace.emit('assistant/message', { costUsd: 0.0004 });
      return Promise.resolve(
        called({
          topic: '付款后课程未开通',
          question: '付款成功了课程还没开通怎么办？',
        }),
      );
    });
    const labeller = createModelGapLabeller({
      runner,
      model: () => 'test/model',
      env,
    });
    expect(await labeller.label(input)).toEqual({
      ok: true,
      label: {
        topic: '付款后课程未开通',
        question: '付款成功了课程还没开通怎么办？',
        category: 'payments_subscriptions',
      },
      costUsd: 0.0004,
    });
    const [{ context }] = runner.calls;
    expect(context.model).toMatchObject({
      provider: 'openrouter',
      model: 'test/model',
      apiKey: 'test-key-local-only',
    });
    expect(context.traceparent()).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/,
    );
  });

  it('category none is no category', async () => {
    const runner = new FakeRunner(() =>
      Promise.resolve(
        called({ topic: '课程未开通', question: '课程没开通怎么办？' }, 'none'),
      ),
    );
    const result = await createModelGapLabeller({
      runner,
      model: () => 'm',
      env,
    }).label(input);
    expect(result).toMatchObject({ ok: true, label: { category: null } });
  });

  it('anything the guard refuses (an invented number) is no label: the miner writes its own', async () => {
    const runner = new FakeRunner(() =>
      Promise.resolve(
        called({ topic: '课程未开通', question: '付款后要等24小时才开通吗？' }),
      ),
    );
    expect(
      await createModelGapLabeller({ runner, model: () => 'm', env }).label(
        input,
      ),
    ).toEqual({ ok: false, reason: 'guard', costUsd: null });
  });

  it('no call, an error or a slow model are reason codes, never a throw', async () => {
    const make = (reply: () => Promise<AgentStepOutcome>, timeoutMs = 50) =>
      createModelGapLabeller({
        runner: new FakeRunner(reply),
        model: () => 'm',
        env,
        timeoutMs,
      });
    expect(
      await make(() => Promise.resolve({ kind: 'no_call' })).label(input),
    ).toMatchObject({ ok: false, reason: 'no_call' });
    expect(
      await make(() => Promise.reject(new Error('boom'))).label(input),
    ).toMatchObject({ ok: false, reason: 'error' });
    expect(
      await make(
        (): Promise<AgentStepOutcome> =>
          new Promise((resolve) =>
            setTimeout(() => resolve(called({})), 1_000).unref(),
          ),
        20,
      ).label(input),
    ).toMatchObject({ ok: false, reason: 'timeout' });
  });
});
