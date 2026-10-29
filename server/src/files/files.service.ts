import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { MarkItDown } from 'markitdown-ts';
import * as XLSX from 'xlsx';
import WordExtractor from 'word-extractor';

/**
 * §10.1 白名单。
 * 2026-10-15 按 markitdown-ts 实测支持面拍板（当时 xls/doc/ppt/epub 不支持）；
 * 2026-10-19 用户裁决扩充旧版二进制 .doc/.xls——.xls 走 SheetJS、.doc 走 word-extractor。
 */
export const ALLOWED_EXTENSIONS = [
  '.txt',
  '.md',
  '.csv',
  '.pdf',
  '.docx',
  '.xlsx',
  '.html',
  '.xml',
  '.doc',
  '.xls',
] as const;

/** §10.1 单文件大小上限 15MB */
export const MAX_FILE_SIZE = 15 * 1024 * 1024;

export interface ConvertedDocument {
  /** 文件名去扩展名（作新页标题） */
  title: string;
  markdown: string;
}

/** 文档转换（开发文档 §3.2.3、§5.1.6、§10）：仅转换不建页，建页由前端 Import 经 §5.1.3 完成 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);
  private readonly markitdown = new MarkItDown();

  /**
   * 校验上传文件 → 本地转换（内存 Buffer，不落盘）→
   * 返回 { title, markdown } 供弹窗预览（2026-10-15 两步流程改拍）。
   * 转换分支：默认 markitdown-ts；.xls→SheetJS、.doc→word-extractor（2026-10-19 扩充）。
   */
  async convertFile(
    file: Express.Multer.File | undefined,
  ): Promise<ConvertedDocument> {
    if (!file || !file.buffer?.length) {
      throw new BadRequestException('未选择文件（multipart 字段名须为 file）');
    }
    const originalName = this.fixFilenameEncoding(file.originalname);
    const ext = this.getExtension(originalName);
    if (
      !ALLOWED_EXTENSIONS.includes(ext as (typeof ALLOWED_EXTENSIONS)[number])
    ) {
      throw new BadRequestException(
        `格式暂不支持：${ext || '未知'}（支持 ${ALLOWED_EXTENSIONS.join(' / ')}）`,
      );
    }
    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException('文件大小超过 15MB 限制');
    }
    // 旧版 .xls 内容签名校验：非 OLE/BIFF 文件直接拒绝，避免 SheetJS 宽松解析产出垃圾表格
    if (ext === '.xls' && !this.isLegacyXls(file.buffer)) {
      throw new BadRequestException(
        '文件内容不是有效的 .xls 格式（请确认文件类型）',
      );
    }

    let markdown: string;
    try {
      if (ext === '.xls') {
        // 旧版 Excel（BIFF）：markitdown-ts 不支持，改用 SheetJS 解析转 Markdown 表格
        markdown = this.xlsToMarkdown(file.buffer).trim();
      } else if (ext === '.doc') {
        // 旧版 Word（OLE 二进制）：markitdown-ts 不支持，改用 word-extractor 提取纯文本
        markdown = (await this.docToMarkdown(file.buffer)).trim();
      } else {
        const result = await this.markitdown.convertBuffer(file.buffer, {
          file_extension: ext,
        });
        markdown = result?.markdown?.trim() ?? '';
      }
    } catch (e) {
      // 原始错误仅落服务器日志，不向外回显（§9 安全）
      this.logger.warn(
        `文档转换失败 ${originalName}: ${e instanceof Error ? e.message : String(e)}`,
      );
      throw new BadRequestException(
        '文档转换失败，请检查文件是否损坏或受密码保护',
      );
    }
    if (!markdown) {
      throw new BadRequestException('文档转换结果为空');
    }

    const title =
      originalName.slice(0, -ext.length || undefined).trim() || '未命名页面';
    return { title, markdown };
  }

  /**
   * 旧版 .xls 内容签名校验（2026-10-19 新增）：
   * OLE 复合文档头（D0 CF 11 E0 A1 B1 1A E1）或裸 BIFF BOF 记录（小端首字节 0x09）。
   */
  private isLegacyXls(buffer: Buffer): boolean {
    const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    if (
      buffer.length >= OLE_SIGNATURE.length &&
      OLE_SIGNATURE.every((byte, i) => buffer[i] === byte)
    ) {
      return true;
    }
    // 裸 BIFF 流：BOF 记录类型 0x0809 / 0x0409 / 0x0209，小端首字节均为 0x09
    return buffer.length >= 2 && buffer[0] === 0x09 && buffer[1] <= 0x08;
  }

  /**
   * 旧版 .xls（BIFF，2026-10-19 新增）：SheetJS 读取 → 逐工作表转 Markdown 表格。
   * 每张工作表渲染为 `## {sheetName}` + Markdown 表（首行作表头）。
   */
  private xlsToMarkdown(buffer: Buffer): string {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const parts: string[] = [];
    for (const name of workbook.SheetNames) {
      const sheet = workbook.Sheets[name];
      if (!sheet) continue;
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        blankrows: false,
        defval: '',
      });
      const table = this.rowsToMarkdownTable(rows);
      if (table) parts.push(`## ${name}\n\n${table}`);
    }
    return parts.join('\n\n');
  }

  /** 二维数组 → Markdown 表格；忽略全空行，首行作表头 */
  private rowsToMarkdownTable(rows: unknown[][]): string {
    const cells = rows
      .map((row) => (Array.isArray(row) ? row : []))
      .filter((row) => row.some((c) => String(c ?? '').trim() !== ''));
    if (cells.length === 0) return '';
    const width = Math.max(...cells.map((row) => row.length));
    const normalized = cells.map((row) =>
      Array.from({ length: width }, (_, i) =>
        String(row[i] ?? '')
          .replace(/\r?\n/g, ' ')
          .replace(/\|/g, '\\|')
          .trim(),
      ),
    );
    const [header, ...body] = normalized;
    const separator = header.map(() => '---');
    return [header, separator, ...body]
      .map((row) => `| ${row.join(' | ')} |`)
      .join('\n');
  }

  /**
   * 旧版 .doc（OLE 二进制，2026-10-19 新增）：word-extractor 提取正文纯文本。
   * 注意：仅纯文本，不含标题层级 / 表格 / 图片。
   */
  private async docToMarkdown(buffer: Buffer): Promise<string> {
    const extractor = new WordExtractor();
    const doc = await extractor.extract(buffer);
    return doc.getBody() ?? '';
  }

  /**
   * 修复 multipart 中文文件名乱码：busboy 按 latin1 解析文件名头，
   * UTF-8 字节会被拆成重码字符；重解码成功（无替换符）时采用，否则保留原值。
   */
  private fixFilenameEncoding(name: string): string {
    const reDecoded = Buffer.from(name, 'latin1').toString('utf8');
    return reDecoded.includes('\uFFFD') ? name : reDecoded;
  }

  /** 取小写扩展名（含点）；无扩展名返回空串 */
  private getExtension(name: string): string {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot).toLowerCase() : '';
  }
}
