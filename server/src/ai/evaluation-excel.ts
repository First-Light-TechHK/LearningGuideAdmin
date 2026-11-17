const text = (value: unknown): string =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean'
    ? String(value)
    : '';
import * as XLSX from 'xlsx';
import { BadRequestException } from '@nestjs/common';
import type { EvaluationMode } from './evaluation-contract';

export function evaluationExample(mode: EvaluationMode): Buffer {
  const question =
    mode === 'LECTURE'
      ? '请解释本课的核心概念。'
      : '我应该如何理解本课的核心概念？';
  return workbook([
    ['Test', [['Mode', mode]]],
    [
      'Questions',
      [
        ['Conversation ID', 'Turn', 'Question', 'Notes'],
        ['C001', 1, question, '独立单轮 / Independent question'],
        ['C002', 1, question, '多轮起点 / Multi-turn start'],
        ['C002', 2, '能结合前面的回答举一个例子吗？', '追问 / Follow-up'],
      ],
    ],
    [
      'Instructions',
      [
        [
          '保留Test表Mode。问题填写Questions；同一会话轮次从1连续编号，最多200份回答。 / Keep Test.Mode. Fill Questions. Turns start at 1 without gaps. Maximum 200 answers.',
        ],
      ],
    ],
  ]);
}

export function parseEvaluationExample(buffer: Buffer): {
  mode: EvaluationMode;
  questions: EvaluationQuestion[];
} {
  if (buffer.length > 5 * 1024 * 1024)
    throw new BadRequestException('FILE_TOO_LARGE');
  let mode: unknown;
  try {
    const book = XLSX.read(buffer, {
      type: 'buffer',
      sheets: ['Test'],
      sheetRows: 2,
    });
    const cell = book.Sheets.Test?.B1 as XLSX.CellObject | undefined;
    if (cell?.f) throw new Error('Formula');
    mode = cell?.v;
  } catch {
    throw new BadRequestException('INVALID_TEMPLATE');
  }
  if (mode !== 'LECTURE' && mode !== 'SOCRATIC')
    throw new BadRequestException('INVALID_TEMPLATE');
  return { mode, questions: parseExcel(buffer, 'multi') };
}
import {
  EvaluationKind,
  EvaluationLocale,
  EvaluationQuestion,
} from './evaluation-contract';

const labels = {
  'zh-CN': ['题目编号', '会话编号', '轮次', '问题', '备注'],
  'en-GB': ['Case ID', 'Conversation ID', 'Turn', 'Question', 'Notes'],
};
export function template(
  kind: EvaluationKind,
  locale: EvaluationLocale,
  example: boolean,
): Buffer {
  const [id, conversation, turn, question, notes] = labels[locale];
  const rows: unknown[][] = [
    kind === 'single'
      ? [id, question, notes]
      : [conversation, turn, question, notes],
  ];
  if (example) {
    const q =
      locale === 'zh-CN'
        ? '请解释本课的核心概念。'
        : 'Explain the key concept in this lesson.';
    rows.push(kind === 'single' ? ['Q001', q, ''] : ['C001', 1, q, '']);
    if (kind === 'multi')
      rows.push([
        'C001',
        2,
        locale === 'zh-CN' ? '能举个例子吗？' : 'Can you give an example?',
        '',
      ]);
  }
  return workbook([
    ['Questions', rows],
    [
      'Instructions',
      [
        [
          locale === 'zh-CN'
            ? '仅填写 Questions；编号与问题必填。多轮从1连续编号。同一会话共用回答历史。每任务最多200份回答；两种模式分别计数。'
            : 'Fill Questions only. ID and question are required. Turns start at 1 without gaps. Histories are isolated by conversation and mode. Maximum 200 answers per job.',
        ],
      ],
    ],
  ]);
}
export function parseExcel(
  buffer: Buffer,
  kind: EvaluationKind,
): EvaluationQuestion[] {
  if (buffer.length > 5 * 1024 * 1024)
    throw new BadRequestException('FILE_TOO_LARGE');
  let book: XLSX.WorkBook;
  try {
    book = XLSX.read(buffer, {
      type: 'buffer',
      cellFormula: true,
      sheetRows: 203,
    });
  } catch {
    throw new BadRequestException('INVALID_XLSX');
  }
  const sheet = book.Sheets.Questions;
  if (!sheet || sheet['!merges']?.length)
    throw new BadRequestException('INVALID_QUESTIONS_SHEET');
  const range = XLSX.utils.decode_range(
    String(sheet['!fullref'] ?? sheet['!ref'] ?? 'A1'),
  );
  if (range.e.r > 200 || range.e.c > 4)
    throw new BadRequestException('TOO_MANY_ROWS_OR_COLUMNS');
  for (const [address, cell] of Object.entries(sheet)) {
    if (!address.startsWith('!') && (cell as XLSX.CellObject).f)
      throw new BadRequestException(`${address}:FORMULA_NOT_ALLOWED`);
  }
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: '',
    blankrows: true,
  });
  const header = rows.shift()?.map(String) ?? [];
  const expected = Object.values(labels).map(
    ([id, conversation, turn, question, notes]) =>
      kind === 'single'
        ? [id, question, notes]
        : [conversation, turn, question, notes],
  );
  if (
    !expected.some(
      (columns) =>
        header.length <= columns.length &&
        columns.slice(0, -1).every((value, i) => header[i] === value) &&
        (!header[columns.length - 1] ||
          header[columns.length - 1] === columns.at(-1)),
    )
  )
    throw new BadRequestException('INVALID_HEADERS');
  return rows.map((row) => ({
    conversationId: String(row[0]).trim(),
    turn: kind === 'single' ? 1 : Number(row[1]),
    question: String(row[kind === 'single' ? 1 : 2]).trim(),
    notes: text(row[kind === 'single' ? 2 : 3]),
  }));
}
export function workbook(sheets: Array<[string, unknown[][]]>): Buffer {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of sheets) {
    const expanded = rows.flatMap((row) => {
      const count = Math.max(
        1,
        ...row.map((v) => Math.ceil(text(v).length / 30000)),
      );
      return Array.from({ length: count }, (_, part) =>
        row.map((v) => {
          const value = text(v);
          return value.length > 30000
            ? value.slice(part * 30000, (part + 1) * 30000)
            : part
              ? ''
              : value;
        }),
      );
    });
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(expanded), name);
  }
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
