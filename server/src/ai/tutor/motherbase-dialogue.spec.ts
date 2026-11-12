import { compileMotherbaseDialogue } from './motherbase-dialogue';

describe('通用 Dialogue 母版消息编译', () => {
  const base = {
    basePrompt: 'BASE',
    modePrompt: 'LECTURE',
    knowledgeMarkdown: '# Unit\n\n$a^2+b^2$',
    mode: 'LECTURE' as const,
    history: [] as Array<{ role: 'user' | 'assistant'; content: string }>,
    message: '  什么是 state variable?  ',
  };

  it('按母版顺序装配完整 Wiki、语言规则、历史和最新问题', () => {
    const history = Array.from({ length: 11 }, (_, index) => [
      { role: 'user' as const, content: `user ${index}` },
      { role: 'assistant' as const, content: `assistant ${index}` },
    ]).flat();
    const result = compileMotherbaseDialogue({ ...base, history });

    expect(result.messages).toHaveLength(22);
    expect(result.messages[0].content).toBe(
      'BASE\n\nLECTURE\n\nCurrent Knowledge Wiki release markdown:\n# Unit\n\n$a^2+b^2$\n\n' +
        'Response language rule for this turn:\nThe latest student input language is English.\n' +
        'Answer only in English, regardless of the language used in internal course context, examples, or previous responses.\n' +
        "Do not translate the student's question unless they explicitly ask for translation.",
    );
    expect(result.messages[1]).toEqual({ role: 'user', content: 'user 1' });
    expect(result.messages[20]).toEqual({
      role: 'assistant',
      content: 'assistant 10',
    });
    expect(result.messages[21]).toEqual({
      role: 'user',
      content: '什么是 state variable?',
    });
    expect(result.temperature).toBe(0.35);
    expect(result.maxOutputTokens).toBe(1400);
  });

  it('无知识时使用母版文案，Socratic 参数与中文语言规则生效', () => {
    const result = compileMotherbaseDialogue({
      ...base,
      mode: 'SOCRATIC',
      modePrompt: 'SOCRATIC',
      knowledgeMarkdown: '',
      message: '什么是状态？',
    });
    expect(result.messages[0].content).toContain(
      'No KS Wiki context is enabled for this dialogue session.',
    );
    expect(result.messages[0].content).toContain(
      'The latest student input language is Chinese.',
    );
    expect(result.temperature).toBe(0.55);
  });

  it('过滤空历史并拒绝空问题', () => {
    const result = compileMotherbaseDialogue({
      ...base,
      history: [
        { role: 'user', content: '  ' },
        { role: 'assistant', content: 'kept' },
      ],
    });
    expect(result.messages[1]).toEqual({ role: 'assistant', content: 'kept' });
    expect(() => compileMotherbaseDialogue({ ...base, message: '  ' })).toThrow(
      'Message is required.',
    );
  });
});
