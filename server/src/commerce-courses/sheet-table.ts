import * as XLSX from 'xlsx';

/**
 * 读用户上传的表格（.xlsx 或 .csv）：第一张表，第一行是表头。
 * CSV 一律按 UTF-8 解码并去掉开头的 BOM（Excel 存"CSV UTF-8"会带 BOM，
 * 不去掉的话第一个表头会带着看不见的字符）；.xlsx / .xls 按二进制读。
 */

export interface SheetTable {
  /** 表头行，原样（去掉首尾空白）；只有表头没有数据时 rows 为空，headers 仍在。 */
  headers: string[];
  /** 数据行，键是表头文字；空单元格是空字符串。 */
  rows: Array<Record<string, unknown>>;
}

/** .xlsx 是 zip（"PK"），旧的 .xls 是 OLE 文件（D0 CF）。 */
function isBinaryWorkbook(buffer: Buffer): boolean {
  return (
    (buffer[0] === 0x50 && buffer[1] === 0x4b) ||
    (buffer[0] === 0xd0 && buffer[1] === 0xcf)
  );
}

function withoutBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 读不出来就抛错；调用方换成自己的 400。 */
export function readSheetTable(buffer: Buffer): SheetTable {
  const workbook = isBinaryWorkbook(buffer)
    ? XLSX.read(buffer, { type: 'buffer' })
    : XLSX.read(withoutBom(buffer.toString('utf8')), { type: 'string' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error('No sheet');
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: '',
    raw: false,
  });
  const headers = (grid[0] ?? []).map((value) =>
    typeof value === 'string' ? value.trim() : '',
  );
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: '',
    raw: false,
  });
  return { headers, rows };
}

/** 表头比较时不看大小写、空格和标点。 */
export function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** 取一行里某一列的文字（可以给几个别名，取第一个有这一列的）；没有这一列得到空字符串。 */
export function sheetCell(
  row: Record<string, unknown>,
  ...names: string[]
): string {
  const entries = Object.entries(row);
  for (const name of names) {
    const normalized = normalizeHeader(name);
    const found = entries.find(([key]) => normalizeHeader(key) === normalized);
    if (found) {
      const value = found[1];
      return typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
        ? String(value).trim()
        : '';
    }
  }
  return '';
}
