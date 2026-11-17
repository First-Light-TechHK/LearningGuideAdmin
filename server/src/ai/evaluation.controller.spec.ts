import { EvaluationController } from './evaluation.controller';
import { EvaluationService, type EvaluationConfig } from './evaluation.service';
import { AiChatService } from './ai-chat.service';
import { evaluationExample, parseEvaluationExample } from './evaluation-excel';

describe('evaluation mode selection', () => {
  const config: EvaluationConfig = {
    courseId: 'c1',
    releaseId: 'r1',
    model: 'm1',
    runningSolution: 'grounded-jack',
    modes: ['LECTURE'],
    kind: 'multi',
  };
  it('validates using the page mode rather than the example marker', () => {
    const controller = new EvaluationController(
      {} as EvaluationService,
      {} as AiChatService,
    );
    const file = {
      originalname: 'socratic.xlsx',
      buffer: evaluationExample('SOCRATIC'),
    } as Express.Multer.File;
    const result = controller.validate(file, JSON.stringify(config));
    expect(result.mode).toBe('LECTURE');
    expect(result.exampleMode).toBe('SOCRATIC');
    expect(result.errors).toEqual([]);
  });
  it('allows a validated example to execute in the selected mode', () => {
    const create = jest.fn().mockReturnValue('created');
    const controller = new EvaluationController(
      { create } as unknown as EvaluationService,
      {} as AiChatService,
    );
    const buffer = evaluationExample('SOCRATIC');
    const request = { employee: { employeeId: 'e1' } } as Parameters<
      EvaluationController['create']
    >[0];
    expect(
      controller.create(request, {
        config,
        questions: parseEvaluationExample(buffer).questions,
        source: buffer.toString('base64'),
      }),
    ).toBe('created');
    expect(create).toHaveBeenCalledWith(
      'e1',
      config,
      expect.any(Array),
      expect.any(Buffer),
      undefined,
      undefined,
    );
  });
});
