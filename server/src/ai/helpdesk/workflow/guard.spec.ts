import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  GUARD_LIMITS,
  GUARD_REASONS,
  type FaqBlock,
} from '../../../contracts/helpdesk-qa';
import {
  AI_FILLER,
  ANSWER_LINES,
  ANSWER_TONES,
  chooseExcerpt,
  guardExplanation,
  guardShortText,
  guardSummary,
  learnerOf,
  replyTemplate,
  TEMPLATES,
  textLength,
  ungroundedToken,
  type ReplyIntent,
  type TemplateVariant,
} from './guard';

/**
 * 守卫（v5 Part B §2、Part D §4、Part H）：模型写的每一句都过代码守卫，不过就用固定模板。
 * 语料（fixtures/guard-corpus.json）覆盖 zh-CN、zh-TW、en、中英混写、全角数字、AI 套话、禁用词、
 * 文字不符与接地；CI 里不调模型（Part G5「guard corpus test」）。
 */
type CorpusCase = {
  field: 'reply' | 'opening' | 'closing' | 'explanation';
  learner: string;
  locale: string;
  text: string | null;
  answer?: string;
  expect: string;
  shown?: string;
};
const corpus = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'guard-corpus.json'), 'utf8'),
) as { answers: Record<string, string>; cases: CorpusCase[] };

function check(c: CorpusCase) {
  const learner = learnerOf(c.learner, c.locale);
  return c.field === 'explanation'
    ? guardExplanation(c.text, corpus.answers[c.answer as string], learner)
    : guardShortText(c.field, c.text, learner);
}

describe('guard corpus', () => {
  it('covers every field, every reason a model string can fail on, and all four language mixes', () => {
    const reasons = new Set(corpus.cases.map((c) => c.expect));
    for (const reason of GUARD_REASONS.filter(
      (r) => !['not_covered', 'timeout', 'error'].includes(r),
    ))
      expect(reasons).toContain(reason);
    expect(new Set(corpus.cases.map((c) => c.field))).toEqual(
      new Set(['reply', 'opening', 'closing', 'explanation']),
    );
    const variants = new Set(
      corpus.cases.map((c) => learnerOf(c.learner, c.locale).variant),
    );
    expect(variants).toEqual(new Set(['zh-CN', 'zh-TW', 'en']));
    // 中英混写的学员原文、全角数字
    expect(
      corpus.cases.some(
        (c) => /[a-z]/i.test(c.learner) && /\p{Script=Han}/u.test(c.learner),
      ),
    ).toBe(true);
    expect(corpus.cases.some((c) => /[０-９]/.test(c.text ?? ''))).toBe(true);
  });

  it.each(corpus.cases.map((c, i) => [i, c.field, c.text, c] as const))(
    '#%i %s %j',
    (_i, _field, _text, c) => {
      const result = check(c);
      if (c.expect === 'passed') {
        expect(result).toEqual({
          ok: true,
          text: c.shown ?? (c.text as string).trim(),
        });
      } else {
        expect(result).toEqual({ ok: false, reason: c.expect });
      }
    },
  );
});

describe('learner script and template variant', () => {
  it.each([
    ['你好', 'en-GB', { script: 'zh', variant: 'zh-CN' }],
    ['在嗎', 'en-GB', { script: 'zh', variant: 'zh-TW' }],
    ['謝謝你', 'zh-CN', { script: 'zh', variant: 'zh-TW' }],
    ['我的payment失败了', 'en-GB', { script: 'zh', variant: 'zh-CN' }],
    ['thanks', 'zh-CN', { script: 'latin', variant: 'en' }],
    ['👍', 'zh-CN', { script: 'zh', variant: 'zh-CN' }],
    ['👍', 'en-GB', { script: 'latin', variant: 'en' }],
    ['???', 'en-GB', { script: 'latin', variant: 'en' }],
  ])('%s (%s)', (text, locale, expected) => {
    expect(learnerOf(text, locale)).toEqual(expected);
  });

  it('counts characters by code point (an emoji is one)', () => {
    expect(textLength('你好👍')).toBe(3);
  });
});

describe('fixed templates', () => {
  const variants: TemplateVariant[] = ['zh-CN', 'zh-TW', 'en'];
  const intents: ReplyIntent[] = ['greeting', 'vague', 'farewell', 'off_topic'];
  const learnerFor = (variant: TemplateVariant) =>
    variant === 'en'
      ? learnerOf('hello', 'en-GB')
      : learnerOf(variant === 'zh-TW' ? '謝謝' : '谢谢', 'zh-CN');

  it('uses the spec wording for zh-CN', () => {
    expect(replyTemplate('greeting', 'zh-CN')).toBe(
      '你好！遇到什么问题了？可以直接告诉我，或者看看下面这些常见情况。',
    );
    expect(replyTemplate('vague', 'zh-CN')).toBe(
      replyTemplate('greeting', 'zh-CN'),
    );
    expect(replyTemplate('farewell', 'zh-CN')).toBe(
      '不客气！之后有问题随时来问我。',
    );
    expect(replyTemplate('off_topic', 'zh-CN')).toBe(
      '这个我帮不上忙。关于 Learning Guide 的使用、课程或订阅，随时问我。',
    );
    expect(TEMPLATES.opening['zh-CN']).toBe('好的，这个问题可以这样处理：');
    expect(TEMPLATES.opening.en).toBe("Here's how to sort this out:");
    expect(TEMPLATES.closing['zh-CN']).toBe('还有不清楚的，接着问我就好。');
    expect(TEMPLATES.closing.en).toBe("If anything's unclear, just ask.");
  });

  it.each(variants)('every %s template passes its own guard', (variant) => {
    const learner = learnerFor(variant);
    for (const intent of intents) {
      const text = replyTemplate(intent, variant);
      expect(guardShortText('reply', text, learner)).toEqual({
        ok: true,
        text,
      });
    }
    for (const field of ['opening', 'closing'] as const)
      expect(guardShortText(field, TEMPLATES[field][variant], learner)).toEqual(
        { ok: true, text: TEMPLATES[field][variant] },
      );
  });

  it('writes the zh-TW templates in Traditional script', () => {
    for (const intent of intents)
      expect(learnerOf(replyTemplate(intent, 'zh-TW'), 'zh-CN').variant).toBe(
        'zh-TW',
      );
  });
});

describe('limits', () => {
  it.each([
    ['opening', GUARD_LIMITS.opening],
    ['closing', GUARD_LIMITS.closing],
    ['reply', GUARD_LIMITS.reply],
  ] as const)(
    '%s: exactly at the zh / en limit passes, one more fails',
    (field, limit) => {
      const zh = learnerOf('你好', 'zh-CN');
      const en = learnerOf('hello', 'en-GB');
      expect(guardShortText(field, '好'.repeat(limit.zh), zh).ok).toBe(true);
      expect(guardShortText(field, '好'.repeat(limit.zh + 1), zh)).toEqual({
        ok: false,
        reason: 'too_long',
      });
      expect(guardShortText(field, 'a'.repeat(limit.en), en).ok).toBe(true);
      expect(guardShortText(field, 'a'.repeat(limit.en + 1), en)).toEqual({
        ok: false,
        reason: 'too_long',
      });
    },
  );

  it('explanation: 150 zh / 350 en', () => {
    const answer = '好 a';
    const zh = learnerOf('你好', 'zh-CN');
    const en = learnerOf('hello', 'en-GB');
    expect(guardExplanation('好'.repeat(150), answer, zh).ok).toBe(true);
    expect(guardExplanation('好'.repeat(151), answer, zh)).toEqual({
      ok: false,
      reason: 'too_long',
    });
    expect(guardExplanation('a'.repeat(350), answer, en).ok).toBe(true);
    expect(guardExplanation('a'.repeat(351), answer, en)).toEqual({
      ok: false,
      reason: 'too_long',
    });
  });

  it('rejects non-text values as missing', () => {
    const en = learnerOf('hello', 'en-GB');
    for (const raw of [undefined, 42, {}, ['hi']])
      expect(guardShortText('reply', raw, en)).toEqual({
        ok: false,
        reason: 'missing',
      });
  });

  it('lists AI filler from the spec', () => {
    for (const phrase of [
      '当然!',
      '作为ai',
      '希望对你有帮助',
      '我理解你的感受',
      'great question',
      'i hope this helps',
    ])
      expect(AI_FILLER).toContain(phrase);
  });
});

describe('grounding (clarify explanations)', () => {
  const answer =
    'Refunds within **14 days**. Email [help](mailto:help@example.org) or see https://example.org/refunds. Fee £5.';

  it.each([
    ['a digit run that is not in the answer', 'It takes 7 days.', '7'],
    [
      'a longer number containing an answer number',
      'It takes 140 days.',
      '140',
    ],
    [
      'an unknown link',
      'See https://example.org/other.',
      'https://example.org/other',
    ],
    ['an unknown email', 'Mail billing@example.org.', 'billing@example.org'],
    ['an unknown amount', 'The fee is £15.', '£15'],
    ['an unknown bold label', 'Open **Settings**.', 'Settings'],
  ])('flags %s', (_name, text, token) => {
    expect(ungroundedToken(text, answer)).toBe(token);
  });

  it.each([
    ['digits from the answer', 'Within 14 days.'],
    ['full-width digits from the answer', 'Within １４ days.'],
    ['the link from the answer', 'See https://example.org/refunds.'],
    ['the email from the answer', 'Mail help@example.org.'],
    ['the amount from the answer', 'The fee is £5.'],
    ['a bold label from the answer', 'Within **14 days**.'],
    ['nothing checkable', 'Yes, that is right.'],
  ])('accepts %s', (_name, text) => {
    expect(ungroundedToken(text, answer)).toBeNull();
  });

  it('allows a blocked word in an explanation only when the answer says it', () => {
    const en = learnerOf('can I get my money back?', 'en-GB');
    expect(guardExplanation('Yes, refunds are possible.', answer, en).ok).toBe(
      true,
    );
    expect(guardExplanation('Yes, and it is free.', answer, en)).toEqual({
      ok: false,
      reason: 'blocked_phrase',
    });
  });
});

describe('guard summary', () => {
  it('passes when every field passed, else names the first reason and every fallback field', () => {
    expect(
      guardSummary([
        { field: 'opening', reason: null },
        { field: 'closing', reason: null },
      ]),
    ).toEqual({ result: 'passed', reason: null, fallback: [] });
    expect(
      guardSummary([
        { field: 'opening', reason: 'digit' },
        { field: 'closing', reason: 'ai_filler' },
      ]),
    ).toEqual({
      result: 'fallback',
      reason: 'digit',
      fallback: ['opening', 'closing'],
    });
  });
});

describe('excerpt (Part H)', () => {
  const blocks: FaqBlock[] = ['one', 'two', 'three', 'four', 'five'].map(
    (text, i) => ({ id: `b${i + 1}`, text: `${text} `.repeat(15) }),
  );
  const long = blocks.map((b) => b.text).join('\n\n');

  it.each([
    [
      ['b2', 'b3'],
      ['b2', 'b3'],
    ],
    [
      ['b3', 'b2'],
      ['b2', 'b3'],
    ],
    [['b1'], ['b1']],
    [
      ['b3', 'b4', 'b5'],
      ['b3', 'b4', 'b5'],
    ],
    [['b2', 'b2'], ['b2']],
  ])('accepts %j as %j', (picked, expected) => {
    expect(chooseExcerpt(blocks, long, picked)).toEqual(expected);
  });

  it.each([
    ['empty', []],
    ['missing', undefined],
    ['not contiguous', ['b1', 'b3']],
    ['more than 3', ['b1', 'b2', 'b3', 'b4']],
    ['an unknown id', ['b9']],
    ['a malformed id', ['B1']],
  ])('shows the whole answer when the pick is %s', (_name, picked) => {
    expect(chooseExcerpt(blocks, long, picked)).toEqual([]);
  });

  it('shows the whole answer when it has at most 3 blocks or at most 200 characters', () => {
    expect(chooseExcerpt(blocks.slice(0, 3), long, ['b1'])).toEqual([]);
    const short = blocks.map((b, i) => ({ ...b, text: `s${i}` }));
    expect(chooseExcerpt(short, 'x'.repeat(200), ['b1'])).toEqual([]);
    expect(chooseExcerpt(short, 'x'.repeat(201), ['b1'])).toEqual(['b1']);
    expect(chooseExcerpt(undefined, long, ['b1'])).toEqual([]);
  });
});

/** 契约 fixture v6 的 v5 回包例子：Admin 的守卫与模板要能产出它们（示例与实现不打架）。 */
describe('contract fixture v6 examples', () => {
  const fixture = JSON.parse(
    readFileSync(
      join(
        __dirname,
        '../../../backoffice/tests/fixtures/helpdesk-contract.json',
      ),
      'utf8',
    ),
  ) as { portalToAdmin: Record<string, Record<string, unknown>> };
  const ex = fixture.portalToAdmin;
  const en = learnerOf(
    (ex.suggestContextRequest.message as string) ?? '',
    'en-GB',
  );

  it('the fixed answer lines of every tone pass the guard in their own script', () => {
    const samples: [TemplateVariant, string, string][] = [
      ['zh-CN', '我付了钱但是没开通', 'zh-CN'],
      ['zh-TW', '我付了錢但是沒開通', 'zh-TW'],
      ['en', 'I paid but my plan is not active', 'en-GB'],
    ];
    for (const tone of ANSWER_TONES)
      for (const [variant, message, locale] of samples)
        for (const field of ['opening', 'closing'] as const)
          expect(
            guardShortText(
              field,
              ANSWER_LINES[tone][field][variant],
              learnerOf(message, locale),
            ),
          ).toMatchObject({ ok: true });
  });

  it('the answer example opening and closing pass the guard', () => {
    const answer = ex.suggestAnswerContextResponse;
    for (const field of ['opening', 'closing'] as const)
      expect(guardShortText(field, answer[field], en)).toEqual({
        ok: true,
        text: answer[field],
      });
  });

  it('the small-talk examples: a passing reply, and the zh-CN farewell template', () => {
    expect(
      guardShortText('reply', ex.suggestSmalltalkResponse.reply, en).ok,
    ).toBe(true);
    expect(ex.suggestSmalltalkFallbackResponse.reply).toBe(
      replyTemplate('farewell', 'zh-CN'),
    );
  });

  it('the clarify explanation is grounded in the card it explains', () => {
    const card = ex.suggestAnswerContextResponse.suggestion as {
      answer: string;
    };
    expect(
      guardExplanation(ex.suggestClarifyResponse.explanation, card.answer, en),
    ).toEqual({ ok: true, text: ex.suggestClarifyResponse.explanation });
  });
});
