import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import JSZip from 'jszip';
import { MarkItDown } from 'markitdown-ts';
import * as XLSX from 'xlsx';
import WordExtractor from 'word-extractor';
import { CourseStorageService } from '../commerce-courses/storage.service';
import { PrismaService } from '../prisma/prisma.service';

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
const MAX_DOCX_ENTRIES = 2000;
const MAX_DOCX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_DOCX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_CLEANUP_BATCH_SIZE = 200;

export interface ConvertedDocument {
  /** 文件名去扩展名（作新页标题） */
  title: string;
  markdown: string;
}

/** 文档转换（开发文档 §3.2.3、§5.1.6、§10）：仅转换不建页，建页由前端 Import 经 §5.1.3 完成 */
@Injectable()
export class FilesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FilesService.name);
  private readonly markitdown = new MarkItDown();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private cleanupRunning = false;

  constructor(
    private readonly storage: CourseStorageService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.cleanupTimer = setInterval(
      () => void this.cleanupUnreferencedImages(),
      60 * 60 * 1000,
    );
    this.cleanupTimer.unref?.();
    void this.cleanupUnreferencedImages();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  async storeImage(courseId: string, file: Express.Multer.File) {
    if (file.size > 5 * 1024 * 1024)
      throw new BadRequestException('图片不能超过 5MB');
    const detected = this.detectImage(file.buffer);
    if (!detected)
      throw new BadRequestException('仅支持 PNG、JPEG、GIF、WebP 图片');
    if (
      !(await this.prisma.course.findUnique({
        where: { id: courseId },
        select: { id: true },
      }))
    )
      throw new BadRequestException('课程不存在');
    const assetId = randomUUID();
    await this.saveImageAsset(
      courseId,
      assetId,
      detected.extension,
      file.buffer,
    );
    return {
      url: `/api/files/images/${courseId}/${assetId}.${detected.extension}`,
    };
  }

  private async saveImageAsset(
    courseId: string,
    assetId: string,
    extension: string,
    bytes: Buffer,
  ): Promise<string> {
    const storageKey = `knowledge-pages/${courseId}/${assetId}.${extension}`;
    await this.storage.putMedia(storageKey, bytes);
    try {
      await this.prisma.knowledgeImageAsset.create({
        data: { id: assetId, courseId, storageKey },
      });
    } catch (error) {
      await this.storage.removeMedia(storageKey);
      throw error;
    }
    return storageKey;
  }

  async cleanupUnreferencedImages(now = new Date()): Promise<void> {
    if (this.cleanupRunning) return;
    this.cleanupRunning = true;
    try {
      const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const assets = await this.prisma.knowledgeImageAsset.findMany({
        where: { createdAt: { lt: cutoff } },
        orderBy: { createdAt: 'asc' },
        take: IMAGE_CLEANUP_BATCH_SIZE,
      });
      const byCourse = new Map<string, typeof assets>();
      for (const asset of assets) {
        const group = byCourse.get(asset.courseId) ?? [];
        group.push(asset);
        byCourse.set(asset.courseId, group);
      }
      for (const [courseId, courseAssets] of byCourse) {
        const [pages, releases] = await Promise.all([
          this.prisma.page.findMany({
            where: { courseId },
            select: { contentMd: true },
          }),
          this.prisma.release.findMany({
            where: { courseId },
            select: { snapshotData: true },
          }),
        ]);
        const markdown: string[] = pages.map((page) => page.contentMd);
        for (const release of releases)
          this.collectSnapshotMarkdown(release.snapshotData, markdown);
        for (const asset of courseAssets) {
          if (markdown.some((content) => content.includes(asset.id))) continue;
          await this.storage.removeMedia(asset.storageKey);
          await this.prisma.knowledgeImageAsset.delete({
            where: { id: asset.id },
          });
        }
      }
    } catch (error) {
      this.logger.warn(
        `image cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.cleanupRunning = false;
    }
  }

  private collectSnapshotMarkdown(value: unknown, output: string[]): void {
    if (Array.isArray(value)) {
      for (const item of value) this.collectSnapshotMarkdown(item, output);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'contentMd' && typeof child === 'string') output.push(child);
      else this.collectSnapshotMarkdown(child, output);
    }
  }

  async getImage(courseId: string, asset: string) {
    const match = /^([0-9a-f-]{36})\.(png|jpg|gif|webp)$/i.exec(asset);
    if (!match) return null;
    const extension = match[2].toLowerCase();
    try {
      const bytes = await this.storage.getMedia(
        `knowledge-pages/${courseId}/${asset}`,
      );
      return {
        bytes,
        contentType: (
          {
            png: 'image/png',
            jpg: 'image/jpeg',
            gif: 'image/gif',
            webp: 'image/webp',
          } as const
        )[extension as 'png' | 'jpg' | 'gif' | 'webp'],
      };
    } catch {
      return null;
    }
  }

  private detectImage(bytes: Buffer): { extension: string } | null {
    if (
      bytes.length >= 8 &&
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      return { extension: 'png' };
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
      return { extension: 'jpg' };
    if (bytes.subarray(0, 3).toString() === 'GIF') return { extension: 'gif' };
    if (
      bytes.subarray(0, 4).toString() === 'RIFF' &&
      bytes.subarray(8, 12).toString() === 'WEBP'
    )
      return { extension: 'webp' };
    return null;
  }

  /**
   * 校验上传文件 → 本地转换（内存 Buffer，不落盘）→
   * 返回 { title, markdown } 供弹窗预览（2026-10-15 两步流程改拍）。
   * 转换分支：默认 markitdown-ts；.xls→SheetJS、.doc→word-extractor（2026-10-19 扩充）。
   */
  async convertFile(
    file: Express.Multer.File | undefined,
    courseId?: string,
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
        if (ext === '.docx') await this.preflightDocx(file.buffer);
        const result = await this.markitdown.convertBuffer(file.buffer, {
          file_extension: ext,
        });
        markdown = result?.markdown?.trim() ?? '';
        if (ext === '.docx')
          markdown = await this.persistEmbeddedImages(
            markdown,
            file.buffer,
            courseId,
          );
      }
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
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

  private async preflightDocx(buffer: Buffer): Promise<void> {
    const zip = await JSZip.loadAsync(buffer);
    const entries = Object.values(zip.files).filter((entry) => !entry.dir);
    if (entries.length > MAX_DOCX_ENTRIES)
      throw new BadRequestException('DOCX 文件包含过多内容');
    let totalBytes = 0;
    for (const entry of entries) {
      let entryBytes = 0;
      const stream = entry.nodeStream() as Readable;
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => {
          entryBytes += chunk.length;
          totalBytes += chunk.length;
          if (
            totalBytes > MAX_DOCX_UNCOMPRESSED_BYTES ||
            (entry.name.startsWith('word/media/') &&
              entryBytes > MAX_DOCX_IMAGE_BYTES)
          ) {
            stream.destroy();
            reject(new BadRequestException('DOCX 解压内容超过安全限制'));
          }
        });
        stream.once('end', resolve);
        stream.once('error', reject);
      });
    }
  }

  private async persistEmbeddedImages(
    markdown: string,
    docx: Buffer,
    courseId?: string,
  ): Promise<string> {
    const imageRefs = [
      ...markdown.matchAll(/!\[([^\]]*)\]\(data:image\/[^)]*\)/g),
    ];
    if (!imageRefs.length) return markdown;
    if (
      !courseId ||
      !(await this.prisma.course.findUnique({
        where: { id: courseId },
        select: { id: true },
      }))
    )
      throw new BadRequestException(
        'DOCX 含图片，请从 Knowledge Pages 课程中导入',
      );

    const zip = await JSZip.loadAsync(docx);
    const documentXml = await zip.file('word/document.xml')?.async('text');
    const relationshipsXml = await zip
      .file('word/_rels/document.xml.rels')
      ?.async('text');
    if (!documentXml || !relationshipsXml) return markdown;
    const relationships = new Map<string, string>();
    for (const [, raw] of relationshipsXml.matchAll(
      /<Relationship\b([^>]*?)\/?\s*>/g,
    )) {
      const id = /\bId="([^"]+)"/.exec(raw)?.[1];
      const target = /\bTarget="([^"]+)"/.exec(raw)?.[1];
      const type = /\bType="([^"]+)"/.exec(raw)?.[1];
      if (id && target && type?.endsWith('/image')) {
        relationships.set(
          id,
          path.posix.normalize(path.posix.join('word', target)),
        );
      }
    }
    const imageIds = [
      ...documentXml.matchAll(
        /<(?:a:blip\b[^>]*\br:embed|v:imagedata\b[^>]*\br:id)="([^"]+)"[^>]*\/?\s*>/g,
      ),
    ].map((match) => match[1]);
    const images: Buffer[] = [];
    for (const imageId of imageIds) {
      const target = relationships.get(imageId);
      const entry = target ? zip.file(target) : null;
      if (entry) images.push(await entry.async('nodebuffer'));
    }
    if (images.length !== imageRefs.length) {
      this.logger.warn(
        `DOCX 图片数量不匹配：Markdown ${imageRefs.length}，DOCX ${images.length}`,
      );
    }
    for (let i = 0; i < Math.min(images.length, imageRefs.length); i++) {
      const bytes = images[i];
      const detected = this.detectImage(bytes);
      if (!detected) continue;
      const assetId = randomUUID();
      await this.saveImageAsset(courseId, assetId, detected.extension, bytes);
      markdown = markdown.replace(
        imageRefs[i][0],
        `![${imageRefs[i][1]}](/api/files/images/${courseId}/${assetId}.${detected.extension})`,
      );
    }
    return markdown;
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
    const cellText = (value: unknown): string => {
      if (value == null) return '';
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
      return JSON.stringify(value) ?? '';
    };
    const cells = rows
      .map((row) => (Array.isArray(row) ? row : []))
      .filter((row) => row.some((c) => cellText(c).trim() !== ''));
    if (cells.length === 0) return '';
    const width = Math.max(...cells.map((row) => row.length));
    const normalized = cells.map((row) =>
      Array.from({ length: width }, (_, i) =>
        cellText(row[i]).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim(),
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
