import * as XLSX from 'xlsx';
import { normalizeHeader, readSheetTable, sheetCell } from './sheet-table';

const BOM = String.fromCharCode(0xfeff);

describe('readSheetTable', () => {
  it('reads a CSV with a BOM without leaving it on the first header', () => {
    const table = readSheetTable(
      Buffer.from(`${BOM}Lesson ID,Title\r\nL001,First\r\n`, 'utf8'),
    );
    expect(table.headers).toEqual(['Lesson ID', 'Title']);
    expect(table.rows).toEqual([{ 'Lesson ID': 'L001', Title: 'First' }]);
  });

  it('reads a CSV without a BOM as UTF-8', () => {
    const table = readSheetTable(
      Buffer.from('Lesson ID,Author\nL001,Müller 王\n', 'utf8'),
    );
    expect(table.rows[0].Author).toBe('Müller 王');
  });

  it('keeps commas and quotes inside a quoted field', () => {
    const table = readSheetTable(
      Buffer.from('Lesson ID,Title\nL001,"Models, ""big"" and small"\n'),
    );
    expect(table.rows[0].Title).toBe('Models, "big" and small');
  });

  it('gives the headers of a file that has no data rows', () => {
    const table = readSheetTable(Buffer.from('Lesson ID,Type,Title\n'));
    expect(table.headers).toEqual(['Lesson ID', 'Type', 'Title']);
    expect(table.rows).toEqual([]);
  });

  it('reads an .xlsx workbook', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['Lesson ID', 'Title'],
        ['L002', 'Second'],
      ]),
      'Readings',
    );
    const bytes = XLSX.write(wb, {
      type: 'buffer',
      bookType: 'xlsx',
    }) as Buffer;
    const table = readSheetTable(bytes);
    expect(table.headers).toEqual(['Lesson ID', 'Title']);
    expect(table.rows).toEqual([{ 'Lesson ID': 'L002', Title: 'Second' }]);
  });
});

describe('sheetCell', () => {
  const row = { 'Lesson ID': ' L001 ', Why: 'Because', Count: 3, Odd: {} };

  it('finds a column by any of its names, ignoring case and punctuation', () => {
    expect(sheetCell(row, 'lessonid')).toBe('L001');
    expect(sheetCell(row, 'Why we recommend it', 'Why')).toBe('Because');
  });

  it('turns numbers into text and anything else into an empty string', () => {
    expect(sheetCell(row, 'Count')).toBe('3');
    expect(sheetCell(row, 'Odd')).toBe('');
    expect(sheetCell(row, 'Missing')).toBe('');
  });
});

describe('normalizeHeader', () => {
  it('drops case, spaces and punctuation', () => {
    expect(normalizeHeader('Why we recommend it')).toBe('whywerecommendit');
    expect(normalizeHeader(`${BOM}Lesson ID`)).toBe('lessonid');
  });
});
