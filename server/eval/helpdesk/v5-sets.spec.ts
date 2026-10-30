import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentStepOutcome,
  AgentStepRunner,
  AgentStepSpec,
} from '../../src/ai/helpdesk/workflow/engine';
import {
  loadConversations,
  runConversations,
  summarizeConversations,
} from './conversations';
import { loadFaqs, memoryQaSource } from './harness';
import { entryAncestorsOf, fromGeneratorFormat } from './v5-sets';

/**
 * 生成器写的 v5 评测集（按 FAQ key 标注）换成评测格式；追问的入口卡片算对但单独数；对话并发跑。
 */
const FAQ = (n: number) =>
  `0192f0e0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const faqs = loadFaqs(join(__dirname, 'faqs.json'));
const ENV = {
  OPENROUTER_API_KEY: 'fake-key-local-only',
  OPENROUTER_BASE_URL: 'http://fake-model.invalid/api/v1',
  HELPDESK_SUGGEST_MODEL: 'fake/top-candidate',
};

const library = {
  idOfKey: new Map([
    ['refund', FAQ(13)],
    ['refund--after-lessons', FAQ(12)],
    ['refund--after-lessons--deep', FAQ(11)],
  ]),
  entryAncestors: entryAncestorsOf(
    [
      { id: FAQ(13), entry: true },
      { id: FAQ(12), entry: false },
      { id: FAQ(11), entry: false },
    ],
    [
      { parentId: FAQ(13), childId: FAQ(12) },
      { parentId: FAQ(12), childId: FAQ(11) },
    ],
  ),
};

describe('generator-format v5 sets', () => {
  it('maps keys to ids, long to multi_turn, mixed to zh-CN + mixed, thanks / bye to farewell', () => {
    const c = fromGeneratorFormat(
      {
        id: 'long-1-001',
        set: 'long',
        locale: 'mixed',
        persona: 'student',
        signals: ['trial_ending'],
        turns: [
          { learner: 'refund?', expect: { kind: 'answer', faq: 'refund' } },
          {
            learner: '什么意思',
            expect: {
              kind: 'clarify',
              faq: 'refund',
              covered: true,
              point: '…',
            },
          },
          {
            learner: 'after lessons?',
            expect: { kind: 'answer', faq: 'refund--after-lessons--deep' },
          },
          {
            learner: 'or this?',
            expect: {
              kind: 'answer',
              faq: 'refund',
              acceptable: ['refund--after-lessons'],
            },
          },
          { learner: 'thx', expect: { kind: 'smalltalk', intent: 'thanks' } },
          { learner: 'bye', expect: { kind: 'smalltalk', intent: 'bye' } },
          {
            learner: '还是不行',
            expect: { kind: 'handover', why: 'two_unsolved', also: {} },
          },
          { learner: '天气', expect: { kind: 'no_match' } },
        ],
      },
      library,
    );
    expect(c).toEqual({
      id: 'long-1-001',
      set: 'multi_turn',
      locale: 'zh-CN',
      language: 'mixed',
      persona: 'student',
      turns: [
        { message: 'refund?', expect: { kind: 'answer', faqId: FAQ(13) } },
        {
          message: '什么意思',
          expect: { kind: 'clarify', faqId: FAQ(13), covered: true },
        },
        {
          message: 'after lessons?',
          // a depth-2 follow-up: its entry card is the way in
          expect: { kind: 'answer', faqId: FAQ(11), entryIds: [FAQ(13)] },
        },
        {
          message: 'or this?',
          expect: {
            kind: 'answer',
            faqId: FAQ(13),
            acceptableFaqIds: [FAQ(12)],
            entryIds: [FAQ(13)],
          },
        },
        { message: 'thx', expect: { kind: 'smalltalk', intent: 'farewell' } },
        { message: 'bye', expect: { kind: 'smalltalk', intent: 'farewell' } },
        { message: '还是不行', expect: { kind: 'handover' } },
        { message: '天气', expect: { kind: 'no_match' } },
      ],
    });
  });

  it('refuses an unknown key, an unknown intent, and keys without a released library', () => {
    const one = (expect: Record<string, unknown>) => ({
      id: 'x',
      set: 'casual',
      locale: 'en-GB',
      persona: 'p',
      turns: [{ learner: 'hi', expect }],
    });
    expect(() =>
      fromGeneratorFormat(one({ kind: 'answer', faq: 'nope' }), library),
    ).toThrow('x: unknown FAQ key nope');
    expect(() =>
      fromGeneratorFormat(one({ kind: 'smalltalk', intent: 'cry' }), library),
    ).toThrow('unknown small-talk intent cry');
    const dir = mkdtempSync(join(tmpdir(), 'hd-v5-sets-'));
    try {
      const file = join(dir, 'casual.jsonl');
      writeFileSync(
        file,
        `${JSON.stringify(one({ kind: 'answer', faq: 'refund' }))}\n`,
      );
      expect(() => loadConversations(file)).toThrow(
        'FAQ keys need a released library (--pg <url> --release)',
      );
      expect(loadConversations(file, library)[0].turns[0]).toEqual({
        message: 'hi',
        expect: { kind: 'answer', faqId: FAQ(13) },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds the nearest entry on every path up, through shared nodes and cycles', () => {
    const map = entryAncestorsOf(
      [
        { id: 'a', entry: true },
        { id: 'b', entry: true },
        { id: 'x', entry: false },
        { id: 'y', entry: false },
      ],
      [
        { parentId: 'a', childId: 'x' },
        { parentId: 'x', childId: 'y' },
        { parentId: 'b', childId: 'y' },
        { parentId: 'y', childId: 'x' },
      ],
    );
    expect(map.get('x')?.sort()).toEqual(['a', 'b']);
    expect(map.get('y')?.sort()).toEqual(['a', 'b']);
    expect(map.has('a')).toBe(false);
  });
});

/** 每条消息都选 FAQ 13（入口卡片）；记下同时在跑的最大条数。 */
function entryRunner(): { runner: AgentStepRunner; maxInFlight: () => number } {
  let now = 0;
  let max = 0;
  const runner: AgentStepRunner = {
    async run(spec: AgentStepSpec): Promise<AgentStepOutcome> {
      now += 1;
      max = Math.max(max, now);
      await new Promise((resolve) => setTimeout(resolve, 5));
      now -= 1;
      const ids = (
        (JSON.parse(spec.prompt) as { candidates?: { id: string }[] })
          .candidates ?? []
      ).map((c) => c.id);
      return {
        kind: 'called',
        args: {
          intent: 'question',
          faqId: ids.includes(FAQ(13)) ? FAQ(13) : 'none',
          confidence: 'sure',
        },
        extras: { lists: {}, texts: {}, flags: {} },
      };
    },
  };
  return { runner, maxInFlight: () => max };
}

describe('scoring follow-ups and running in parallel', () => {
  it('an entry card that leads to the expected follow-up is right, counted apart, never a wrong FAQ', async () => {
    const { runner, maxInFlight } = entryRunner();
    const conversations = [1, 2, 3, 4].map((n) => ({
      id: `c${n}`,
      set: 'multi_turn' as const,
      locale: 'en-GB' as const,
      persona: 'student',
      turns: [
        {
          message: 'refund after two lessons',
          expect: {
            kind: 'answer' as const,
            faqId: FAQ(12),
            ...(n % 2 ? { entryIds: [FAQ(13)] } : {}),
          },
        },
      ],
    }));
    const outcome = await runConversations({
      conversations,
      qa: memoryQaSource(faqs),
      runner,
      env: ENV,
      budgetUsd: 1,
      paid: false,
      concurrency: 3,
    });
    expect(outcome.conversationsRun).toBe(4);
    expect(maxInFlight()).toBeGreaterThan(1);
    // results stay in conversation order
    expect(outcome.results.map((r) => r.conversationId)).toEqual([
      'c1',
      'c2',
      'c3',
      'c4',
    ]);
    const report = summarizeConversations({
      outcome,
      totalConversations: 4,
      model: { kind: 'real', model: 'test/model' },
      retrieval: 'memory',
      budgetUsd: 1,
    });
    expect(report.metrics).toMatchObject({
      accuracy: 0.5,
      wrongFaqRate: 0.5,
      answeredViaEntry: 2,
    });
  });
});

describe('small-talk intents with the same outcome', () => {
  it('greeting and vague are the same for the learner (one reply, then the chips): either is right', async () => {
    const runner: AgentStepRunner = {
      run: () =>
        Promise.resolve({
          kind: 'called',
          args: { intent: 'greeting', faqId: 'none', confidence: 'sure' },
          extras: { lists: {}, texts: {}, flags: {} },
        }),
    };
    const outcome = await runConversations({
      conversations: [
        {
          id: 'v',
          set: 'casual',
          locale: 'en-GB',
          persona: 'p',
          turns: [
            {
              message: 'hello, quick question',
              expect: { kind: 'smalltalk', intent: 'vague' },
            },
            {
              message: 'bye',
              expect: { kind: 'smalltalk', intent: 'farewell' },
            },
          ],
        },
      ],
      qa: memoryQaSource(faqs),
      runner,
      env: ENV,
      budgetUsd: 1,
      paid: false,
    });
    expect(outcome.results.map((r) => r.right)).toEqual([true, false]);
    const report = summarizeConversations({
      outcome,
      totalConversations: 1,
      model: { kind: 'real', model: 'test/model' },
      retrieval: 'memory',
      budgetUsd: 1,
    });
    expect(report.metrics.smalltalkIntentAccuracy).toBe(0.5);
  });
});
