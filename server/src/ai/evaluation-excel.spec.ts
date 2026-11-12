import * as XLSX from 'xlsx';
import {
  evaluationExample,
  parseEvaluationExample,
  parseExcel,
  template,
  workbook,
} from './evaluation-excel';
import { validateQuestions } from './evaluation-contract';

describe('evaluation Excel', () => {
  for (const mode of ['LECTURE', 'SOCRATIC'] as const) {
    it(`recognizes ${mode} example with independent and multi-turn questions`, () => {
      const parsed = parseEvaluationExample(evaluationExample(mode));
      expect(parsed.mode).toBe(mode);
      expect(parsed.questions.map((q) => [q.conversationId, q.turn])).toEqual([
        ['C001', 1],
        ['C002', 1],
        ['C002', 2],
      ]);
      expect(validateQuestions(parsed.questions, [mode], 'multi')).toEqual([]);
    });
  }
  it('rejects an example without a declared mode', () => {
    expect(() =>
      parseEvaluationExample(template('multi', 'en-GB', true)),
    ).toThrow('INVALID_TEMPLATE');
  });
  for (const locale of ['zh-CN', 'en-GB'] as const) {
    for (const kind of ['single', 'multi'] as const) {
      it(`roundtrips ${locale} ${kind} template and example`, () => {
        expect(parseExcel(template(kind, locale, false), kind)).toEqual([]);
        const questions = parseExcel(template(kind, locale, true), kind);
        expect(questions.length).toBe(kind === 'multi' ? 2 : 1);
        expect(
          validateQuestions(questions, ['LECTURE', 'SOCRATIC'], kind),
        ).toEqual([]);
      });
    }
  }
  it('rejects formulas and unknown headers', () => {
    const book = XLSX.read(template('single', 'en-GB', true));
    book.Sheets.Questions.B2 = { t: 'n', f: '1+1', v: 2 };
    expect(() =>
      parseExcel(
        XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
        'single',
      ),
    ).toThrow('FORMULA_NOT_ALLOWED');
    expect(() =>
      parseExcel(workbook([['Questions', [['Unknown']]]]), 'single'),
    ).toThrow('INVALID_HEADERS');
  });
  it('exports long answers in full and formula-looking answers as strings', () => {
    const answer = '中'.repeat(65000);
    const book = XLSX.read(workbook([['Results', [[answer, '=SUM(1,2)']]]]));
    const sheet = book.Sheets.Results;
    expect(
      [
        (sheet.A1 as XLSX.CellObject).v,
        (sheet.A2 as XLSX.CellObject).v,
        (sheet.A3 as XLSX.CellObject).v,
      ].join(''),
    ).toBe(answer);
    expect((sheet.B1 as XLSX.CellObject).t).toBe('s');
    expect((sheet.B1 as XLSX.CellObject).f).toBeUndefined();
  });
});
