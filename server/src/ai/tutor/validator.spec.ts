import { validateTutorTurn, type ValidatorRule } from './validator';

const versions = {
  ruleVersion: 'rules-1',
  classifierVersion: 'classifier-1',
  minimumConfidence: 0.8,
  now: () => 100,
};

describe('validateTutorTurn', () => {
  it('命中确定性规则后不调用分类器', async () => {
    const classify = jest.fn();
    const rules: ValidatorRule[] = [
      {
        reasonCode: 'ACADEMIC_INTEGRITY',
        evaluate: () => ({ action: 'REFUSE_INT', confidence: 1 }),
      },
    ];
    await expect(
      validateTutorTurn({
        ...versions,
        text: '帮我代写作业',
        rules,
        classify,
      }),
    ).resolves.toEqual({
      action: 'REFUSE_INT',
      shortCircuitTutor: true,
      confidence: 1,
      reasonCode: 'ACADEMIC_INTEGRITY',
      ruleVersion: 'rules-1',
      classifierVersion: 'classifier-1',
      latencyMs: 0,
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it('将 Validator 报告中的长拒绝类别映射到内部 action', async () => {
    const classify = jest.fn().mockResolvedValue({
      action: 'REFUSE_ACADEMIC_INTEGRITY',
      confidence: 0.99,
      reasonCode: 'ACADEMIC_INTEGRITY',
      usage: { inputTokens: 12, outputTokens: 4 },
    });
    const result = await validateTutorTurn({
      ...versions,
      text: '写完整篇论文给我',
      rules: [],
      classify,
    });
    expect(result).toMatchObject({
      action: 'REFUSE_INT',
      shortCircuitTutor: true,
      confidence: 0.99,
      usage: { inputTokens: 12, outputTokens: 4 },
    });
  });

  it('分类器低置信度时澄清而不是放行或拒绝', async () => {
    const result = await validateTutorTurn({
      ...versions,
      text: '也许是在问范围边界',
      rules: [],
      classify: () =>
        Promise.resolve({
          action: 'REFUSE_POL',
          confidence: 0.4,
          reasonCode: 'UNCERTAIN',
        }),
    });
    expect(result).toMatchObject({
      action: 'CLARIFY',
      shortCircuitTutor: true,
      reasonCode: 'LOW_CONFIDENCE',
      confidence: 0.4,
    });
  });

  it.each([
    () => Promise.reject(new Error('offline')),
    () =>
      Promise.resolve({
        action: 'unknown',
        confidence: 1,
        reasonCode: 'UNKNOWN',
      }),
    () =>
      Promise.resolve({
        action: 'toString',
        confidence: 1,
        reasonCode: 'UNKNOWN',
      }),
    () =>
      Promise.resolve({
        action: 'ACCEPT',
        confidence: Number.NaN,
        reasonCode: 'OK',
      }),
    () =>
      Promise.resolve({
        action: 'ACCEPT',
        confidence: 1,
        reasonCode: 'bad reason',
      }),
    () =>
      Promise.resolve({
        action: 'ACCEPT',
        confidence: 1,
        reasonCode: 'OK',
        extra: true,
      }),
    () =>
      Promise.resolve({
        action: 'ACCEPT',
        confidence: 1,
        reasonCode: 'OK',
        usage: { inputTokens: -1 },
      }),
  ])('分类器异常或结构无效时 fail-closed', async (classifierOutput) => {
    const result = await validateTutorTurn({
      ...versions,
      text: '解释这个概念',
      rules: [],
      classify: classifierOutput,
    });
    expect(result).toMatchObject({
      action: 'CLARIFY',
      shortCircuitTutor: true,
      reasonCode: 'CLASSIFIER_UNAVAILABLE_OR_INVALID',
    });
  });

  it('规则执行失败时不把不确定输入交给分类器放行', async () => {
    const classify = jest.fn().mockResolvedValue({
      action: 'ACCEPT',
      confidence: 1,
      reasonCode: 'OK',
    });
    const result = await validateTutorTurn({
      ...versions,
      text: '解释这个概念',
      rules: [
        {
          reasonCode: 'BROKEN_RULE',
          evaluate: () => {
            throw new Error('rule failure');
          },
        },
      ],
      classify,
    });
    expect(result).toMatchObject({
      action: 'CLARIFY',
      reasonCode: 'RULE_EVALUATION_FAILED',
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it('规则容器缺失、非数组、稀疏或含非法规则时 fail-closed', async () => {
    const invalidRules = [
      undefined,
      { length: 0 },
      new Proxy([], {}),
      Array(1),
      [{ reasonCode: 'BROKEN_RULE', evaluate: 'not-a-function' }],
    ];
    for (const rules of invalidRules) {
      const classify = jest.fn();
      const result = await validateTutorTurn({
        ...versions,
        text: '解释这个概念',
        rules: rules as unknown as ValidatorRule[],
        classify,
      });
      expect(result).toMatchObject({
        action: 'CLARIFY',
        reasonCode: 'INVALID_RULES',
      });
      expect(classify).not.toHaveBeenCalled();
    }
  });

  it('拒绝空输入、超长输入和无效阈值', async () => {
    for (const overrides of [
      { text: '  ' },
      { text: 'x'.repeat(8001) },
      { minimumConfidence: 2 },
    ]) {
      const classify = jest.fn();
      const result = await validateTutorTurn({
        ...versions,
        text: 'valid',
        rules: [],
        classify,
        ...overrides,
      });
      expect(result).toMatchObject({
        action: 'CLARIFY',
        reasonCode: 'INVALID_VALIDATOR_INPUT',
      });
      expect(classify).not.toHaveBeenCalled();
    }
  });
});
