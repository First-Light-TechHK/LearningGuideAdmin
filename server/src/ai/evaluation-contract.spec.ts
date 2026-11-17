import {
  createResults,
  stopResults,
  validateQuestions,
} from './evaluation-contract';

describe('evaluation contract', () => {
  const question = {
    conversationId: 'c1',
    turn: 1,
    question: '为什么？',
    notes: '',
  };
  it('counts both modes toward the 200 answer limit', () => {
    const questions = Array.from({ length: 100 }, (_, i) => ({
      ...question,
      conversationId: String(i),
    }));
    expect(
      validateQuestions(questions, ['LECTURE', 'SOCRATIC'], 'single'),
    ).toEqual([]);
    expect(
      validateQuestions(
        [...questions, { ...question, conversationId: 'extra' }],
        ['LECTURE', 'SOCRATIC'],
        'single',
      ),
    ).toContain('TOO_MANY_ANSWERS');
  });
  it('rejects gaps, duplicate turns and blank questions', () => {
    const errors = validateQuestions(
      [question, { ...question, turn: 3 }, { ...question, question: ' ' }],
      ['LECTURE'],
      'multi',
    );
    expect(errors).toContain('c1:TURN_GAP');
    expect(errors).toContain('4:DUPLICATE_TURN');
    expect(errors).toContain('4:INVALID_QUESTION');
  });
  it('preserves completed answers and partial output when stopping without mutating the source', () => {
    const results = createResults(
      [question, { ...question, turn: 2 }, { ...question, turn: 3 }],
      ['SOCRATIC'],
    );
    results[0] = { ...results[0], status: 'success', answer: '完整' };
    results[1] = { ...results[1], status: 'running', answer: '片段' };
    const stopped = stopResults(results);
    expect(stopped.map((r) => r.status)).toEqual([
      'success',
      'failed',
      'failed',
    ]);
    expect(stopped[1].answer).toBe('片段');
    expect(stopped[2].error).toBe('USER_STOPPED_NOT_EXECUTED');
    expect(results[1].status).toBe('running');
    expect(createResults([question], ['SOCRATIC'])[0].answer).toBe('');
  });
});
