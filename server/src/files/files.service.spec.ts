import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';
import { FilesService, ALLOWED_EXTENSIONS } from './files.service';

/**
 * FilesService 单元测试（§3.2.3/§10，两步流程改拍后）：白名单/空文件校验、
 * markitdown-ts 真实转换（md 直通）、返回 { title, markdown }（标题=文件名去扩展名）。
 */
describe('FilesService', () => {
  let service: FilesService;

  const mkFile = (name: string, buffer: Buffer): Express.Multer.File =>
    ({
      originalname: name,
      buffer,
      size: buffer.length,
    }) as Express.Multer.File;

  beforeEach(() => {
    service = new FilesService();
  });

  it('md 文件应本地转换返回 title+markdown（标题=文件名去扩展名）', async () => {
    const file = mkFile(
      '我的笔记.md',
      Buffer.from('# 标题\n\n正文内容', 'utf8'),
    );
    const result = await service.convertFile(file);
    expect(result.title).toBe('我的笔记');
    expect(result.markdown).toContain('正文内容');
  });

  it('白名单外扩展名应 400（如 .exe / .epub）', async () => {
    await expect(
      service.convertFile(mkFile('a.exe', Buffer.from('x'))),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.convertFile(mkFile('b.epub', Buffer.from('x'))),
    ).rejects.toThrow(BadRequestException);
  });

  it('无扩展名、空 buffer 或 undefined 应 400', async () => {
    await expect(
      service.convertFile(mkFile('noext', Buffer.from('x'))),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.convertFile(mkFile('c.md', Buffer.alloc(0))),
    ).rejects.toThrow(BadRequestException);
    await expect(service.convertFile(undefined)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('转换结果为空（空文档）应 400', async () => {
    await expect(
      service.convertFile(mkFile('empty.md', Buffer.from('   '))),
    ).rejects.toThrow(BadRequestException);
  });

  it('multipart 中文文件名（busboy latin1 乱码）应还原为正确标题', async () => {
    // 模拟浏览器上传：UTF-8 字节被 busboy 按 latin1 解码后的 originalname
    const wireName = Buffer.from('中文笔记.md', 'utf8').toString('latin1');
    expect(wireName).not.toBe('中文笔记.md');
    const result = await service.convertFile(
      mkFile(wireName, Buffer.from('# 内容\n\n正文', 'utf8')),
    );
    expect(result.title).toBe('中文笔记');
  });

  it('旧版 .xls 应本地转 Markdown 表格（SheetJS，2026-10-19 扩充）', async () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Name', 'Score'],
      ['Alice', 90],
      ['Bob', 85],
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Scores');
    const buffer = XLSX.write(workbook, {
      type: 'buffer',
      bookType: 'biff8',
    }) as Buffer;

    const result = await service.convertFile(mkFile('成绩表.xls', buffer));
    expect(result.title).toBe('成绩表');
    expect(result.markdown).toContain('## Scores');
    expect(result.markdown).toContain('| Name | Score |');
    expect(result.markdown).toContain('Alice');
  });

  it('旧版 .doc/.xls 已纳入白名单：.doc 损坏内容报「转换失败」而非「格式暂不支持」', async () => {
    expect(ALLOWED_EXTENSIONS).toEqual(
      expect.arrayContaining(['.doc', '.xls']),
    );
    await expect(
      service.convertFile(mkFile('broken.doc', Buffer.from('not a real doc'))),
    ).rejects.toThrow('文档转换失败');
  });

  it('旧版 .xls 内容签名校验：非 OLE/BIFF 文件应 400（2026-10-19 新增）', async () => {
    // 伪装成 .xls 的纯文本：既非 OLE 复合文档头，也非裸 BIFF BOF，应被魔数校验拒绝，
    // 避免 SheetJS 宽松解析产出垃圾表格
    await expect(
      service.convertFile(mkFile('fake.xls', Buffer.from('hello world'))),
    ).rejects.toThrow('不是有效的 .xls');
    // 白名单内的其它扩展名不走此校验（.md 正常转换）
    await expect(
      service.convertFile(
        mkFile('ok.md', Buffer.from('# 标题\n\n正文', 'utf8')),
      ),
    ).resolves.toMatchObject({ title: 'ok' });
  });

  // .doc 转换需要真实二进制样例；样例缺失（如无 test_files 的环境）时自动跳过
  const legacyDocPath = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'test_files',
    'upload',
    'sample_doc_legacy.doc',
  );
  const legacyDocIt = fs.existsSync(legacyDocPath) ? it : it.skip;
  legacyDocIt(
    '旧版 .doc 真实样例应提取纯文本（word-extractor，2026-10-19 扩充）',
    async () => {
      const buffer = fs.readFileSync(legacyDocPath);
      const result = await service.convertFile(
        mkFile('sample_doc_legacy.doc', buffer),
      );
      expect(result.title).toBe('sample_doc_legacy');
      expect(result.markdown).toContain('Population growth');
    },
  );
});
