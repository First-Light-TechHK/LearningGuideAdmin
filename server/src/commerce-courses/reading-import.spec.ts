import { BadRequestException } from '@nestjs/common';
import * as XLSX from 'xlsx';
import {
  checkReadingRows,
  missingReadingColumns,
  parseReadingList,
  readingTemplateCsv,
} from './reading-import';
import { readSheetTable } from './sheet-table';

describe('parseReadingList', () => {
  it('reads the rows and upper-cases the type', () => {
    expect(
      parseReadingList([
        {
          id: ' r1 ',
          type: 'book',
          title: ' T ',
          author: 'A',
          whyRecommended: 'W',
        },
        { type: 'Other' },
      ]),
    ).toEqual([
      { id: 'r1', type: 'BOOK', title: 'T', author: 'A', whyRecommended: 'W' },
      {
        id: undefined,
        type: 'OTHER',
        title: '',
        author: '',
        whyRecommended: '',
      },
    ]);
  });

  it('treats a missing list as an empty one', () => {
    expect(parseReadingList(undefined)).toEqual([]);
    expect(parseReadingList(null)).toEqual([]);
  });

  /** What a refused input answers with: the code and details of the 400. */
  function refusal(input: unknown): unknown {
    try {
      parseReadingList(input);
    } catch (error) {
      return error instanceof BadRequestException ? error.getResponse() : error;
    }
    return null;
  }

  it('refuses a type outside the four and says which row', () => {
    expect(refusal([{ type: 'Book' }, { type: 'Podcast' }])).toMatchObject({
      code: 'READING_TYPE_INVALID',
      details: { field: 'readings[1].type', row: 2 },
    });
    expect(refusal([{ title: 'No type' }])).toMatchObject({
      code: 'READING_TYPE_INVALID',
      details: { row: 1 },
    });
  });

  it('refuses input that is not shaped like a list of readings', () => {
    expect(() => parseReadingList('x')).toThrow();
    expect(() => parseReadingList(['x'])).toThrow();
    expect(() => parseReadingList([{ type: 'Book', title: 5 }])).toThrow();
  });
});

const row = (fields: Record<string, string>) => ({
  'Lesson ID': 'L001',
  Type: 'Book',
  Title: 'A title',
  Author: 'An author',
  'Why we recommend it': 'A reason',
  ...fields,
});

describe('missingReadingColumns', () => {
  it('accepts the template columns, in any case, with the short names for the last one', () => {
    expect(
      missingReadingColumns([
        'Course ID',
        'lesson id',
        'Lesson title',
        'TYPE',
        'Title',
        'Author',
        'Why we recommend it',
      ]),
    ).toEqual([]);
    expect(
      missingReadingColumns(['Lesson ID', 'Type', 'Title', 'Author', 'Why']),
    ).toEqual([]);
  });

  it('names every required column that is not there', () => {
    expect(missingReadingColumns(['Lesson ID', 'Type', 'Question'])).toEqual([
      'Title',
      'Author',
      'Why we recommend it',
    ]);
    expect(missingReadingColumns([])).toHaveLength(5);
  });
});

describe('checkReadingRows', () => {
  const lessons = ['L001', 'L002'];

  it('keeps the good rows and says which row is bad and why', () => {
    const check = checkReadingRows(
      [
        row({}),
        row({ Type: 'Podcast' }),
        row({ 'Lesson ID': 'L010' }),
        row({ 'Lesson ID': 'L002', Type: 'paper' }),
      ],
      lessons,
    );
    expect(check.rowsRead).toBe(4);
    expect(
      check.valid.map((item) => [item.row, item.lessonCode, item.type]),
    ).toEqual([
      [2, 'L001', 'BOOK'],
      [5, 'L002', 'PAPER'],
    ]);
    expect(check.errors).toEqual([
      { row: 3, message: 'Row 3 · Type must be Book, Article, Paper or Other' },
      { row: 4, message: "Row 4 · Lesson ID L010 doesn't exist" },
    ]);
  });

  it('reports an empty Lesson ID and a missing type', () => {
    const check = checkReadingRows(
      [row({ 'Lesson ID': '' }), row({ Type: '' })],
      lessons,
    );
    expect(check.errors.map((error) => error.message)).toEqual([
      "Row 2 · Lesson ID (empty) doesn't exist",
      'Row 3 · Type must be Book, Article, Paper or Other',
    ]);
  });

  it('imports a row whose title, author or reason is blank', () => {
    const check = checkReadingRows(
      [row({ Author: '', 'Why we recommend it': '' })],
      lessons,
    );
    expect(check.errors).toEqual([]);
    expect(check.valid[0]).toMatchObject({
      title: 'A title',
      author: '',
      whyRecommended: '',
    });
  });

  it('skips a template row nobody filled in, and does not count it', () => {
    const check = checkReadingRows(
      [
        row({ Type: '', Title: '', Author: '', 'Why we recommend it': '' }),
        row({}),
      ],
      lessons,
    );
    expect(check.rowsRead).toBe(1);
    expect(check.errors).toEqual([]);
    expect(check.valid.map((item) => item.row)).toEqual([3]);
  });

  it('knows a lesson by its code in any case and gives back the course spelling', () => {
    const check = checkReadingRows([row({ 'Lesson ID': 'l002' })], lessons);
    expect(check.valid[0].lessonCode).toBe('L002');
  });
});

describe('readingTemplateCsv', () => {
  const csv = readingTemplateCsv('C012', [
    { code: 'L001', title: 'Models, and more' },
    { code: 'L002', title: '=SUM(A1)' },
  ]);

  it('starts with a BOM', () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(Buffer.from(csv, 'utf8').subarray(0, 3)).toEqual(
      Buffer.from([0xef, 0xbb, 0xbf]),
    );
  });

  it('has the same number of columns on every row and one row per lesson', () => {
    const grid = XLSX.utils.sheet_to_json<string[]>(
      XLSX.read(csv.slice(1), { type: 'string' }).Sheets.Sheet1,
      { header: 1, defval: '', raw: false },
    );
    expect(grid).toHaveLength(3);
    expect(new Set(grid.map((line) => line.length))).toEqual(new Set([7]));
    expect(grid[0]).toEqual([
      'Course ID',
      'Lesson ID',
      'Lesson title',
      'Type',
      'Title',
      'Author',
      'Why we recommend it',
    ]);
  });

  it('is prefilled with the Course ID, the Lesson IDs and the English titles', () => {
    const table = readSheetTable(Buffer.from(csv, 'utf8'));
    expect(
      table.rows.map((line) => [line['Course ID'], line['Lesson ID']]),
    ).toEqual([
      ['C012', 'L001'],
      ['C012', 'L002'],
    ]);
    expect(table.rows[0]['Lesson title']).toBe('Models, and more');
  });

  it('keeps a title from being run as a formula', () => {
    expect(csv).toContain("'=SUM(A1)");
  });

  it('imports back with nothing to read when nobody filled it in', () => {
    const table = readSheetTable(Buffer.from(csv, 'utf8'));
    expect(missingReadingColumns(table.headers)).toEqual([]);
    expect(checkReadingRows(table.rows, ['L001', 'L002']).rowsRead).toBe(0);
  });
});
