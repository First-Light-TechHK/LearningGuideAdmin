import { selectRecentCompleteTurns } from './conversation-history';

describe('selectRecentCompleteTurns', () => {
  it('returns only the most recent six complete adjacent turns', () => {
    const messages = Array.from({ length: 8 }, (_, index) => [
      { role: 'user' as const, content: `q${index}` },
      { role: 'assistant' as const, content: `a${index}` },
    ]).flat();

    expect(selectRecentCompleteTurns(messages)).toEqual(
      Array.from({ length: 6 }, (_, index) => ({
        user: `q${index + 2}`,
        assistant: `a${index + 2}`,
      })),
    );
  });

  it('ignores incomplete messages and malformed role sequences', () => {
    expect(
      selectRecentCompleteTurns([
        { role: 'assistant', content: 'orphan answer' },
        { role: 'user', content: 'orphan question' },
        { role: 'user', content: 'complete question' },
        { role: 'assistant', content: 'complete answer' },
        { role: 'user', content: 'unfinished question' },
      ]),
    ).toEqual([{ user: 'complete question', assistant: 'complete answer' }]);
  });

  it('returns an empty history for invalid limits', () => {
    const messages = [{ role: 'user' as const, content: 'q' }];
    expect(selectRecentCompleteTurns(messages, -1)).toEqual([]);
    expect(selectRecentCompleteTurns(messages, 1.5)).toEqual([]);
    expect(selectRecentCompleteTurns(messages, 0)).toEqual([]);
  });
});
