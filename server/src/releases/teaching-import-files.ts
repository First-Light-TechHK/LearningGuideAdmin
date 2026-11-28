import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import {
  Document,
  HeadingLevel,
  ImageRun,
  Math as WordMath,
  MathFraction,
  MathRun,
  Packer,
  Paragraph,
} from 'docx';
import JSZip from 'jszip';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import * as XLSX from 'xlsx';
import type { SheetRow } from './teaching-sheet-rows';

const sheetDefinitions = {
  concept: {
    name: 'Definitions',
    zh: ['定义名称', '教材原文摘录', '定义正文'],
    en: ['Definition name', 'Textbook excerpt', 'Definition'],
  },
  professor_qa: {
    name: 'Professor Q&A',
    zh: ['学生问题', '教授回答'],
    en: ['Student question', 'Professor answer'],
  },
};

export type SheetKind = keyof typeof sheetDefinitions;
export const teachingSheetKinds = Object.keys(sheetDefinitions) as SheetKind[];
export const TEACHING_BATCH_LIMIT = 500;
export const TEACHING_WORKBOOK_ROW_LIMIT = 1000;
export const TEACHING_SHEET_BYTES = 16 * 1024 * 1024;
const dependencySheet = '_TeachingReferences';
const maximumDependencies = 1000;
const workbookFormat = 1;

export function sheetKind(kind: unknown): SheetKind {
  if (typeof kind === 'string' && Object.hasOwn(sheetDefinitions, kind))
    return kind as SheetKind;
  throw new BadRequestException('TEACHING_SHEET_INVALID');
}

export function selectedSheetKinds(kinds: unknown): SheetKind[] {
  if (
    !Array.isArray(kinds) ||
    !kinds.length ||
    kinds.length > teachingSheetKinds.length
  )
    throw new BadRequestException('TEACHING_SHEET_INVALID');
  const selected = kinds.map(sheetKind);
  if (new Set(selected).size !== selected.length)
    throw new BadRequestException('TEACHING_SHEET_INVALID');
  return teachingSheetKinds.filter((kind) => selected.includes(kind));
}

type SheetOutput = { kind: SheetKind; rows: readonly string[][] };

function writeWorkbook(
  sheets: readonly SheetOutput[],
  chinese: boolean,
  dependencies?: ReadonlyMap<string, string>,
  format?: number,
) {
  const book = XLSX.utils.book_new();
  if (format !== undefined) book.Custprops = { TeachingWorkbookFormat: format };
  for (const { kind, rows } of sheets) {
    const definition = sheetDefinitions[kind];
    const minimal = kind === 'concept' && rows.length === 0;
    const header = definition[chinese ? 'zh' : 'en'];
    const sheet = XLSX.utils.aoa_to_sheet(
      minimal ? [[header[0], header[2]]] : [header, ...rows],
    );
    sheet['!cols'] = Array.from(
      { length: minimal ? 2 : header.length },
      (_, i) => ({ wch: i === 0 ? 35 : 65 }),
    );
    XLSX.utils.book_append_sheet(book, sheet, definition.name);
  }
  if (dependencies?.size) {
    if (dependencies.size > maximumDependencies)
      throw new PayloadTooLargeException('TEACHING_TRANSFER_TOO_LARGE');
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([['teaching-references-v1'], ...dependencies]),
      dependencySheet,
    );
    XLSX.utils.book_set_sheet_visibility(book, dependencySheet, 1);
  }
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export function teachingWorkbook(
  kind: SheetKind,
  rows: readonly string[][],
  chinese: boolean,
  dependencies?: ReadonlyMap<string, string>,
) {
  return writeWorkbook([{ kind, rows }], chinese, dependencies);
}

export function teachingWorkbookSheets(
  sheets: readonly SheetOutput[],
  dependencies?: ReadonlyMap<string, string>,
) {
  return writeWorkbook(sheets, false, dependencies, workbookFormat);
}

async function openTeachingWorkbook(bytes: Buffer) {
  if (bytes.length > TEACHING_SHEET_BYTES) throw new Error();
  const zip = await JSZip.loadAsync(bytes);
  if (!zip.file('xl/workbook.xml') || Object.keys(zip.files).length > 128)
    throw new Error();
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    if (entry.name !== entry.unsafeOriginalName) throw new Error();
    for await (const chunk of new Readable().wrap(entry.nodeStream())) {
      total += (chunk as Buffer).length;
      if (total > 64 * 1024 * 1024) throw new Error();
    }
  }
  const book = XLSX.read(bytes, { type: 'buffer', dense: false });
  const dependencies = new Map<string, string>();
  if (book.Sheets[dependencySheet]) {
    const [header, ...entries] = XLSX.utils.sheet_to_json<unknown[]>(
      book.Sheets[dependencySheet],
      { header: 1, blankrows: false },
    );
    if (
      header?.[0] !== 'teaching-references-v1' ||
      entries.length > maximumDependencies
    )
      throw new Error();
    for (const [code, hash] of entries) {
      if (
        typeof code !== 'string' ||
        code.length > 80 ||
        !code ||
        typeof hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(hash) ||
        dependencies.has(code)
      )
        throw new Error();
      dependencies.set(code, hash);
    }
  }
  return { book, dependencies };
}

function readTeachingSheet(
  kind: SheetKind,
  sheet: XLSX.WorkSheet,
  dependencies: Map<string, string>,
) {
  const cellAt = (r: number, c: number) =>
    sheet[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
  const keys = Object.keys(sheet)
    .filter((key) => !key.startsWith('!'))
    .map((key) => XLSX.utils.decode_cell(key));
  const { zh, en } = sheetDefinitions[kind];
  const headers = [zh, en];
  if (kind === 'concept')
    headers.push(...headers.map(([name, , body]) => [name, body]));
  const header = headers.find((names) =>
    names.every((name, c) => {
      const cell = cellAt(0, c);
      return cell?.v === name && !cell.f;
    }),
  );
  if (!header || keys.some(({ c }) => c >= header.length)) throw new Error();
  const minimal = kind === 'concept' && header.length === 2;
  const rows = [...new Set(keys.map(({ r }) => r).filter((r) => r > 0))]
    .sort((a, b) => a - b)
    .map((r) => {
      const cells = minimal
        ? [cellAt(r, 0), undefined, cellAt(r, 1)]
        : header.map((_, c) => cellAt(r, c));
      const errors = cells.flatMap((cell, c) =>
        cell &&
        (cell.f ||
          cell.F ||
          (cell.t !== 'z' &&
            cell.v !== undefined &&
            typeof cell.v !== 'string'))
          ? [c]
          : [],
      );
      const values = cells.map((cell) =>
        typeof cell?.v === 'string' ? cell.v : '',
      );
      return {
        row: r + 1,
        values,
        errors,
        ...(minimal ? { sourceOmitted: true } : {}),
        ...(dependencies.size ? { dependencies } : {}),
      };
    })
    .filter(
      (row) => row.errors.length || row.values.some((value) => value.trim()),
    );
  if (rows.length > TEACHING_BATCH_LIMIT) throw new Error();
  return rows;
}

export async function readTeachingWorkbook(kind: SheetKind, bytes: Buffer) {
  try {
    const { book, dependencies } = await openTeachingWorkbook(bytes);
    if (
      book.SheetNames.length !== 1 &&
      (book.SheetNames.length !== 2 || book.SheetNames[1] !== dependencySheet)
    )
      throw new Error();
    return readTeachingSheet(
      kind,
      book.Sheets[book.SheetNames[0]],
      dependencies,
    );
  } catch {
    throw new BadRequestException('TEACHING_SHEET_INVALID');
  }
}

export type WorkbookSheet = {
  kind: SheetKind;
  name: string;
  rows: SheetRow[];
  invalid?: true;
};

export async function readTeachingWorkbookSheets(bytes: Buffer) {
  try {
    const { book, dependencies } = await openTeachingWorkbook(bytes);
    const format = (
      book.Custprops as { TeachingWorkbookFormat?: unknown } | undefined
    )?.TeachingWorkbookFormat;
    if (format !== undefined && format !== workbookFormat) throw new Error();
    const names = book.SheetNames.filter((name) => name !== dependencySheet);
    const sheets: WorkbookSheet[] = [];
    const skippedSheets: string[] = [];
    for (const name of names) {
      if (
        book.Workbook?.Sheets?.some(
          (sheet) => sheet.name === name && sheet.Hidden,
        )
      ) {
        skippedSheets.push(name);
        continue;
      }
      const kind = teachingSheetKinds.find(
        (key) =>
          sheetDefinitions[key].name.toLowerCase() ===
          name.trim().toLowerCase(),
      );
      const sheet = book.Sheets[name];
      if (kind) {
        if (sheets.some((entry) => entry.kind === kind)) throw new Error();
        try {
          sheets.push({
            kind,
            name,
            rows: readTeachingSheet(kind, sheet, dependencies),
          });
        } catch {
          sheets.push({ kind, name, rows: [], invalid: true });
        }
      } else if (format === undefined && names.length === 1) {
        // Older one-sheet uploads accept arbitrary names when the headings identify the type.
        for (const candidate of teachingSheetKinds) {
          try {
            sheets.push({
              kind: candidate,
              name,
              rows: readTeachingSheet(candidate, sheet, dependencies),
            });
            break;
          } catch {
            /* Try the next legacy heading layout. */
          }
        }
      } else {
        skippedSheets.push(name);
      }
    }
    if (
      !sheets.length ||
      sheets.reduce((total, sheet) => total + sheet.rows.length, 0) >
        TEACHING_WORKBOOK_ROW_LIMIT
    )
      throw new Error();
    return { sheets, skippedSheets };
  } catch {
    throw new BadRequestException('TEACHING_SHEET_INVALID');
  }
}

export async function referenceWordTemplate(kind: 'latex' | 'image') {
  const formula = kind === 'latex';
  const content = formula
    ? new Paragraph({
        children: [
          new WordMath({
            children: [
              new MathFraction({
                numerator: [new MathRun('dx')],
                denominator: [new MathRun('dt')],
              }),
              new MathRun('=F(x,t)'),
            ],
          }),
        ],
      })
    : new Paragraph({
        children: [
          new ImageRun({
            type: 'png',
            data: await sharp(
              Buffer.from(
                '<svg xmlns="http://www.w3.org/2000/svg" width="250" height="110"><rect width="250" height="110" fill="#f4f7fb"/><path d="M28 16v73h196 M44 76l55-20 55 6 59-39" fill="none" stroke="#335a88" stroke-width="3"/></svg>',
              ),
            )
              .png()
              .toBuffer(),
            transformation: { width: 250, height: 110 },
          }),
        ],
      });
  return Packer.toBuffer(
    new Document({
      sections: [
        {
          children: [
            new Paragraph({
              heading: HeadingLevel.HEADING_1,
              text: 'Lesson 3',
            }),
            new Paragraph({
              heading: HeadingLevel.HEADING_3,
              text: formula
                ? 'L3-F01 一般动力系统 · General dynamic system'
                : 'Exhibit 3.1 状态空间 · State space',
            }),
            new Paragraph(
              formula
                ? 'Describes how the system state changes over time.'
                : 'Shows how to read the direction of change in a state-space diagram.',
            ),
            content,
          ],
        },
      ],
    }),
  );
}
