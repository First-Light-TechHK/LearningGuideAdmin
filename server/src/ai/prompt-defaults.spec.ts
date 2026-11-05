import { DEFAULT_PROMPTS } from './prompt-defaults';

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
