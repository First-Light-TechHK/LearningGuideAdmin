import {
  SUGGEST_INTENTS,
  suggestTurnProblems,
  type FaqBlock,
  type HelpdeskQaCandidate,
  type HelpdeskQaPopularSearch,
  type HelpdeskQaSearch,
  type HelpdeskQaSource,
} from '../../contracts/helpdesk-qa';
import type { JsonObject } from '../../contracts/helpdesk-trace';
import { MemoryRateLimitStore } from '../rate-limit.service';
import {
  ASSIST_RATE_LIMIT,
  HelpdeskSuggestService,
  SUGGEST_DEADLINE_MS,
  SUGGEST_THINKING_DEADLINE_MS,
} from './helpdesk-suggest.service';
import type {
  HelpdeskSuggestionLog,
  SuggestionLogEntry,
} from './helpdesk-suggestion.store';
import { createMemoryAgentEventLog } from './trace/agent-event.store';
import { exportEvents } from './trace/trace-query';
import type {
  AgentCallExtras,
  AgentStepContext,
  AgentStepOutcome,
  AgentStepSpec,
} from './workflow/engine';
import { PICK_FAQ_V5_SYSTEM } from './workflow/assist-workflow';
import { ANSWER_LINES, ANSWER_TONES, TEMPLATES } from './workflow/guard';
import { LEARNER_STATE_RULE } from './workflow/learner-facts';
import {
  loadPi,
  PiStepRunner,
  type ModelSource,
} from './workflow/pi-step-runner';

/**
 * 聊天面板 v5（helpdesk-v5 Part B 寒暄、Part D clarify、Part H 三段式答案；graph design §4 谁来定）。
 * 请求带 context（v5 的 Portal）→ assist 工作流 + 回包的 SuggestTurnFields；每个回包都用契约的
 * suggestTurnProblems 自检。模型是假的 runner（按工具名回话），从不连真模型。
 */
const LEARNER = 'portal-user-v5';
const id = (n: number) =>
  `0192cccc-0000-7000-8000-${String(n).padStart(12, '0')}`;

const blocksOf = (texts: string[]): FaqBlock[] =>
  texts.map((text, i) => ({ id: `b${i + 1}`, text }));

const PAID_TEXTS = [
  'Payments can take a few minutes to confirm.',
  '1. Reload **My Learning**\n2. Sign out and sign in again',
  '- Check that you are signed in with the email you paid with\n- Look for the receipt email in your spam folder',
  'Still not active? Contact support with the order number from your receipt.',
];
/** 4 块、> 200 字的答案：摘录可选。 */
const PAID: HelpdeskQaCandidate = {
  id: id(1),
  category: 'payments_subscriptions',
  question: 'I paid but my plan is not active',
  answer: PAID_TEXTS.join('\n\n'),
  score: 3,
  type: 'answer',
  entry: true,
  blocks: blocksOf(PAID_TEXTS),
  optionOf: [id(9)],
  relation: 'search',
};
const FAILED: HelpdeskQaCandidate = {
  id: id(2),
  category: 'payments_subscriptions',
  question: 'My payment failed',
  answer: 'Try another card.',
  score: 2,
  type: 'answer',
  entry: true,
  blocks: blocksOf(['Try another card.']),
  optionOf: [id(9)],
  relation: 'search',
};
const RESET: HelpdeskQaCandidate = {
  id: id(3),
  category: 'account_technical',
  question: 'How do I reset my password?',
  answer: 'Use **Forgot password** on the sign-in page.',
  score: 1,
  type: 'answer',
  entry: true,
  blocks: blocksOf(['Use **Forgot password** on the sign-in page.']),
  optionOf: [],
  relation: 'search',
};
const CHOICE: HelpdeskQaCandidate = {
  id: id(9),
  category: 'payments_subscriptions',
  question: 'Having trouble with a payment?',
  answer: 'Which of these is it?',
  score: 0,
  type: 'choice',
  entry: true,
  blocks: [],
  optionOf: [],
  relation: 'search',
};
const POPULAR: HelpdeskQaCandidate = {
  ...RESET,
  id: id(20),
  question: 'How do I contact support?',
  answer: 'Use Contact Support.',
};
const NODES = [PAID, FAILED, RESET, CHOICE, POPULAR];

type Reply = (
  spec: AgentStepSpec,
  context: AgentStepContext,
) => Promise<AgentStepOutcome>;

function called(
  args: Record<string, string>,
  extras: Partial<AgentCallExtras> = {},
): Promise<AgentStepOutcome> {
  return Promise.resolve({
    kind: 'called',
    args,
    extras: { lists: {}, texts: {}, flags: {}, ...extras },
  });
}

/** pick_faq 的回话（intent、faqId、confidence 与 v5 的 extras）。 */
function pick(
  intent: string,
  faqId: string,
  options: {
    confidence?: string;
    blocks?: string[];
    tone?: string;
    reply?: string;
  } = {},
) {
  const texts: Record<string, string> = {};
  if (options.reply !== undefined) texts.reply = options.reply;
  return called(
    {
      intent,
      faqId,
      confidence: options.confidence ?? 'sure',
      ...(options.tone !== undefined ? { tone: options.tone } : {}),
    },
    { lists: options.blocks ? { blocks: options.blocks } : {}, texts },
  );
}

function setup(
  options: {
    found?: HelpdeskQaCandidate[];
    pick?: Reply;
    explain?: Reply;
    env?: NodeJS.ProcessEnv;
    release?: () => Promise<number | null>;
    now?: () => number;
  } = {},
) {
  const findCandidates = jest.fn((search: HelpdeskQaSearch) => {
    void search;
    return Promise.resolve(options.found ?? [PAID, FAILED, RESET]);
  });
  const findPublished = jest.fn((faqId: string, locale: string) => {
    void locale;
    const hit = NODES.find((c) => c.id === faqId);
    return Promise.resolve(hit ? { ...hit, score: 0 } : null);
  });
  const findPopular = jest.fn((search: HelpdeskQaPopularSearch) =>
    Promise.resolve(
      [POPULAR, RESET]
        .filter((c) => !search.excludeIds.includes(c.id))
        .slice(0, search.limit),
    ),
  );
  const releaseVersion = jest.fn(options.release ?? (() => Promise.resolve(3)));
  const qa: HelpdeskQaSource = {
    findCandidates,
    findPublished,
    findPopular,
    releaseVersion,
  };
  const run = jest.fn<
    Promise<AgentStepOutcome>,
    [AgentStepSpec, AgentStepContext]
  >((spec, context) =>
    spec.tool.name === 'explain'
      ? (options.explain ?? (() => called({}, { flags: { covered: false } })))(
          spec,
          context,
        )
      : (
          options.pick ??
          (() =>
            pick('question', PAID.id, {
              blocks: ['b2', 'b3'],
              tone: 'problem',
            }))
        )(spec, context),
  );
  const rows: SuggestionLogEntry[] = [];
  const log: HelpdeskSuggestionLog = {
    record: (entry) => {
      rows.push(entry);
      return Promise.resolve();
    },
    setOutcome: () => Promise.resolve({ kind: 'not_found' }),
    purgeQueryText: () => Promise.resolve(0),
  };
  const events = createMemoryAgentEventLog();
  const service = new HelpdeskSuggestService({
    qa,
    runner: { run },
    rateLimit: new MemoryRateLimitStore(),
    log,
    events,
    env: () =>
      options.env ?? {
        OPENROUTER_API_KEY: 'test-openrouter-key-local-only',
        OPENROUTER_BASE_URL: 'http://llm.test/v1',
        HELPDESK_SUGGEST_MODEL: 'test/cheap-model',
      },
    now: options.now,
  });
  return {
    service,
    qa,
    run,
    rows,
    events,
    findCandidates,
    findPublished,
    findPopular,
    releaseVersion,
  };
}

const chat = (
  message: string,
  context: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => ({
  learnerId: LEARNER,
  locale: 'en-GB',
  source: 'chat',
  message,
  context,
  ...extra,
});

/** 每个 v5 回包都必须合契约（suggestTurnProblems 为空）。 */
async function ask(service: HelpdeskSuggestService, body: unknown) {
  const result = await service.suggest(body);
  expect(suggestTurnProblems(result)).toEqual([]);
  return result;
}

const specOf = (run: ReturnType<typeof setup>['run'], name: string) =>
  run.mock.calls.map(([spec]) => spec).find((s) => s.tool.name === name);

describe('v5 is opt-in: requests without context get exactly the v5 answer', () => {
  it('a chat without context: only suggestion and alternatives, and the legacy pick_faq tool', async () => {
    const { service, run } = setup({
      pick: () => called({ intent: 'question', faqId: PAID.id }),
    });
    const result = await service.suggest({
      learnerId: LEARNER,
      locale: 'en-GB',
      source: 'chat',
      message: 'I paid but my plan is not active',
    });
    expect(Object.keys(result).sort()).toEqual(['alternatives', 'suggestion']);
    const [spec] = run.mock.calls[0];
    expect(Object.keys(spec.tool.enumArgs)).toEqual([
      'intent',
      'faqId',
      'confidence',
    ]);
    expect(spec.tool.textArgs).toBeUndefined();
    expect(spec.tool.listArgs).toBeUndefined();
  });

  it('a ticket submit ignores context (the modal never shows small talk or excerpts)', async () => {
    const { service } = setup({
      pick: () => called({ intent: 'question', faqId: PAID.id }),
    });
    const result = await service.suggest({
      learnerId: LEARNER,
      locale: 'en-GB',
      source: 'submit',
      subject: 'Paid',
      message: 'not active',
      context: { nodeId: PAID.id },
    });
    expect(Object.keys(result).sort()).toEqual(['alternatives', 'suggestion']);
  });
});

describe('v5 answer: opening, excerpt, closing (Part H)', () => {
  it('answers with the fixed lines of the tone the model chose, the excerpt blocks and the release version', async () => {
    const { service, run, findCandidates } = setup();
    const result = await ask(
      service,
      chat('I paid but my plan is not active', {
        sessionId: id(100),
        recentTurns: ['hello'],
      }),
    );
    expect(result).toMatchObject({
      suggestion: {
        faqId: PAID.id,
        question: PAID.question,
        answer: PAID.answer,
      },
      alternatives: [],
      kind: 'answer',
      intent: 'question',
      confidence: 'sure',
      nodeId: PAID.id,
      blocks: ['b2', 'b3'],
      opening: ANSWER_LINES.problem.opening.en,
      closing: ANSWER_LINES.problem.closing.en,
      reply: null,
      explanation: null,
      covered: null,
      guard: { result: 'passed', reason: null, fallback: [] },
      releaseVersion: 3,
    });
    expect(findCandidates).toHaveBeenCalledWith({
      locale: 'en-GB',
      category: null,
      text: 'I paid but my plan is not active',
      limit: 10,
      entryOnly: true,
      types: ['answer', 'choice'],
      deepReserved: 2,
    });
    const spec = specOf(run, 'pick_faq') as AgentStepSpec;
    expect(spec.tool.enumArgs).toEqual({
      intent: SUGGEST_INTENTS,
      faqId: [PAID.id, FAILED.id, RESET.id, 'none'],
      confidence: ['sure', 'unsure'],
      tone: [...ANSWER_TONES, 'none'],
    });
    // 只有 PAID 的答案够长、可以摘录：块 id 来自它
    expect(spec.tool.listArgs).toEqual({ blocks: ['b1', 'b2', 'b3', 'b4'] });
    // 开头结尾不让模型写（只选 tone），模型只写寒暄回复
    expect(Object.keys(spec.tool.textArgs ?? {})).toEqual(['reply']);
    const prompt = JSON.parse(spec.prompt) as Record<string, unknown> & {
      candidates: Record<string, unknown>[];
    };
    // 没有学员状态（v7）时模型只收到学员的话、屏幕上的卡片与候选
    expect(Object.keys(prompt).sort()).toEqual([
      'candidates',
      'message',
      'recentTurns',
      'shown',
    ]);
    expect(prompt.recentTurns).toEqual(['hello']);
    expect(prompt.candidates[0]).toEqual({
      id: PAID.id,
      type: 'answer',
      category: PAID.category,
      question: PAID.question,
      blocks: PAID.blocks,
    });
    expect(prompt.candidates[1]).toMatchObject({ answer: FAILED.answer });
    expect(prompt.candidates[1].blocks).toBeUndefined();
  });

  it.each([['none'], ['unknown'], [undefined]])(
    'uses the default lines when the tone is %s, and says so',
    async (tone) => {
      const { service } = setup({
        pick: () => pick('question', PAID.id, { tone }),
      });
      const result = await ask(service, chat('paid not active'));
      expect(result).toMatchObject({
        opening: TEMPLATES.opening.en,
        closing: TEMPLATES.closing.en,
        guard: {
          result: 'fallback',
          reason: 'missing',
          fallback: ['opening', 'closing'],
        },
      });
    },
  );

  it("writes the chosen tone's lines in the learner's script (zh-CN / zh-TW)", async () => {
    const { service } = setup({
      pick: () => pick('question', PAID.id, { tone: 'explain' }),
    });
    expect(
      await ask(service, { ...chat('我付了钱但是没开通'), locale: 'zh-CN' }),
    ).toMatchObject({
      opening: ANSWER_LINES.explain.opening['zh-CN'],
      closing: ANSWER_LINES.explain.closing['zh-CN'],
    });
    expect(
      await ask(service, { ...chat('我付了錢但是沒開通'), locale: 'zh-CN' }),
    ).toMatchObject({
      opening: ANSWER_LINES.explain.opening['zh-TW'],
      closing: ANSWER_LINES.explain.closing['zh-TW'],
    });
  });

  it("writes the templates in the learner's script (zh-CN / zh-TW)", async () => {
    const { service } = setup({ pick: () => pick('question', PAID.id) });
    expect(
      await ask(service, { ...chat('我付了钱但是没开通'), locale: 'zh-CN' }),
    ).toMatchObject({
      opening: TEMPLATES.opening['zh-CN'],
      closing: TEMPLATES.closing['zh-CN'],
    });
    expect(
      await ask(service, { ...chat('我付了錢但是沒開通'), locale: 'zh-CN' }),
    ).toMatchObject({
      opening: TEMPLATES.opening['zh-TW'],
      closing: TEMPLATES.closing['zh-TW'],
    });
  });

  it.each([
    ['not contiguous', ['b1', 'b3']],
    ['more than three', ['b1', 'b2', 'b3', 'b4']],
    ['unknown', ['b7']],
    ['empty', []],
  ])('shows the whole answer when the blocks are %s', async (_name, blocks) => {
    const { service } = setup({
      pick: () => pick('question', PAID.id, { blocks }),
    });
    expect((await ask(service, chat('paid'))).blocks).toEqual([]);
  });

  it('shows the whole answer of a short FAQ whatever blocks the model names', async () => {
    const { service } = setup({
      pick: () => pick('question', FAILED.id, { blocks: ['b1'] }),
    });
    expect(await ask(service, chat('payment failed'))).toMatchObject({
      kind: 'answer',
      nodeId: FAILED.id,
      blocks: [],
    });
  });

  it('never answers with an id outside the candidates', async () => {
    const { service } = setup({ pick: () => pick('question', id(77)) });
    expect(await ask(service, chat('paid'))).toMatchObject({
      kind: 'no_match',
      suggestion: null,
    });
  });
});

describe('v5 choice cards: unsure → the learner picks (graph design §4)', () => {
  it('shows the choice card a sure-less pick is an option of, with no opening or closing', async () => {
    const { service, findPublished } = setup({
      pick: () =>
        pick('question', PAID.id, {
          confidence: 'unsure',
          tone: 'steps',
        }),
    });
    const result = await ask(service, chat('payment problem'));
    expect(result).toMatchObject({
      suggestion: {
        faqId: CHOICE.id,
        question: CHOICE.question,
        answer: CHOICE.answer,
      },
      kind: 'answer',
      confidence: 'unsure',
      nodeId: CHOICE.id,
      blocks: [],
      opening: null,
      closing: null,
      guard: null,
    });
    expect(findPublished).toHaveBeenCalledWith(CHOICE.id, 'en-GB');
  });

  it('shows the choice card when the model picks none but the top candidates are its options', async () => {
    const { service } = setup({
      pick: () => pick('question', 'none', { confidence: 'unsure' }),
    });
    expect(await ask(service, chat('payment'))).toMatchObject({
      kind: 'answer',
      nodeId: CHOICE.id,
    });
  });

  it('answers a sure pick even when it is an option of a choice card', async () => {
    const { service } = setup({ pick: () => pick('question', FAILED.id) });
    expect(await ask(service, chat('my card was declined'))).toMatchObject({
      nodeId: FAILED.id,
      opening: TEMPLATES.opening.en,
    });
  });

  it('does not show an unsure pick that belongs to no choice card: no_match, with that pick first among the alternatives', async () => {
    // real-model eval 2026-10-30 (blind labels): DeepSeek's unsure cards outside a choice card were wrong 42 of 52
    // times (Gemini 7 of 9); the learner still sees the pick, as the first "you might want to ask"
    const { service } = setup({
      pick: () => pick('question', RESET.id, { confidence: 'unsure' }),
    });
    const result = await ask(service, chat('password?'));
    expect(result).toMatchObject({
      suggestion: null,
      kind: 'no_match',
      nodeId: null,
      confidence: 'unsure',
    });
    expect(result.alternatives.map((a) => a.faqId)).toEqual([
      RESET.id,
      PAID.id,
      FAILED.id,
    ]);
  });

  it('shows a choice card the model picked itself', async () => {
    const { service } = setup({
      found: [CHOICE, PAID],
      pick: () => pick('question', CHOICE.id),
    });
    expect(await ask(service, chat('payment'))).toMatchObject({
      nodeId: CHOICE.id,
      opening: null,
      guard: null,
    });
  });

  it('a vague opener on a topic with a choice card shows that card (no reply)', async () => {
    const { service } = setup({
      pick: () => pick('vague', 'none', { reply: 'Sure, tell me more.' }),
    });
    expect(await ask(service, chat('payment issue'))).toMatchObject({
      kind: 'answer',
      intent: 'vague',
      nodeId: CHOICE.id,
      reply: null,
    });
  });

  it('never re-shows the choice card that is already on screen', async () => {
    const { service } = setup({
      pick: () => pick('question', 'none', { confidence: 'unsure' }),
    });
    expect(
      await ask(service, chat('payment', { nodeId: CHOICE.id })),
    ).toMatchObject({ kind: 'no_match' });
  });
});

describe('v5 small talk (Part B)', () => {
  it('asks the model even with no candidates, and shows its guard-passed reply with no alternatives', async () => {
    const { service, run, findPopular } = setup({
      found: [],
      pick: () => pick('greeting', 'none', { reply: '你好！遇到什么问题了？' }),
    });
    const result = await ask(service, { ...chat('你好'), locale: 'zh-CN' });
    expect(result).toEqual({
      suggestion: null,
      alternatives: [],
      kind: 'smalltalk',
      intent: 'greeting',
      confidence: null,
      nodeId: null,
      blocks: [],
      opening: null,
      closing: null,
      reply: '你好！遇到什么问题了？',
      explanation: null,
      covered: null,
      guard: { result: 'passed', reason: null, fallback: [] },
      releaseVersion: 3,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(findPopular).not.toHaveBeenCalled();
  });

  it.each([
    [
      'greeting',
      '你好',
      'zh-CN',
      '你好！我们的会员只要30元。',
      'digit',
      TEMPLATES.reply.greeting['zh-CN'],
    ],
    [
      'farewell',
      '謝謝',
      'zh-CN',
      undefined,
      'missing',
      TEMPLATES.reply.farewell['zh-TW'],
    ],
    [
      'off_topic',
      "what's the weather like?",
      'en-GB',
      'Sunny! Visit weather.com',
      'link',
      TEMPLATES.reply.off_topic.en,
    ],
    [
      'vague',
      'I have a problem',
      'en-GB',
      "Sorry, I couldn't find that.",
      'blocked_phrase',
      TEMPLATES.reply.greeting.en,
    ],
    [
      'greeting',
      'hello',
      'en-GB',
      '你好！',
      'script',
      TEMPLATES.reply.greeting.en,
    ],
  ])(
    '%s %j: a reply failing the guard falls back to the template',
    async (intent, message, locale, reply, reason, template) => {
      const { service } = setup({
        found: [],
        pick: () => pick(intent, 'none', reply === undefined ? {} : { reply }),
      });
      const result = await ask(service, { ...chat(message), locale });
      expect(result).toMatchObject({
        kind: 'smalltalk',
        intent,
        reply: template,
        guard: { result: 'fallback', reason, fallback: ['reply'] },
      });
    },
  );

  it.each(['someone_else', 'exception', 'private_data', 'instructions'])(
    '%s stays no_match with alternatives (never a reply)',
    async (intent) => {
      const { service } = setup({
        pick: () => pick(intent, 'none', { reply: 'Sure, I can do that.' }),
      });
      const result = await ask(service, chat('give me a free month'));
      expect(result).toMatchObject({
        kind: 'no_match',
        intent,
        reply: null,
        guard: null,
      });
      expect(result.alternatives.length).toBeGreaterThan(0);
    },
  );
});

describe('v5 clarify: explaining the card on screen (Part D)', () => {
  const shown = {
    nodeId: PAID.id,
    recentTurns: ['I paid but my plan is not active'],
  };

  it('asks explain with the shown answer only, and shows a grounded explanation', async () => {
    const explanation =
      'Only for a few minutes. If it is still not active, reload **My Learning**, then sign out and back in.';
    const { service, run, findPublished, findCandidates } = setup({
      found: [FAILED, RESET],
      pick: () => pick('clarify', PAID.id),
      explain: () =>
        called({}, { texts: { explanation }, flags: { covered: true } }),
    });
    const result = await ask(
      service,
      chat('So do I just have to wait?', shown),
    );
    expect(result).toEqual({
      suggestion: null,
      alternatives: [],
      kind: 'clarify',
      intent: 'clarify',
      confidence: 'sure',
      nodeId: PAID.id,
      blocks: [],
      opening: null,
      closing: null,
      reply: null,
      explanation: explanation.replace(/\*\*/g, ''),
      covered: true,
      guard: { result: 'passed', reason: null, fallback: [] },
      releaseVersion: 3,
    });
    expect(findPublished).toHaveBeenCalledWith(PAID.id, 'en-GB');
    expect(findCandidates.mock.calls[0][0]).toMatchObject({ nodeId: PAID.id });
    // 屏幕上的卡片永远可选，也排在最前
    expect(
      (specOf(run, 'pick_faq') as AgentStepSpec).tool.enumArgs.faqId,
    ).toEqual([PAID.id, FAILED.id, RESET.id, 'none']);
    const explain = specOf(run, 'explain') as AgentStepSpec;
    expect(explain.tool).toMatchObject({
      name: 'explain',
      enumArgs: {},
      textArgs: { explanation: expect.any(String) as string },
      flagArgs: { covered: expect.any(String) as string },
    });
    expect(JSON.parse(explain.prompt)).toEqual({
      card: { question: PAID.question, answer: PAID.answer },
      followUp: 'So do I just have to wait?',
      recentTurns: shown.recentTurns,
    });
    expect(explain.system).not.toContain('wait');
  });

  it.each([
    [
      'the model says the answer does not cover it',
      () => called({}, { flags: { covered: false } }),
      'not_covered',
    ],
    [
      'the explanation adds a number',
      () =>
        called(
          {},
          {
            texts: { explanation: 'It takes 30 minutes.' },
            flags: { covered: true },
          },
        ),
      'ungrounded',
    ],
    [
      'the explanation sounds like an AI',
      () =>
        called(
          {},
          {
            texts: { explanation: 'Great question! Just wait a few minutes.' },
            flags: { covered: true },
          },
        ),
      'ai_filler',
    ],
    [
      'covered without an explanation',
      () => called({}, { flags: { covered: true } }),
      'missing',
    ],
    [
      'no valid call',
      () => Promise.resolve({ kind: 'no_call' } as const),
      'missing',
    ],
    [
      'the step fails',
      () => Promise.resolve({ kind: 'error', message: 'boom' } as const),
      'error',
    ],
  ])(
    'shows no explanation (covered false) when %s',
    async (_name, explain, reason) => {
      const { service } = setup({
        pick: () => pick('clarify', PAID.id),
        explain,
      });
      const result = await ask(
        service,
        chat('what if I paid by PayPal?', shown),
      );
      expect(result).toMatchObject({
        kind: 'clarify',
        nodeId: PAID.id,
        explanation: null,
        covered: false,
        guard: { result: 'fallback', reason, fallback: ['explanation'] },
        alternatives: [],
      });
    },
  );

  it('names each step it starts for the thinking panel: pick_faq is pick, and nothing else is said', async () => {
    const { service } = setup({
      found: [FAILED, RESET],
      pick: () => pick('clarify', PAID.id),
      explain: () =>
        called(
          {},
          {
            texts: { explanation: 'Only for a few minutes.' },
            flags: { covered: true },
          },
        ),
    });
    const steps: string[] = [];
    await service.suggest(chat('So do I just have to wait?', shown), {
      onStep: (step) => steps.push(step),
    });
    expect(steps).toEqual(['retrieve', 'pick', 'explain', 'ground']);
  });

  it('treats a pick of the shown card as a question about it', async () => {
    const { service, run } = setup({ pick: () => pick('question', PAID.id) });
    expect(await ask(service, chat('again?', shown))).toMatchObject({
      kind: 'clarify',
      intent: 'question',
      nodeId: PAID.id,
    });
    expect(specOf(run, 'explain')).toBeDefined();
  });

  it('answers a child card picked while a card is on screen (a new question inside the tree)', async () => {
    const { service } = setup({
      found: [{ ...FAILED, relation: 'child' }],
      pick: () => pick('question', FAILED.id),
    });
    expect(
      await ask(service, chat('and if my card is declined?', shown)),
    ).toMatchObject({ kind: 'answer', nodeId: FAILED.id });
  });

  it("tells the model which candidates are the shown card's follow-ups, and to prefer one over clarify", async () => {
    // real-model eval 2026-10-30: 「宽限期是啥」 on the payment-failed card went to clarify (not covered) while its
    // follow-up 「What is the grace period?」 was a candidate; the model could not tell follow-ups apart
    const { service, run } = setup({
      found: [
        { ...FAILED, relation: 'child' },
        { ...RESET, relation: 'sibling' },
      ],
      pick: () => pick('question', FAILED.id),
    });
    await ask(service, chat('and if my card is declined?', shown));
    const spec = specOf(run, 'pick_faq') as AgentStepSpec;
    const prompt = JSON.parse(spec.prompt) as {
      candidates: { id: string; followUp?: boolean }[];
    };
    expect(prompt.candidates.map((c) => [c.id, c.followUp ?? false])).toEqual([
      [FAILED.id, true],
      [RESET.id, false],
    ]);
    expect(spec.system).toContain(
      'When a candidate marked followUp answers what they ask about the shown card, pick it (intent question); use clarify only when no candidate answers it.',
    );
  });

  it('without a card on screen, clarify is handled like a question', async () => {
    const { service, run } = setup({ pick: () => pick('clarify', PAID.id) });
    expect(await ask(service, chat('what does that mean?'))).toMatchObject({
      kind: 'answer',
      nodeId: PAID.id,
    });
    expect(specOf(run, 'explain')).toBeUndefined();
  });

  it('a card that is no longer published is not explained', async () => {
    const { service, run } = setup({ pick: () => pick('clarify', 'none') });
    expect(
      await ask(service, chat('what does that mean?', { nodeId: id(404) })),
    ).toMatchObject({ kind: 'no_match' });
    expect(specOf(run, 'explain')).toBeUndefined();
  });
});

describe('v5 without a model call', () => {
  it('no API key: no_match with no intent, and the release version', async () => {
    const { service, run } = setup({ env: {} });
    const result = await ask(service, chat('hello'));
    expect(result).toMatchObject({
      kind: 'no_match',
      intent: null,
      confidence: null,
      guard: null,
      releaseVersion: 3,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('rate limited: no_match with no alternatives', async () => {
    const { service } = setup();
    for (let i = 0; i < ASSIST_RATE_LIMIT.limit; i++)
      await service.suggest(chat('hello'));
    expect(await ask(service, chat('hello'))).toMatchObject({
      kind: 'no_match',
      alternatives: [],
    });
  });

  it('a chip answers with the fixed templates, never asking the model', async () => {
    const { service, run } = setup();
    const result = await ask(service, {
      learnerId: LEARNER,
      locale: 'zh-CN',
      source: 'chip',
      faqId: PAID.id,
      context: {},
    });
    expect(result).toMatchObject({
      kind: 'answer',
      intent: null,
      confidence: null,
      nodeId: PAID.id,
      blocks: [],
      opening: TEMPLATES.opening['zh-CN'],
      closing: TEMPLATES.closing['zh-CN'],
      guard: {
        result: 'fallback',
        reason: 'missing',
        fallback: ['opening', 'closing'],
      },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('a chip on a choice card shows it bare', async () => {
    const { service } = setup();
    expect(
      await ask(service, {
        learnerId: LEARNER,
        locale: 'en-GB',
        source: 'chip',
        faqId: CHOICE.id,
        context: {},
      }),
    ).toMatchObject({
      kind: 'answer',
      nodeId: CHOICE.id,
      opening: null,
      guard: null,
    });
  });

  it('a late answer is dropped (no_match), like v5', async () => {
    let now = 1_000;
    const { service } = setup({
      now: () => now,
      pick: () => {
        now += SUGGEST_THINKING_DEADLINE_MS + 1;
        return pick('greeting', 'none', { reply: 'Hi!' });
      },
    });
    expect(await ask(service, chat('hi'))).toMatchObject({
      kind: 'no_match',
      reply: null,
    });
  });

  it('thinks high by default and waits up to 15 s for it; with thinking off the 3.5 s deadline holds', async () => {
    // 用户 2026-10-30：DeepSeek 开 thinking（Portal 放「思考中」动画）。盲评 high 档 p95 6.3 s、p99 12.6 s
    for (const [thinking, took, kind] of [
      [undefined, 12_000, 'answer'],
      [undefined, SUGGEST_THINKING_DEADLINE_MS + 1, 'no_match'],
      ['low', 12_000, 'answer'],
      ['off', 3_000, 'answer'],
      ['off', SUGGEST_DEADLINE_MS + 1, 'no_match'],
    ] as const) {
      let now = 1_000;
      const { service, run } = setup({
        env: {
          OPENROUTER_API_KEY: 'test-openrouter-key-local-only',
          HELPDESK_SUGGEST_MODEL: 'test/cheap-model',
          ...(thinking ? { HELPDESK_SUGGEST_THINKING: thinking } : {}),
        },
        now: () => now,
        pick: () => {
          now += took;
          return pick('question', PAID.id, { tone: 'problem' });
        },
      });
      const result = await ask(service, chat('paid'));
      expect([thinking, took, result.kind]).toEqual([thinking, took, kind]);
      expect(run.mock.calls[0][1].model.thinking).toBe(thinking ?? 'high');
    }
  });

  it('reports releaseVersion null before the first release, and when it cannot be read', async () => {
    for (const release of [
      () => Promise.resolve(null),
      () => Promise.reject(new Error('db down')),
    ]) {
      const { service } = setup({ release });
      expect((await ask(service, chat('paid'))).releaseVersion).toBeNull();
    }
  });

  it('leaves the shown card out of the alternatives', async () => {
    const { service } = setup({
      found: [],
      pick: () => pick('question', 'none'),
    });
    const result = await ask(service, chat('xyz', { nodeId: POPULAR.id }));
    expect(result.alternatives.map((a) => a.faqId)).toEqual([RESET.id]);
  });
});

describe('v5 logging: codes and enums only, model text only in the learner-text field', () => {
  it('records the turn in helpdesk_suggestions', async () => {
    const { service, rows } = setup({
      pick: () => pick('question', PAID.id, { blocks: ['b2'] }),
    });
    await service.suggest(
      chat('paid', { sessionId: id(100), nodeId: RESET.id }),
    );
    expect(rows[0]).toMatchObject({
      faqId: PAID.id,
      turn: {
        kind: 'answer',
        intent: 'question',
        confidence: 'sure',
        nodeId: PAID.id,
        blocks: ['b2'],
        guard: {
          result: 'fallback',
          reason: 'missing',
          fallback: ['opening', 'closing'],
        },
        covered: null,
        sessionId: id(100),
        releaseVersion: 3,
      },
    });
  });

  it('records clarify with the shown node and no faq_id', async () => {
    const { service, rows } = setup({ pick: () => pick('clarify', PAID.id) });
    await service.suggest(chat('what if?', { nodeId: PAID.id }));
    expect(rows[0]).toMatchObject({
      faqId: null,
      turn: { kind: 'clarify', nodeId: PAID.id, covered: false },
    });
  });

  it('puts kind, intent, guard and blocks on turn/end, and the shown texts only in its output (redacted on export)', async () => {
    const reply = 'Hi Lena! What can I help you with?';
    const { service, events } = setup({
      found: [],
      pick: () => pick('greeting', 'none', { reply }),
    });
    const runId = id(500);
    await service.suggest({
      ...chat('hi, I am Lena', { recentTurns: ['earlier words'] }),
      runId,
    });
    await service.flushTraces();
    const log = await events.read(runId);
    const end = log.find((e) => e.type === 'turn/end')?.data as JsonObject;
    expect(end).toMatchObject({
      reason: 'answered',
      kind: 'smalltalk',
      intent: 'greeting',
      confidence: null,
      nodeId: null,
      blocks: [],
      guard: { result: 'passed', reason: null, fallback: [] },
      releaseVersion: 3,
      output: { reply, opening: null, closing: null, explanation: null },
    });
    const start = log.find((e) => e.type === 'turn/start')?.data as JsonObject;
    expect(start.input).toEqual({
      subject: '',
      message: 'hi, I am Lena',
      recentTurns: ['earlier words'],
    });
    expect(start.context).toEqual({
      nodeId: null,
      sessionId: null,
      recentTurns: 1,
    });
    // 模型写的文字只在 turn/end.output：工具调用只记长度
    const others = log.filter(
      (e) => e.type !== 'turn/end' && e.type !== 'turn/start',
    );
    expect(JSON.stringify(others)).not.toContain('Lena');
    const exported = JSON.stringify(exportEvents(runId, log));
    expect(exported).not.toContain('Lena');
    expect(exported).not.toContain('earlier words');
  });
});

/** 真的 pi-agent-core（原样）+ pi 自带的 faux provider：v5 的工具参数（块、短句、真 / 假）一路走通。 */
describe('v5 through the real pi runner (faux provider)', () => {
  async function fauxService(
    responses: (pi: Awaited<ReturnType<typeof loadPi>>) => unknown[],
  ) {
    const pi = await loadPi();
    const handle = pi.ai.fauxProvider({});
    const models = pi.ai.createModels();
    models.setProvider(handle.provider);
    handle.setResponses(
      responses(pi) as Parameters<typeof handle.setResponses>[0],
    );
    const source: ModelSource = () => ({ models, model: handle.getModel() });
    // 同一套假检索，只把 runner 换成真的 PiStepRunner
    const { qa } = setup();
    return {
      handle,
      service: new HelpdeskSuggestService({
        qa,
        runner: new PiStepRunner({ source }),
        rateLimit: new MemoryRateLimitStore(),
        log: {
          record: () => Promise.resolve(),
          setOutcome: () => Promise.resolve({ kind: 'not_found' }),
          purgeQueryText: () => Promise.resolve(0),
        },
        events: createMemoryAgentEventLog(),
        env: () => ({
          OPENROUTER_API_KEY: 'test-openrouter-key-local-only',
          HELPDESK_SUGGEST_MODEL: 'test/cheap-model',
        }),
      }),
    };
  }

  it('answers with the blocks the model chose and the fixed lines of its tone', async () => {
    const { service, handle } = await fauxService((pi) => [
      pi.ai.fauxAssistantMessage(
        [
          pi.ai.fauxToolCall('pick_faq', {
            intent: 'question',
            faqId: PAID.id,
            confidence: 'sure',
            blocks: ['b2', 'b3'],
            tone: 'problem',
          }),
        ],
        { stopReason: 'toolUse' },
      ),
    ]);
    expect(await ask(service, chat('paid but not active'))).toMatchObject({
      kind: 'answer',
      nodeId: PAID.id,
      blocks: ['b2', 'b3'],
      opening: ANSWER_LINES.problem.opening.en,
      closing: ANSWER_LINES.problem.closing.en,
      guard: { result: 'passed' },
    });
    expect(handle.state.callCount).toBe(1);
  });

  it('runs the explain step as a second request and shows the grounded explanation', async () => {
    const { service, handle } = await fauxService((pi) => [
      pi.ai.fauxAssistantMessage(
        [
          pi.ai.fauxToolCall('pick_faq', {
            intent: 'clarify',
            faqId: PAID.id,
            confidence: 'sure',
            tone: 'none',
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      pi.ai.fauxAssistantMessage(
        [
          pi.ai.fauxToolCall('explain', {
            explanation: 'Only a few minutes. Then reload My Learning.',
            covered: true,
          }),
        ],
        { stopReason: 'toolUse' },
      ),
    ]);
    expect(
      await ask(service, chat('how long do I wait?', { nodeId: PAID.id })),
    ).toMatchObject({
      kind: 'clarify',
      covered: true,
      explanation: 'Only a few minutes. Then reload My Learning.',
    });
    expect(handle.state.callCount).toBe(2);
  });
});

describe('v7 learner state (Portal → Agent)', () => {
  const STATE = {
    accountAgeDays: 30,
    emailVerified: false,
    plans: [
      {
        source: 'trial',
        state: 'active',
        scope: 'course',
        device: 'pc',
        endsInDays: 2,
      },
      {
        source: 'purchase',
        state: 'expired',
        scope: 'everything',
        device: null,
        endsInDays: -10,
      },
    ],
    courses: [
      {
        courseId: 'course_1',
        title: 'Physics',
        status: 'in_progress',
        progress: 40,
        minutes: 30,
        lastStudiedDaysAgo: 1,
        hasAccess: true,
      },
      {
        courseId: 'course_2',
        title: 'Chemistry',
        status: 'not_started',
        progress: 0,
        minutes: 0,
        lastStudiedDaysAgo: null,
        hasAccess: false,
      },
    ],
    notStartedWithAccess: 3,
    studyGroups: {
      groups: 2,
      hosting: 1,
      upcomingSessions: 1,
      nextSessionInHours: 26,
    },
    latestOrder: { status: 'failed', daysAgo: 1 },
    tickets: { open: 2, waitingOnUser: 1 },
  };

  it('gives the model the learner state as short facts written by code, with the rule for it, only when Portal sent one', async () => {
    const { service, run } = setup();
    await ask(
      service,
      chat('is my trial still on?', {
        sessionId: id(100),
        learnerState: STATE,
      }),
    );
    const spec = specOf(run, 'pick_faq') as AgentStepSpec;
    const prompt = JSON.parse(spec.prompt) as { user?: string[] };
    expect(prompt.user).toEqual([
      'account registered 30 days ago',
      'email not verified',
      'free trial (one course, on a computer): active, ends in 2 days',
      'paid plan (all courses): ended 9 days ago',
      'course "Physics": in progress, 40% done, 30 minutes studied, last studied 1 day ago',
      'course "Chemistry": not started, no access now',
      '3 courses they can open and have not started',
      'in 2 study groups (hosts 1); next live session in 26 hours',
      'latest order: failed, 1 day ago',
      '2 open enquiries, 1 waiting for their reply',
    ]);
    expect(spec.system).toBe(`${PICK_FAQ_V5_SYSTEM}\n${LEARNER_STATE_RULE}`);

    // without a state the prompt and the rules stay exactly as before (the benchmarks hold)
    const plain = setup();
    await ask(
      plain.service,
      chat('is my trial still on?', { sessionId: id(100) }),
    );
    const before = specOf(plain.run, 'pick_faq') as AgentStepSpec;
    expect(before.system).toBe(PICK_FAQ_V5_SYSTEM);
    expect(JSON.parse(before.prompt)).not.toHaveProperty('user');
  });

  it('says so when there was never a plan, nothing was studied and the account is brand new', async () => {
    const { service, run } = setup();
    await ask(
      service,
      chat('how do I start?', {
        learnerState: {
          ...STATE,
          accountAgeDays: 0,
          emailVerified: null,
          plans: [],
          courses: [],
          notStartedWithAccess: 0,
          studyGroups: {
            groups: 0,
            hosting: 0,
            upcomingSessions: 0,
            nextSessionInHours: null,
          },
          latestOrder: null,
          tickets: { open: 0, waitingOnUser: 0 },
        },
      }),
    );
    const prompt = JSON.parse(
      (specOf(run, 'pick_faq') as AgentStepSpec).prompt,
    ) as { user?: string[] };
    expect(prompt.user).toEqual([
      'account registered today',
      'no email on the account',
      'never had a plan or a free trial',
      'has not studied any course yet',
    ]);
  });

  it.each([
    ['a number out of range', { ...STATE, accountAgeDays: -1 }],
    [
      'an unknown plan state',
      { ...STATE, plans: [{ ...STATE.plans[0], state: 'paused' }] },
    ],
    [
      'too many courses',
      { ...STATE, courses: Array(11).fill(STATE.courses[0]) },
    ],
    [
      'a date',
      { ...STATE, latestOrder: { status: 'paid', daysAgo: '2026-10-29' } },
    ],
    ['a missing part', { ...STATE, tickets: undefined }],
  ])(
    'treats a learner state with %s as none, never as a bad request',
    async (_name, learnerState) => {
      const { service, run } = setup();
      await ask(service, chat('is my trial still on?', { learnerState }));
      const spec = specOf(run, 'pick_faq') as AgentStepSpec;
      expect(spec.system).toBe(PICK_FAQ_V5_SYSTEM);
      expect(JSON.parse(spec.prompt)).not.toHaveProperty('user');
    },
  );
});
