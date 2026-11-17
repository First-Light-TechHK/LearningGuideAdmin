import { BadRequestException } from '@nestjs/common';
import { optionalString, requireArray } from './input';
import { normalizeHeader, sheetCell } from './sheet-table';

/**
 * Recommended reading 的保存与批量导入：请求体检查、表格检查、逐行校验、模板。纯函数，不碰数据库。
 *
 * 保存存下填的内容：标题、作者、推荐理由没填也存，没填完由完整性规则报告；
 * 只拒绝形状不对的输入和不在 Book / Article / Paper / Other 里的 Type。
 *
 * 导入只收没有错误的行：课时 ID 不存在、Type 不是 Book / Article / Paper / Other 的行
 * 报错并跳过，其余照常导入；标题、作者、推荐理由没填的行照样导入（和保存一样）。
 * Type、Title、Author、Why 四列都空的行（模板里没动过的预填行）直接跳过，不算错。
 */

export const READING_TYPES: ReadonlySet<string> = new Set([
  'BOOK',
  'ARTICLE',
  'PAPER',
  'OTHER',
]);

export interface ReadingInput {
  /** 已有的一行：带上它的 id 就改这一行，不换 id。 */
  id?: string;
  type: string;
  title: string;
  author: string;
  whyRecommended: string;
}

function invalid(message: string, details: Record<string, unknown>): never {
  throw new BadRequestException({
    code: 'VALIDATION_ERROR',
    message,
    details,
  });
}

/**
 * 保存请求里的列表：没传按空列表；每一行是对象，Type 必须是四种之一（大小写不拘），
 * 其余文字没填就是空字符串。Type 不对 400 READING_TYPE_INVALID 并指出第几行。
 */
export function parseReadingList(input: unknown): ReadingInput[] {
  const rows = requireArray(input, 'readings', { emptyIfMissing: true });
  return rows.map((raw, index) => {
    const row = index + 1;
    const path = `readings[${index}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return invalid(`${path} must be an object.`, { field: path, row });
    }
    const record = raw as Record<string, unknown>;
    const type =
      typeof record.type === 'string' ? record.type.trim().toUpperCase() : '';
    if (!READING_TYPES.has(type)) {
      throw new BadRequestException({
        code: 'READING_TYPE_INVALID',
        message: 'Type must be Book, Article, Paper or Other.',
        details: { field: `${path}.type`, row },
      });
    }
    const text = (field: string) =>
      optionalString(record[field], `${path}.${field}`)?.trim() ?? '';
    return {
      id: optionalString(record.id, `${path}.id`)?.trim() || undefined,
      type,
      title: text('title'),
      author: text('author'),
      whyRecommended: text('whyRecommended'),
    };
  });
}

export interface ReadingImportRow {
  /** 表格里的行号（表头是第 1 行）。 */
  row: number;
  /** 课时 ID，已按课程里的写法还原（不看大小写）。 */
  lessonCode: string;
  type: string;
  title: string;
  author: string;
  whyRecommended: string;
}

export interface ReadingImportCheck {
  /** 有内容的数据行数（没动过的预填行不算）。 */
  rowsRead: number;
  valid: ReadingImportRow[];
  errors: Array<{ row: number; message: string }>;
}

/** 必须有的列；括号里是可接受的写法。 */
const REQUIRED_COLUMNS: Array<{ label: string; names: string[] }> = [
  { label: 'Lesson ID', names: ['Lesson ID', 'LessonID'] },
  { label: 'Type', names: ['Type'] },
  { label: 'Title', names: ['Title'] },
  { label: 'Author', names: ['Author'] },
  {
    label: 'Why we recommend it',
    names: ['Why we recommend it', 'Why we recommend', 'Why'],
  },
];

/** 表头里缺的必需列（按模板里的写法）；空数组表示可以导入。 */
export function missingReadingColumns(headers: readonly string[]): string[] {
  const present = new Set(headers.map(normalizeHeader));
  return REQUIRED_COLUMNS.filter(
    (column) =>
      !column.names.some((name) => present.has(normalizeHeader(name))),
  ).map((column) => column.label);
}

export function checkReadingRows(
  rows: ReadonlyArray<Record<string, unknown>>,
  lessonCodes: Iterable<string>,
): ReadingImportCheck {
  const codeByUpper = new Map<string, string>();
  for (const code of lessonCodes) codeByUpper.set(code.toUpperCase(), code);

  const result: ReadingImportCheck = { rowsRead: 0, valid: [], errors: [] };
  for (const [index, row] of rows.entries()) {
    const rowNo = index + 2;
    const typed = sheetCell(row, 'Type');
    const title = sheetCell(row, 'Title');
    const author = sheetCell(row, 'Author');
    const why = sheetCell(
      row,
      'Why we recommend it',
      'Why we recommend',
      'Why',
    );
    if (!typed && !title && !author && !why) continue;
    result.rowsRead += 1;

    const typedCode = sheetCell(row, 'Lesson ID', 'LessonID');
    const lessonCode = codeByUpper.get(typedCode.toUpperCase());
    if (!lessonCode) {
      result.errors.push({
        row: rowNo,
        message: `Row ${rowNo} · Lesson ID ${typedCode || '(empty)'} doesn't exist`,
      });
      continue;
    }
    const type = typed.toUpperCase();
    if (!READING_TYPES.has(type)) {
      result.errors.push({
        row: rowNo,
        message: `Row ${rowNo} · Type must be Book, Article, Paper or Other`,
      });
      continue;
    }
    result.valid.push({
      row: rowNo,
      lessonCode,
      type,
      title,
      author,
      whyRecommended: why,
    });
  }
  return result;
}

const BOM = String.fromCharCode(0xfeff);
const TEMPLATE_HEADER = [
  'Course ID',
  'Lesson ID',
  'Lesson title',
  'Type',
  'Title',
  'Author',
  'Why we recommend it',
];

/** CSV 单元格：含逗号、引号、换行的加引号；以 = + - @ 开头的加 ' 前缀，Excel 不会当公式执行。 */
function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * 导入模板：BOM 开头，一个启用课时一行，预填 Course ID、Lesson ID 和英文课时名，
 * 每行的列数与表头相同。同一个课时要几条阅读，就把那一行复制几行。
 */
export function readingTemplateCsv(
  courseCode: string,
  lessons: ReadonlyArray<{ code: string; title: string }>,
): string {
  const lines = [TEMPLATE_HEADER.join(',')];
  for (const lesson of lessons) {
    const cells = [courseCode, lesson.code, lesson.title];
    while (cells.length < TEMPLATE_HEADER.length) cells.push('');
    lines.push(cells.map(csvField).join(','));
  }
  return `${BOM}${lines.join('\r\n')}\r\n`;
}
