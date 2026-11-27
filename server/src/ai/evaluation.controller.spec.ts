import { EvaluationController } from './evaluation.controller';
import {
  EvaluationService,
  type EvaluationConfig,
  type EvaluationTask,
} from './evaluation.service';
import { AiChatService } from './ai-chat.service';
import { evaluationExample, parseEvaluationExample } from './evaluation-excel';
import * as XLSX from 'xlsx';

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

describe('evaluation result exports', () => {
  const request = { employee: { employeeId: 'e1' } } as Parameters<
    EvaluationController['export']
  >[0];

  it.each([
    ['Modeling life · 第 1 课回归', 'Modeling life · 第 1 课回归'],
    ['对比:第 1 课/结果.xlsx', '对比_第 1 课_结果'],
    ['CON', '_CON'],
    [undefined, 't1'],
  ])(
    'uses the same safe filename stem for both formats (%s)',
    async (name, stem) => {
      const task = {
        id: 't1',
        name,
        status: 'completed',
        config: {},
        results: [],
      } as unknown as EvaluationTask;
      const get = jest.fn().mockResolvedValue(task);
      const controller = new EvaluationController(
        { get } as unknown as EvaluationService,
        {} as AiChatService,
      );
      const response = {
        attachment: jest.fn().mockReturnThis(),
        type: jest.fn().mockReturnThis(),
        send: jest.fn(),
        json: jest.fn(),
      };
      const res = response as unknown as Parameters<
        EvaluationController['export']
      >[4];
      await controller.export(request, 't1', 'xlsx', 'zh-CN', res);
      await controller.export(request, 't1', 'json', 'zh-CN', res);

      expect(get).toHaveBeenCalledWith('e1', 't1');
      expect(response.attachment.mock.calls).toEqual([
        [`${stem}.xlsx`],
        [`${stem}.json`],
      ]);
      expect(response.json).toHaveBeenCalledWith(task);
      const [[data]] = response.send.mock.calls as [[Buffer]];
      const book = XLSX.read(data, { type: 'buffer' });
      expect(book.SheetNames).toEqual(['测试概览', '测试结果', '错误记录']);
      const overview = XLSX.utils.sheet_to_json<string[]>(
        book.Sheets['测试概览'],
        { header: 1 },
      );
      expect(overview).toContainEqual(['ID', 't1']);
      if (name) expect(overview).toContainEqual(['任务名称', name]);
      else expect(overview.some(([label]) => label === '任务名称')).toBe(false);
    },
  );
});
