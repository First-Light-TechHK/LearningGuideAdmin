import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { FilesService, ALLOWED_EXTENSIONS } from './files.service';

/**
 * FilesService 单元测试（§3.2.3/§10，两步流程改拍后）：白名单/空文件校验、
 * markitdown-ts 真实转换（md 直通）、返回 { title, markdown }（标题=文件名去扩展名）。
 */
describe('FilesService', () => {
  let service: FilesService;
  const storage = {
    putMedia: jest.fn(),
    getMedia: jest.fn(),
    removeMedia: jest.fn(),
  };
  const prisma = {
    course: { findUnique: jest.fn() },
    knowledgeImageAsset: {
      create: jest.fn(),
      findMany: jest.fn(),
      delete: jest.fn(),
    },
    page: { findMany: jest.fn() },
    release: { findMany: jest.fn() },
  };

  const mkFile = (name: string, buffer: Buffer): Express.Multer.File =>
    ({
      originalname: name,
      buffer,
      size: buffer.length,
    }) as Express.Multer.File;

  beforeEach(() => {
    storage.putMedia.mockReset().mockResolvedValue(undefined);
    storage.getMedia.mockReset();
    storage.removeMedia.mockReset();
    prisma.course.findUnique.mockReset().mockResolvedValue({ id: 'course-1' });
    prisma.knowledgeImageAsset.create.mockReset().mockResolvedValue(undefined);
    prisma.knowledgeImageAsset.findMany.mockReset().mockResolvedValue([]);
    prisma.knowledgeImageAsset.delete.mockReset().mockResolvedValue(undefined);
    prisma.page.findMany.mockReset().mockResolvedValue([]);
    prisma.release.findMany.mockReset().mockResolvedValue([]);
    service = new FilesService(storage as never, prisma as never);
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

  it('Knowledge 图片按课程持久化并返回稳定读取地址；非图片签名拒绝', async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    const result = await service.storeImage('course-1', mkFile('a.png', png));
    expect(result.url).toMatch(
      /^\/api\/files\/images\/course-1\/[0-9a-f-]+\.png$/,
    );
    expect(storage.putMedia).toHaveBeenCalledWith(
      expect.stringMatching(/^knowledge-pages\/course-1\/[0-9a-f-]+\.png$/),
      png,
    );
    expect(prisma.knowledgeImageAsset.create).toHaveBeenCalledTimes(1);
    await expect(
      service.storeImage(
        'course-1',
        mkFile('fake.png', Buffer.from('not png')),
      ),
    ).rejects.toThrow('仅支持');
  });

  it('清理只删除超过 24 小时且未被页面引用的图片', async () => {
    const old = new Date('2026-11-01T00:00:00Z');
    prisma.knowledgeImageAsset.findMany.mockResolvedValue([
      {
        id: 'unreferenced-id',
        courseId: 'course-1',
        storageKey: 'knowledge-pages/course-1/a.png',
        createdAt: old,
      },
      {
        id: 'referenced-id',
        courseId: 'course-1',
        storageKey: 'knowledge-pages/course-1/b.png',
        createdAt: old,
      },
    ]);
    prisma.page.findMany.mockResolvedValue([
      { contentMd: '![x](/api/files/images/course-1/referenced-id.png)' },
    ]);
    prisma.release.findMany.mockResolvedValue([
      {
        snapshotData: {
          pages: [
            { contentMd: '![x](/api/files/images/course-1/released-id.png)' },
          ],
        },
      },
    ]);
    prisma.knowledgeImageAsset.findMany.mockResolvedValueOnce([
      {
        id: 'unreferenced-id',
        courseId: 'course-1',
        storageKey: 'knowledge-pages/course-1/a.png',
        createdAt: old,
      },
      {
        id: 'referenced-id',
        courseId: 'course-1',
        storageKey: 'knowledge-pages/course-1/b.png',
        createdAt: old,
      },
      {
        id: 'released-id',
        courseId: 'course-1',
        storageKey: 'knowledge-pages/course-1/c.png',
        createdAt: old,
      },
    ]);

    await service.cleanupUnreferencedImages(new Date('2026-11-02T02:00:00Z'));

    expect(storage.removeMedia).toHaveBeenCalledTimes(1);
    expect(storage.removeMedia).toHaveBeenCalledWith(
      'knowledge-pages/course-1/a.png',
    );
    expect(prisma.knowledgeImageAsset.delete).toHaveBeenCalledTimes(1);
  });

  it('拒绝解压后单张图片超过 8 MB 的 DOCX', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('word/document.xml', '<w:document><w:body/></w:document>');
    zip.file('word/media/image1.png', Buffer.alloc(8 * 1024 * 1024 + 1));
    await expect(
      service.convertFile(
        mkFile('large.docx', await zip.generateAsync({ type: 'nodebuffer' })),
        'course-1',
      ),
    ).rejects.toThrow('DOCX 解压内容超过安全限制');
  });

  it('DOCX 转换生成的内嵌图片 data URI 会替换为持久化图片地址', async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    const zip = new JSZip();
    zip.file(
      'word/document.xml',
      '<w:document><a:blip r:embed="rId1"/></w:document>',
    );
    zip.file(
      'word/_rels/document.xml.rels',
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>',
    );
    zip.file('word/media/image1.png', png);
    const converter = service as unknown as {
      persistEmbeddedImages: (
        markdown: string,
        docx: Buffer,
        courseId: string,
      ) => Promise<string>;
    };
    const converted = await converter.persistEmbeddedImages(
      '![diagram](data:image/png;base64...)',
      await zip.generateAsync({ type: 'nodebuffer' }),
      'course-1',
    );
    expect(converted).toMatch(
      /^!\[diagram\]\(\/api\/files\/images\/course-1\/[0-9a-f-]+\.png\)$/,
    );
    expect(storage.putMedia).toHaveBeenCalledTimes(1);
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
