import { qaParts } from './professor-qa-parts';

describe('published teaching card search documents', () => {
  const bilingual = {
    conceptLabel: { en: 'State variable' },
    summary: { en: 'Tracks a changing state.' },
    triggers: { en: ['system state'] },
  };
  it.each(['concept', 'misreading', 'ref_obj'])(
    'keeps the %s identity and indexes its English content',
    (type) => {
      const result = qaParts([
        {
          cardId: 'state',
          type,
          bilingual,
          approvedPayload: { code: 'L1-F01' },
        },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        part: 0,
        cardId: 'state',
      });
      expect(result[0].text).toContain('State variable');
      expect(result[0].text).toContain('L1-F01');
      expect(result[0].text).toContain('system state');
    },
  );
  it('indexes only the main question and its answer for legacy entries', () => {
    const legacyPayload = {
      question: 'What is a state?',
      variants: ['Define state.'],
      answerMd: 'A condition.',
    };
    const result = qaParts([
      {
        cardId: 'qa',
        type: 'professor_qa',
        approvedPayload: legacyPayload,
      },
    ]);
    expect(result.map((row) => row.text)).toEqual([
      'What is a state?',
      'What is a state?\nA condition.',
    ]);
  });
});
