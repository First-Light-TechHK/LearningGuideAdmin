import { assessProfessorAnswer, qaRollout } from './professor-qa-coverage';
import { qaParts, qaTerms } from '../../knowledge/professor-qa-parts';
import { fuseQa } from '../../ks/professor-qa-search';

describe('professor question retrieval', () => {
  it('indexes the last paragraph, one-letter variables and answer-only terms', () => {
    const question = 'What is T?';
    const answerMd = 'An explanation.\n'.repeat(300) + '最终条件 Ω';
    const parts = qaParts([
      {
        cardId: 'a',
        type: 'professor_qa',
        approvedPayload: { question, answerMd },
      },
    ]);
    expect(parts[0].answerTerms).toContain('条件');
    expect(qaTerms('m 与 M 不相同')).toEqual(
      expect.arrayContaining(['m', 'case4d']),
    );
    expect(
      parts
        .slice(1)
        .map((p) => p.text.slice(question.length + 1))
        .join(''),
    ).toBe(answerMd);
    expect(
      fuseQa([
        [{ cardId: 'a' }, { cardId: 'a' }],
        [{ cardId: 'b' }, { cardId: 'a' }],
      ]),
    ).toEqual(['a', 'b']);
  });
  it('keeps a formula together when a long answer crosses a window boundary', () => {
    const formula = '$$' + 'x = 1 +\n'.repeat(100) + '1$$';
    const answerMd = 'a'.repeat(2100) + formula + 'b'.repeat(100);
    const parts = qaParts([
      {
        cardId: 'm',
        type: 'professor_qa',
        approvedPayload: { question: 'Why?', answerMd },
      },
    ]);
    expect(parts.some((p) => p.text.includes(formula))).toBe(true);
    expect(
      parts
        .slice(1)
        .map((p) => p.text.slice(5))
        .join(''),
    ).toBe(answerMd);
  });
  it('rejects changed units even if the model claims full coverage', async () => {
    const answerMd = 'A 5 cm extension is within the elastic limit.';
    const answer = {
      cardId: 'a',
      question: 'What happens at 5 cm?',
      answerMd,
    };
    const reason = jest.fn();
    const decision = await assessProfessorAnswer(
      {
        name: 'fixture',
        async *stream() {
          yield await Promise.resolve(
            JSON.stringify({
              cardId: 'a',
              coverage: 'full',
              missingRequirements: [],
              conditionsMatch: true,
              support: [
                {
                  part: 'extension',
                  need: 'conclusion',
                  provides: 'conclusion',
                  excerpts: [answerMd],
                },
              ],
            }),
          );
        },
      },
      { model: 'fixture', apiKey: 'unused', baseUrl: 'local' },
      'Is a 5 m extension elastic?',
      [answer],
      'en',
      undefined,
      undefined,
      reason,
    );
    expect(decision).toBeUndefined();
    expect(reason).toHaveBeenCalledWith('unit_condition_changed');
  });
  it('rejects selection criteria offered as a definition even with a verbatim quote and a full verdict', async () => {
    const question = 'What is a sensor?';
    const quote = 'Choose the sensor to suit the environment.';
    const report = jest.fn();
    const decision = await assessProfessorAnswer(
      {
        name: 'fixture',
        async *stream() {
          yield await Promise.resolve(
            JSON.stringify({
              cardId: 'a',
              coverage: 'full',
              conditionsMatch: true,
              missingRequirements: [],
              support: [
                {
                  part: 'sensor',
                  need: 'definition',
                  provides: 'selection',
                  excerpts: [quote],
                },
              ],
            }),
          );
        },
      },
      { model: 'fixture', apiKey: 'unused', baseUrl: 'local' },
      question,
      [{ cardId: 'a', question: 'How do I choose a sensor?', answerMd: quote }],
      'en',
      undefined,
      undefined,
      report,
    );
    expect(decision).toBeUndefined();
    expect(report).toHaveBeenCalledWith('unsupported_evidence');
  });
  it.each([
    [
      'Compare A and B.',
      ['A', 'Compare'],
      ['definition', 'relationship'],
      false,
    ],
    [
      'Compare A and B.',
      ['A', 'B', 'Compare'],
      ['definition', 'definition', 'relationship'],
      true,
    ],
    ['甲与乙有何区别？', ['甲', '区别'], ['definition', 'relationship'], false],
    [
      '甲与乙有何区别？',
      ['甲', '乙', '区别'],
      ['definition', 'definition', 'relationship'],
      true,
    ],
    ['Is the equilibrium stable?', ['stable'], ['criterion'], false],
    ['该平衡是否稳定？', ['平衡', '稳定'], ['criterion', 'conclusion'], true],
  ] as const)(
    'checks both sides or the basis for a judgment in %s',
    async (question, parts, roles, accepted) => {
      const excerpts = parts.map((part) => 'Evidence for ' + part + '.');
      const support = parts.map((part, i) => ({
        part,
        need: roles[i],
        provides: roles[i],
        excerpts: [excerpts[i]],
      }));
      const decision = await assessProfessorAnswer(
        {
          name: 'fixture',
          async *stream() {
            yield await Promise.resolve(
              JSON.stringify({
                cardId: 'a',
                coverage: 'full',
                conditionsMatch: true,
                missingRequirements: [],
                support,
              }),
            );
          },
        },
        { model: 'fixture', apiKey: 'unused', baseUrl: 'local' },
        question,
        [{ cardId: 'a', question, answerMd: excerpts.join(' ') }],
        'auto',
      );
      expect(decision?.coverage).toBe(accepted ? 'full' : undefined);
    },
  );
  it.each([
    {
      cardId: 'ok',
      coverage: 'partial',
      conditionsMatch: true,
      scope: 'quest',
      missingRequirements: ['invented search terms'],
      excerpts: ['example'],
    },
    {
      cardId: 'ok',
      coverage: 'partial',
      conditionsMatch: true,
      scope: 'question',
      missingRequirements: ['question'],
      excerpts: ['example'],
    },
    {
      cardId: 'ok',
      coverage: 'partial',
      conditionsMatch: true,
      excerpts: ['example'],
    },
    {
      cardId: 'else',
      coverage: 'full',
      conditionsMatch: true,
      excerpts: ['example'],
    },
    {
      cardId: 'ok',
      coverage: 'full',
      conditionsMatch: false,
      excerpts: ['example'],
    },
    {
      cardId: 'ok',
      coverage: 'full',
      conditionsMatch: true,
      excerpts: ['invented'],
    },
  ])(
    'abstains on incomplete, contradictory or ungrounded verdicts',
    async (verdict) => {
      expect(
        await assessProfessorAnswer(
          {
            name: 'fake',
            async *stream() {
              yield await Promise.resolve(
                JSON.stringify({
                  missingRequirements: [],
                  ...verdict,
                  support: [
                    {
                      part: 'question',
                      need: 'fact',
                      provides: 'fact',
                      excerpts: verdict.excerpts,
                    },
                  ],
                }),
              );
            },
          },
          { apiKey: 'test', baseUrl: 'local', model: 'test' },
          'question',
          [
            {
              cardId: 'ok',
              question: 'question',
              answerMd: 'example',
            },
          ],
          'en',
        ),
      ).toBeUndefined();
    },
  );
  it.each([
    ['malformed', 'invalid_verdict'],
    ['provider failure', 'decision_provider_error'],
  ])('records %s without adopting a candidate', async (response, expected) => {
    const report = jest.fn();
    const decision = await assessProfessorAnswer(
      {
        name: 'fixture',
        async *stream() {
          if (response === 'provider failure')
            throw new Error('provider unavailable');
          yield await Promise.resolve(response);
        },
      },
      { apiKey: 'fixture', baseUrl: 'local', model: 'test' },
      'Why?',
      [{ cardId: 'a', question: 'Why?', answerMd: 'A reason.' }],
      'en',
      undefined,
      undefined,
      report,
    );
    expect(decision).toBeUndefined();
    expect(report).toHaveBeenCalledWith(expected);
  });

  it('defaults learner courses to the admin path and preserves explicit rollout lists', () => {
    const env = jest.replaceProperty(process, 'env', {});
    try {
      expect(qaRollout('another-course', false)).toBe('on');
      expect(qaRollout('another-course', true)).toBe('on');
    } finally {
      env.restore();
    }
    expect(qaRollout('one', false, '', '')).toBe('off');
    expect(qaRollout('one', false, 'two', 'three')).toBe('off');
    expect(qaRollout('one', true, '', '')).toBe('on');
    expect(qaRollout('one', false, 'one', '')).toBe('on');
    expect(qaRollout('one', true, 'one', 'one')).toBe('shadow');
  });
});
