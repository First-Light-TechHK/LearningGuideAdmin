import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import sharp from 'sharp';
import {
  Document,
  ImageRun,
  Math as WordMath,
  MathFraction,
  MathRun,
  MathSuperScript,
  HeadingLevel,
  TextRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
} from 'docx';
import { FilesService, ALLOWED_EXTENSIONS } from './files.service';
import { prepareDocxMath } from './docx-math';

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
    tutorTeachingCard: { findMany: jest.fn() },
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
    prisma.tutorTeachingCard.findMany.mockReset().mockResolvedValue([]);
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

  it('tex 文件保留公式并转换章节、列表和强调', async () => {
    const source = String.raw`\documentclass{article}
\begin{document}
\section{极限}
正文 \textbf{重点} 与 $\lim_{x\to 0}x=0$。
\begin{itemize}
\item 第一项
\item 第二项
\end{itemize}
\[\frac{1}{2}\]
\end{document}`;
    const wireName = Buffer.from('公式.tex').toString('latin1');
    const result = await service.convertFile(
      mkFile(wireName, Buffer.from(source)),
    );
    expect(result.title).toBe('公式');
    expect(result.markdown).toContain('## 极限');
    expect(result.markdown).toContain('**重点**');
    expect(result.markdown).toContain('$\\lim_{x\\to 0}x=0$');
    expect(result.markdown).toContain('- 第一项');
    expect(result.markdown).toContain('$$\n\\frac{1}{2}\n$$');
  });

  it('tex 文件忽略排版间距，并保留未知命令和外部引用供预览', async () => {
    const source = String.raw`\section{标题}\vspace*{1em}正文 \unknown{重要内容}\input{other}`;
    const result = await service.convertFile(
      mkFile('commands.tex', Buffer.from(source)),
    );
    expect(result.markdown).toContain('## 标题');
    expect(result.markdown).not.toContain('\\vspace');
    expect(result.markdown).toContain('\\unknown{重要内容}');
    expect(result.markdown).toContain('\\input{other}');
  });

  it('tex 文件将文档标题、段落标题和段落分隔转为 Markdown', async () => {
    const source = String.raw`\documentclass{article}
\title{示例文章}
\begin{document}
\maketitle
\section{背景}
\paragraph{研究问题}第一段。\par 第二段。
\subparagraph{备注}更多内容。
\end{document}`;
    const result = await service.convertFile(
      mkFile('article.tex', Buffer.from(source)),
    );
    expect(result.markdown).toContain('# 示例文章');
    expect(result.markdown).toContain('## 背景');
    expect(result.markdown).toContain('##### 研究问题\n\n第一段。');
    expect(result.markdown).toContain('第一段。\n\n第二段。');
    expect(result.markdown).toContain('###### 备注\n\n更多内容。');
    expect(result.markdown).not.toContain('\\maketitle');
  });

  it('tex 文件读取嵌套格式命令中的标题', async () => {
    const source = String.raw`\title{\textbf{**Equations for Lesson 3**}}
\begin{document}
\maketitle
正文。
\end{document}`;
    const result = await service.convertFile(
      mkFile('lesson.tex', Buffer.from(source)),
    );
    expect(result.markdown).toBe('# Equations for Lesson 3\n\n正文。');
  });

  it('tex 文件转换编辑器复制的完整公式片段', async () => {
    const source = String.raw`\title{\textbf{**Equations for Lesson 3**}}
\author{}
\date{}

\begin{document}

¤ ¤\maketitle
¤ ¤\vspace{-2em}

¤ ¤% --------------------------------------------------
¤ ¤\paragraph{1. General dynamic system (calculus notation)}
¤ ¤\\[
¤ ¤\frac{dy}{dt} = f(x, u, t)
¤ ¤\\]

¤ ¤% --------------------------------------------------
\end{document}`.replaceAll('¤', '\u00a0');
    const result = await service.convertFile(
      mkFile('lesson.tex', Buffer.from(source)),
    );
    expect(result.markdown).toBe(
      '# Equations for Lesson 3\n\n##### 1. General dynamic system (calculus notation)\n\n$$\n\\frac{dy}{dt} = f(x, u, t)\n$$',
    );
  });

  it('tex 文件转换常见文本和版式命令', async () => {
    const source = String.raw`\section{概述}\label{sec:intro}
\begin{abstract}\textsc{摘要} \underline{重要} \texttt{code}\end{abstract}
第一行\newline 第二行`;
    const result = await service.convertFile(
      mkFile('common.tex', Buffer.from(source)),
    );
    expect(result.markdown).toContain('## 概述');
    expect(result.markdown).not.toContain('\\label');
    expect(result.markdown).toContain('**摘要** **重要** `code`');
    expect(result.markdown).toContain('第一行\n 第二行');
  });

  it('tex 文件转换扩展展示公式环境', async () => {
    const source = String.raw`\begin{multline*}
a+b=c
\end{multline*}`;
    const result = await service.convertFile(
      mkFile('formula.tex', Buffer.from(source)),
    );
    expect(result.markdown).toBe(
      '$$\n\\begin{aligned}\na+b=c\n\\end{aligned}\n$$',
    );
  });

  it('tex 文件保留 align 环境的对齐语义', async () => {
    const source = String.raw`\begin{align*}
\vec{u} &= [4, \, 1] \\
\vec{v} &= [2, \, 3]
\end{align*}`;
    const result = await service.convertFile(
      mkFile('aligned.tex', Buffer.from(source)),
    );
    expect(result.markdown).toContain('$$\n\\begin{aligned}\n');
    expect(result.markdown).toContain(String.raw`\vec{u} &= [4, \, 1] \\`);
    expect(result.markdown).toContain('\\end{aligned}\n$$');
  });

  it('tex 文件转换引用、脚注、引用块和简单表格', async () => {
    const source = String.raw`\section{Document structure}\label{sec:structure}
See Section~\ref{sec:structure}. This \footnote{Footnote content should remain visible.}
uses a footnote command.
\begin{quote}
Quoted source text should remain visible for review.
\end{quote}
\begin{tabular}{ll}
Term & Meaning \\
ODE & Ordinary differential equation
\end{tabular}`;
    const result = await service.convertFile(
      mkFile('review.tex', Buffer.from(source)),
    );
    expect(result.markdown).toContain(
      'See Section Document structure. This (Note: Footnote content should remain visible.)',
    );
    expect(result.markdown).toContain(
      '> Quoted source text should remain visible for review.',
    );
    expect(result.markdown).toContain(
      '| Term | Meaning |\n| --- | --- |\n| ODE | Ordinary differential equation |',
    );
    expect(result.markdown).not.toContain('\\begin{tabular}');
  });

  it('tex 文件非法 UTF-8 仍拒绝', async () => {
    await expect(
      service.convertFile(mkFile('bad.tex', Buffer.from([0xff]))),
    ).rejects.toThrow(BadRequestException);
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
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#123456' },
    })
      .png()
      .toBuffer();
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
    ).rejects.toThrow('图片已损坏或格式不受支持');
  });

  it('校验图片大小边界，允许大于旧上限的图片', async () => {
    const under = await sharp({
      create: { width: 1500, height: 1500, channels: 3, background: '#123456' },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(under.length).toBeGreaterThan(5 * 1024 * 1024);
    const over = Buffer.alloc(20 * 1024 * 1024 + 1);
    await expect(
      service.storeImage('course-1', mkFile('under.png', under)),
    ).resolves.toHaveProperty('url');
    await expect(
      service.storeImage('course-1', mkFile('over.png', over)),
    ).rejects.toThrow('20 MiB');
    expect(storage.putMedia).toHaveBeenCalledTimes(1);
  });

  it.each(['heic', 'heif'])(
    '解码 HEVC .%s 上传并保存主图的 PNG 像素',
    async (extension) => {
      // Synthetic 32×24 red frame encoded as HEVC and wrapped in a HEIF container.
      const input = fs.readFileSync(
        path.join(__dirname, 'fixtures/red-32x24.heic'),
      );
      expect((await sharp(input).metadata()).compression).toBe('hevc');
      const result = await service.storeImage(
        'course-1',
        mkFile(`red.${extension}`, input),
      );
      expect(result.url.endsWith('.png')).toBe(true);
      const [, preview] = storage.putMedia.mock.calls[0] as [string, Buffer];
      expect(await sharp(preview).metadata()).toMatchObject({
        format: 'png',
        width: 32,
        height: 24,
      });
      const pixels = await sharp(preview).removeAlpha().raw().toBuffer();
      expect(pixels[0]).toBeGreaterThan(220);
      expect(pixels[1]).toBeLessThan(25);
      expect(pixels[2]).toBeLessThan(25);
    },
  );

  const raster = () =>
    sharp({
      create: { width: 2, height: 2, channels: 4, background: '#12345678' },
    });
  const bitmap = Buffer.from(
    'Qk0+AAAAAAAAADYAAAAoAAAAAgAAAAEAAAABABgAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAA',
    'base64',
  );
  it.each([
    ['sample.jfif', 'jpg', true, () => raster().jpeg().toBuffer()],
    [
      'animated.apng',
      'png',
      true,
      () =>
        Buffer.from(
          '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',
          'base64',
        ),
    ],
    ['sample.avif', 'png', false, () => raster().avif().toBuffer()],
    ['sample.bmp', 'png', false, () => bitmap],
    ['sample.dib', 'png', false, () => bitmap.subarray(14)],
    ['sample.tiff', 'png', false, () => raster().tiff().toBuffer()],
    [
      'transparent.svg',
      'png',
      false,
      () =>
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="1" height="1" fill="green"/></svg>',
        ),
    ],
  ] as const)(
    '上传 %s 后写入可预览的 %s',
    async (name, extension, preserve, fixture) => {
      const input = await fixture();
      const result = await service.storeImage('course-1', mkFile(name, input));
      expect(result.url.endsWith(`.${extension}`)).toBe(true);
      const [key, bytes] = storage.putMedia.mock.calls[0] as [string, Buffer];
      expect(key.endsWith(`.${extension}`)).toBe(true);
      if (preserve) expect(bytes.equals(input)).toBe(true);
      else
        expect(
          bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
        ).toBe(true);
    },
  );

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

  it('课程草稿已清空时保留只有旧 Release 快照引用的图片', async () => {
    prisma.knowledgeImageAsset.findMany.mockResolvedValue([
      {
        id: 'old-release-image',
        courseId: 'course-1',
        storageKey: 'knowledge-pages/course-1/old.png',
        createdAt: new Date('2026-11-01T00:00:00Z'),
      },
    ]);
    prisma.page.findMany.mockResolvedValue([]);
    prisma.release.findMany.mockResolvedValue([
      { snapshotData: { pages: [] } },
      {
        snapshotData: {
          pages: [
            {
              contentMd:
                '![旧图](/api/files/images/course-1/old-release-image.png)',
            },
          ],
        },
      },
    ]);

    await service.cleanupUnreferencedImages(new Date('2026-11-03T00:00:00Z'));

    expect(prisma.release.findMany).toHaveBeenCalledWith({
      where: { courseId: 'course-1' },
      select: { snapshotData: true },
    });
    expect(storage.removeMedia).not.toHaveBeenCalled();
    expect(prisma.knowledgeImageAsset.delete).not.toHaveBeenCalled();
  });

  it('保留只有旧 Release 教学包引用的图片', async () => {
    const id = 'b93daf8a-0e57-466d-9431-f04dc7e80805';
    prisma.knowledgeImageAsset.findMany.mockResolvedValue([
      {
        id,
        courseId: 'course-1',
        storageKey: `knowledge-pages/course-1/${id}.png`,
        createdAt: new Date('2026-11-01T00:00:00Z'),
      },
    ]);
    prisma.page.findMany.mockResolvedValue([]);
    prisma.release.findMany.mockResolvedValue([
      {
        snapshotData: {
          pages: [],
          teachingPackage: {
            cards: [
              {
                approvedPayload: {
                  refObjects: [{ kind: 'image', value: `${id}.png` }],
                },
              },
            ],
          },
        },
      },
    ]);
    await service.cleanupUnreferencedImages(new Date('2026-11-03T00:00:00Z'));
    expect(storage.removeMedia).not.toHaveBeenCalled();
    expect(prisma.knowledgeImageAsset.delete).not.toHaveBeenCalled();
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

  it('DOCX 标题保留两个独立公式，分式和导数不会合并或被 Markdown 转义', async () => {
    const fraction = new MathFraction({
      numerator: [new MathRun('df')],
      denominator: [new MathRun('dt')],
    });
    const prime = new MathSuperScript({
      children: [new MathRun('f')],
      superScript: [new MathRun("'")],
    });
    const buffer = await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              new Paragraph({
                heading: HeadingLevel.HEADING_4,
                children: [
                  new TextRun('1. Rate of change ('),
                  new WordMath({ children: [fraction] }),
                  new TextRun(' and '),
                  new WordMath({ children: [prime, new MathRun('(x)')] }),
                  new TextRun(')'),
                ],
              }),
            ],
          },
        ],
      }),
    );
    const { markdown } = await service.convertFile(
      mkFile('lesson.docx', buffer),
    );
    expect(markdown).toBe(
      '#### 1\\. Rate of change ($\\frac{df}{dt}$ and ${f}^{\\prime}(x)$)',
    );
  });

  const docxWithEquation = async (equation: string) => {
    const base = await Packer.toBuffer(
      new Document({ sections: [{ children: [new Paragraph('Equation')] }] }),
    );
    const zip = await JSZip.loadAsync(base);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file(
      'word/document.xml',
      xml.replace(/<w:r><w:t[^>]*>Equation<\/w:t><\/w:r>/, () => equation),
    );
    return zip.generateAsync({ type: 'nodebuffer' });
  };

  it('DOCX 独立公式保留矩阵、根号、下标和向量结构', async () => {
    const run = (s: string) => `<m:r><m:t>${s}</m:t></m:r>`;
    const root = `<m:rad><m:deg/><m:e>${run('2')}</m:e></m:rad>`;
    const vector = `<m:acc><m:accPr><m:chr m:val="⃗"/></m:accPr><m:e>${run('D')}</m:e></m:acc>`;
    const sub = `<m:sSub><m:e>${vector}</m:e><m:sub>${run('1')}</m:sub></m:sSub>`;
    const row = (s: string) => `<m:mr><m:e>${s}</m:e></m:mr>`;
    const matrix = `<m:m>${row(root)}${row(run('0'))}</m:m>`;
    const buffer = await docxWithEquation(
      `<m:oMathPara><m:oMath>${sub}${run('=')}<m:d><m:e>${matrix}</m:e></m:d></m:oMath></m:oMathPara>`,
    );
    const { markdown } = await service.convertFile(
      mkFile('vectors.docx', buffer),
    );
    expect(markdown).toBe(
      '$$\n{\\vec{D}}_{1}=\\left(\\begin{matrix}{\\sqrt{2}} \\\\ {0}\\end{matrix}\\right)\n$$',
    );
  });

  it('中间转换器漏掉公式时拒绝返回成功结果', async () => {
    const buffer = await docxWithEquation(
      '<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>',
    );
    const prepared = await prepareDocxMath(
      await JSZip.loadAsync(buffer),
      buffer,
    );
    expect(() => prepared.restore('only text survived')).toThrow(
      'DOCX 公式导入不完整（0/1）',
    );
  });

  it('DOCX 含未支持的公式时明确提示，避免导入看似完整的残缺页面', async () => {
    const buffer = await docxWithEquation(
      '<m:oMath><m:groupChr><m:e><m:r><m:t>x</m:t></m:r></m:e></m:groupChr></m:oMath>',
    );
    await expect(
      service.convertFile(mkFile('expression.docx', buffer)),
    ).rejects.toThrow('Word 公式结构（groupChr）');
  });

  const docxWithImages = async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    );
    const picture = () =>
      new ImageRun({
        type: 'png',
        data: png,
        transformation: { width: 10, height: 10 },
      });
    return Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              new Paragraph({ children: [picture()] }),
              new Table({
                rows: [
                  new TableRow({
                    children: [
                      new TableCell({
                        children: [
                          new Paragraph({
                            children: [
                              new TextRun('阅读时间：'),
                              new WordMath({ children: [new MathRun('t')] }),
                            ],
                          }),
                          new Paragraph({
                            children: [picture(), picture()],
                            bullet: { level: 0 },
                          }),
                        ],
                      }),
                      new TableCell({
                        children: [new Paragraph('第21回：唐僧渡过沙河。')],
                      }),
                    ],
                  }),
                ],
              }),
            ],
          },
        ],
      }),
    );
  };

  it('DOCX 中文与复杂表格保留，表格内外每张图片均替换为可预览的持久化地址', async () => {
    const result = await service.convertFile(
      mkFile('阅读任务.docx', await docxWithImages()),
      'course-1',
    );
    expect(result.title).toBe('阅读任务');
    expect(result.markdown).toContain('阅读时间：');
    expect(result.markdown).toContain('第21回：唐僧渡过沙河。');
    expect(result.markdown).toContain('<table>');
    expect(result.markdown).toContain(
      '<code class="language-math math-inline">t</code>',
    );
    const urls = result.markdown.match(
      /\/api\/files\/images\/course-1\/[0-9a-f-]+\.png/g,
    );
    expect(urls).toHaveLength(3);
    expect(result.markdown).not.toContain('data:image');
    expect(result.markdown).not.toContain('/knowledge-import-images/');
    expect(storage.putMedia).toHaveBeenCalledTimes(3);
  });

  it('含图片 DOCX 没有课程时拒绝导入，不写入图片文件', async () => {
    await expect(
      service.convertFile(mkFile('images.docx', await docxWithImages())),
    ).rejects.toThrow('DOCX 含图片，请从 Knowledge Pages 课程中导入');
    expect(storage.putMedia).not.toHaveBeenCalled();
  });

  it('DOCX 图片存储失败时拒绝导入，不返回缺图文档', async () => {
    storage.putMedia.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(
      service.convertFile(
        mkFile('images.docx', await docxWithImages()),
        'course-1',
      ),
    ).rejects.toThrow('文档转换失败');
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
