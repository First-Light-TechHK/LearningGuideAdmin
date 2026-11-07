import { DEFAULT_MAIN_PROMPT, DEFAULT_PROMPTS } from './prompt-defaults';

describe('SOCRATIC 默认提示词', () => {
  it('拒绝编造时遵守不追问请求，并要求总结公式有当前证据', () => {
    const socratic = DEFAULT_PROMPTS.SOCRATIC.systemPrompt;
    const lecture = DEFAULT_PROMPTS.LECTURE.systemPrompt;

    expect(socratic).toContain('stop without a follow-up question');
    expect(socratic).toMatch(
      /source is\s+absent from the current selected knowledge/,
    );
    expect(socratic).toContain('"hot/cold" alone does not give');
    expect(socratic).toContain('temperature scale the student will record');
    expect(socratic).toContain('the set of possible temperatures');
    expect(socratic).toContain(
      'value or change equation is known, not missing',
    );
    expect(socratic).toContain("Do not substitute a nearby example's source");
    expect(lecture).not.toContain('stop without a follow-up question');
    expect(lecture).not.toContain('"hot/cold" alone does not give');
  });
});

describe('Tutor 身份与自然口吻', () => {
  it('允许公开的身份能力说明，同时保留内部信息边界', () => {
    expect(DEFAULT_MAIN_PROMPT).toContain('public identity');
    expect(DEFAULT_MAIN_PROMPT).toContain('Learning Guide');
    expect(DEFAULT_MAIN_PROMPT).toContain('Never reveal');
    expect(DEFAULT_MAIN_PROMPT).toContain('vary phrasing across turns');
  });

  it('讲授模式适应学生表达，苏格拉底模式避免机械复述', () => {
    expect(DEFAULT_PROMPTS.LECTURE.systemPrompt).toContain(
      'everyday comparison',
    );
    expect(DEFAULT_PROMPTS.SOCRATIC.systemPrompt).toContain(
      'Do not repeat their wording mechanically',
    );
  });
});
