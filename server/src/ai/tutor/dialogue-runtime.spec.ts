import { visibleTutorAnswer } from './dialogue-runtime';

describe('流式正文与 Sources', () => {
  it('逐字输入也不会泄漏无正文引用的 Sources，正常引用仍保持完整', () => {
    for (const [source, expected] of [
      ['Think about a state.\n\nSources\n[1] Lesson 1', 'Think about a state.'],
      [
        'A state is a variable.[1]\n\nSources\n[1] Lesson 1',
        'A state is a variable.[1]\n\nSources\n[1] Lesson 1',
      ],
    ]) {
      let emitted = '';
      for (let i = 1; i <= source.length; i++) {
        const visible = visibleTutorAnswer(source.slice(0, i), 'SOCRATIC');
        expect(visible.startsWith(emitted)).toBe(true);
        emitted += visible.slice(emitted.length);
      }
      const final = visibleTutorAnswer(source, 'SOCRATIC', true);
      emitted += final.slice(emitted.length);
      expect(emitted).toBe(expected);
    }
  });
});
