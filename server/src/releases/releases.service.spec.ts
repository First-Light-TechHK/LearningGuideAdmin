import type { Prisma } from '@prisma/client';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ReleasesService } from './releases.service';
import { PrismaService } from '../prisma/prisma.service';
import { FilesService } from '../files/files.service';
import sharp from 'sharp';

/**
 * ReleasesService 单元测试（2026-10-16 扁平化：lessons → pages）。
 * 快照结构、versionTag 格式、**纯快照（不改 Live 指针）**、切换激活版本（重建 Page 草稿）、
 * isActive/isTestSelected 标注与删除版本（双保护）。
 */
describe('ReleasesService', () => {
  const mockTx = {
    $executeRaw: jest.fn(),
    course: { findUnique: jest.fn(), update: jest.fn() },
    courseAiConfig: { findUnique: jest.fn(), create: jest.fn() },
    release: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      delete: jest.fn(),
    },
    page: { deleteMany: jest.fn(), create: jest.fn() },
    knowledgeChunk: { count: jest.fn() },
  };
  const mockPrisma = {
    course: { findUnique: jest.fn() },
    release: { findMany: jest.fn(), findUnique: jest.fn() },
    $transaction: jest.fn((fn: (tx: typeof mockTx) => Promise<unknown>) =>
      fn(mockTx),
    ),
  };

  let service: ReleasesService;
  let mockIndexing: { indexRelease: jest.Mock };
  const mockFiles = { getImage: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    mockIndexing = {
      indexRelease: jest.fn().mockResolvedValue(undefined),
    };
    mockFiles.getImage.mockReset();
    service = new ReleasesService(
      mockPrisma as unknown as PrismaService,
      mockIndexing as never,
      mockFiles as never,
    );
  });

  it('publish：快照应含 pages 内容，versionTag 匹配 CourseName_YYYYMMDDHHmm，纯快照不改 Live 指针，且置 editingReleaseId（§3.4.3）', async () => {
    mockTx.course.findUnique.mockResolvedValue({
      id: 'c1',
      title: '数学基础',
      pages: [
        { id: 'p1', title: '第一章', contentMd: '# hi', sectionTags: null },
      ],
    });
    mockTx.release.create.mockImplementation(({ data }: { data: unknown }) =>
      Promise.resolve({ id: 'r1', ...(data as object) }),
    );

    const result = (await service.publish('c1', {
      revisionNotes: '首发',
    })) as { versionTag: string; snapshotData: unknown; revisionNotes: string };

    expect(result.versionTag).toMatch(/^数学基础_\d{12}$/);
    expect(result.snapshotData).toEqual({
      pages: [
        { id: 'p1', title: '第一章', contentMd: '# hi', sectionTags: null },
      ],
    });
    expect(result.revisionNotes).toBe('首发');
    // 纯快照：不改动 currentReleaseId；但置当前编辑版本指针 = 新 Release（2026-10-20 三次改拍）；
    // 课程尚无测试 / Live 版本时，首个 Release 同时成为测试所选版本（QA A6）
    expect(mockTx.course.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { editingReleaseId: 'r1', aiTestReleaseId: 'r1' },
    });
    expect(mockTx.courseAiConfig.create).not.toHaveBeenCalled();
    // 快照仅收录 SYNCED 节点：事务内查询条件应带 syncState 过滤
    const courseQuery = (
      mockTx.course.findUnique.mock.calls as Array<
        [Prisma.CourseFindUniqueArgs]
      >
    )[0][0];
    expect(JSON.stringify(courseQuery)).toContain('SYNCED');
  });

  it('publish：沿用 Live 版本的 AI 配置，且不改动已有测试所选版本（QA A3/A6）', async () => {
    mockTx.course.findUnique.mockResolvedValue({
      id: 'c1',
      title: '数学基础',
      currentReleaseId: 'live',
      aiTestReleaseId: 'test',
      pages: [],
    });
    mockTx.release.create.mockResolvedValue({ id: 'r9' });
    const source = {
      // lectureSystemPrompt 不再随 Release 复制（2026-10-29 A），新 Release 走模板兜底
      welcomeMsg: 'W',
      model: 'm',
      llmProvider: 'openrouter',
    };
    mockTx.courseAiConfig.findUnique.mockResolvedValue(source);

    await service.publish('c1', { revisionNotes: 'v2' });

    expect(
      (
        mockTx.courseAiConfig.findUnique.mock.calls as Array<
          [Prisma.CourseAiConfigFindUniqueArgs]
        >
      )[0][0].where,
    ).toEqual({
      courseId_releaseId: { courseId: 'c1', releaseId: 'live' },
    });
    expect(mockTx.courseAiConfig.create).toHaveBeenCalledWith({
      data: { ...source, courseId: 'c1', releaseId: 'r9' },
    });
    expect(mockTx.course.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { editingReleaseId: 'r9' },
    });
  });

  it('setLive / remove：校验前先锁 Course 行（QA A7）', async () => {
    mockTx.course.findUnique.mockResolvedValue({
      id: 'c1',
      currentReleaseId: null,
      aiTestReleaseId: null,
    });
    mockTx.release.findUnique.mockResolvedValue({
      id: 'r1',
      courseId: 'c1',
      versionTag: 'v1',
    });
    await service.setLive('c1', { releaseId: 'r1' });
    expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
    await service.remove('r1');
    expect(mockTx.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('publish：短时间内同说明、同快照的重复提交返回刚发布的版本（幂等）', async () => {
    mockTx.course.findUnique.mockResolvedValue({
      id: 'c1',
      title: 'Course',
      currentReleaseId: 'r1',
      aiTestReleaseId: 'r1',
      pages: [{ id: 'p1', title: 'L1', contentMd: 'x', sectionTags: [] }],
    });
    // jsonb 读回后的键顺序与写入时不同
    const previous = {
      id: 'r2',
      courseId: 'c1',
      revisionNotes: 'v2',
      createdAt: new Date(),
      snapshotData: {
        pages: [{ sectionTags: [], contentMd: 'x', title: 'L1', id: 'p1' }],
      },
    };
    mockTx.release.findFirst.mockResolvedValue(previous);

    const result = await service.publish('c1', { revisionNotes: 'v2' });

    expect(result).toBe(previous);
    expect(mockTx.$executeRaw).toHaveBeenCalled();
    expect(mockTx.release.create).not.toHaveBeenCalled();
    expect(mockTx.course.update).not.toHaveBeenCalled();
    expect(mockIndexing.indexRelease).not.toHaveBeenCalled();

    mockTx.release.findFirst.mockResolvedValue({
      ...previous,
      revisionNotes: 'other',
    });
    mockTx.release.create.mockResolvedValue({ id: 'r3' });
    await service.publish('c1', { revisionNotes: 'v2' });
    expect(mockTx.release.create).toHaveBeenCalledTimes(1);
  });

  it('publish：课程不存在时 404', async () => {
    mockTx.course.findUnique.mockResolvedValue(null);
    await expect(
      service.publish('missing', { revisionNotes: 'x' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('findAllByCourse：列表不含 snapshotData，且标注 isActive / isTestSelected / isEditing', async () => {
    mockPrisma.course.findUnique.mockResolvedValue({
      id: 'c1',
      currentReleaseId: 'r1',
      aiTestReleaseId: 'r2',
      editingReleaseId: 'r2',
    });
    mockPrisma.release.findMany.mockResolvedValue([
      { id: 'r1', versionTag: 'v1', revisionNotes: 'a', createdAt: 't1' },
      { id: 'r2', versionTag: 'v2', revisionNotes: 'b', createdAt: 't2' },
    ]);
    const list = await service.findAllByCourse('c1');
    expect(list.map((r) => r.isActive)).toEqual([true, false]);
    expect(list.map((r) => r.isTestSelected)).toEqual([false, true]);
    expect(list.map((r) => r.isEditing)).toEqual([false, true]);
    const select = (
      mockPrisma.release.findMany.mock.calls as Array<
        [Prisma.ReleaseFindManyArgs]
      >
    )[0][0] as {
      select: { snapshotData?: unknown };
    };
    expect(select.select.snapshotData).toBeUndefined();
  });

  it('remove：Live 版本拒绝删除 409（§3.4.5 双保护）', async () => {
    mockTx.release.findUnique.mockResolvedValue({
      id: 'r1',
      courseId: 'c1',
      versionTag: 'v1',
    });
    mockTx.course.findUnique.mockResolvedValue({
      currentReleaseId: 'r1',
      aiTestReleaseId: null,
    });
    await expect(service.remove('r1')).rejects.toThrow(ConflictException);
    expect(mockTx.release.delete).not.toHaveBeenCalled();
  });

  it('remove：后台测试所选版本拒绝删除 409（§3.4.5 双保护）', async () => {
    mockTx.release.findUnique.mockResolvedValue({
      id: 'r2',
      courseId: 'c1',
      versionTag: 'v2',
    });
    mockTx.course.findUnique.mockResolvedValue({
      currentReleaseId: 'r1',
      aiTestReleaseId: 'r2',
    });
    await expect(service.remove('r2')).rejects.toThrow(ConflictException);
    expect(mockTx.release.delete).not.toHaveBeenCalled();
  });

  it('remove：普通版本正常删除', async () => {
    mockTx.release.findUnique.mockResolvedValue({
      id: 'r3',
      courseId: 'c1',
      versionTag: 'v3',
    });
    mockTx.course.findUnique.mockResolvedValue({
      currentReleaseId: 'r1',
      aiTestReleaseId: 'r2',
    });
    const result = await service.remove('r3');
    expect(result).toEqual({ id: 'r3', versionTag: 'v3' });
    expect(mockTx.release.delete).toHaveBeenCalledWith({ where: { id: 'r3' } });
    // 非 editing 版本：不清空指针
    expect(mockTx.course.update).not.toHaveBeenCalled();
  });

  it('remove：删除当前编辑版本时清空 editingReleaseId 指针（§3.4.5 三次改拍）', async () => {
    mockTx.release.findUnique.mockResolvedValue({
      id: 'r3',
      courseId: 'c1',
      versionTag: 'v3',
    });
    mockTx.course.findUnique.mockResolvedValue({
      currentReleaseId: 'r1',
      aiTestReleaseId: 'r2',
      editingReleaseId: 'r3',
    });
    const result = await service.remove('r3');
    expect(result).toEqual({ id: 'r3', versionTag: 'v3' });
    expect(mockTx.course.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { editingReleaseId: null },
    });
  });

  it('remove：版本不存在 404', async () => {
    mockTx.release.findUnique.mockResolvedValue(null);
    await expect(service.remove('missing')).rejects.toThrow(NotFoundException);
  });

  it('activate：事务内重建 Page 草稿并置 editingReleaseId，不改动 currentReleaseId（§3.4.2 二次/三次改拍）', async () => {
    mockPrisma.course.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.release.findUnique.mockResolvedValue({
      id: 'r2',
      courseId: 'c1',
      versionTag: '数学基础_202610150000',
      snapshotData: {
        pages: [
          { id: 'p1', title: '第一章', contentMd: '# old', sectionTags: null },
          {
            id: 'p2',
            title: '第二章',
            contentMd: '# keep',
            sectionTags: { 'h1-sec': ['tag'] },
          },
        ],
      },
    });

    const result = await service.activate('c1', { releaseId: 'r2' });

    expect(result).toEqual({
      id: 'r2',
      versionTag: '数学基础_202610150000',
    });
    // 删除当前所有 Page
    expect(mockTx.page.deleteMany).toHaveBeenCalledWith({
      where: { courseId: 'c1' },
    });
    // 快照节点重建：2 pages，sortOrder 按快照顺序
    expect(mockTx.page.create).toHaveBeenCalledTimes(2);
    expect(
      (mockTx.page.create.mock.calls as Array<[Prisma.PageCreateArgs]>)[1][0]
        .data,
    ).toMatchObject({
      title: '第二章',
      contentMd: '# keep',
      sortOrder: 1,
    });
    // 仅恢复草稿并置当前编辑版本指针 = 该 Release；不改动 currentReleaseId（Live 只由 Set Live 变更）
    expect(mockTx.course.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { editingReleaseId: 'r2' },
    });
  });

  it('activate：releaseId 不属于该课程时 404，且不触碰事务', async () => {
    mockPrisma.course.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.release.findUnique.mockResolvedValue({
      id: 'r9',
      courseId: 'other',
    });
    await expect(service.activate('c1', { releaseId: 'r9' })).rejects.toThrow(
      NotFoundException,
    );
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  // —— exportZip（2026-10-30，仅打包 pages/*.md，无 manifest.json）——

  it('exportZip：ZIP 仅含每页一个 .md，丢弃 sectionTags，无 manifest.json', async () => {
    mockPrisma.release.findUnique.mockResolvedValue({
      id: 'r1',
      versionTag: '基础数学_202610301200',
      revisionNotes: '首发快照',
      createdAt: new Date('2026-10-30T12:00:00Z'),
      snapshotData: {
        pages: [
          {
            id: 'p1',
            title: '第一章 入门',
            contentMd: '# Intro\nhello',
            sectionTags: { 'h1-a': ['t1'] },
          },
          {
            id: 'p2',
            title: '第二章 进阶',
            contentMd: '# Advanced\nworld',
            sectionTags: null,
          },
        ],
      },
    });

    const { buffer, filename } = await service.exportZip('r1');

    expect(filename).toBe('基础数学_202610301200.zip');
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buffer);

    // 没有 manifest.json
    expect(zip.file('manifest.json')).toBeNull();

    // 只有两个 .md 文件（平铺在 ZIP 根目录，无 pages/ 子目录）
    const mdFiles = Object.keys(zip.files).filter((k) => k.endsWith('.md'));
    expect(mdFiles).toHaveLength(2);
    expect(mdFiles).toContain('第一章 入门.md');
    expect(mdFiles).toContain('第二章 进阶.md');

    const md1 = await zip.file('第一章 入门.md')!.async('string');
    expect(md1).toBe('# Intro\nhello');
    const md2 = await zip.file('第二章 进阶.md')!.async('string');
    expect(md2).toBe('# Advanced\nworld');
  });

  it('exportZip：空 pages 时 ZIP 内无 .md 文件、无 manifest', async () => {
    mockPrisma.release.findUnique.mockResolvedValue({
      id: 'r2',
      versionTag: 'Empty_202610300000',
      revisionNotes: '空的',
      createdAt: new Date(),
      snapshotData: { pages: [] },
    });

    const { buffer, filename } = await service.exportZip('r2');
    expect(filename).toBe('Empty_202610300000.zip');

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buffer);
    const mdFiles = Object.keys(zip.files).filter((k) => k.endsWith('.md'));
    expect(mdFiles).toHaveLength(0);
    expect(zip.file('manifest.json')).toBeNull();
  });

  it('exportZip：清洗后同名的页面添加后缀，保留所有内容', async () => {
    mockPrisma.release.findUnique.mockResolvedValue({
      id: 'r1',
      versionTag: 'v1',
      snapshotData: {
        pages: [
          { title: 'A/B', contentMd: 'first' },
          { title: 'a\\b', contentMd: 'second' },
          { title: 'A_B_2', contentMd: 'third' },
          { title: 'A:B', contentMd: 'fourth' },
        ],
      },
    });
    const { buffer } = await service.exportZip('r1');
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buffer);
    expect(await zip.file('A_B.md')!.async('string')).toBe('first');
    expect(await zip.file('a_b_2.md')!.async('string')).toBe('second');
    expect(await zip.file('A_B_2_2.md')!.async('string')).toBe('third');
    expect(await zip.file('A_B_3.md')!.async('string')).toBe('fourth');
  });

  it('exportZip：含图片页导出内嵌图片的 DOCX，无图页保持原始 MD', async () => {
    const asset = '11111111-1111-4111-8111-111111111111.png';
    const asset2 = '22222222-2222-4222-8222-222222222222.png';
    const png = await sharp({
      create: { width: 1, height: 1, channels: 4, background: '#ff0000' },
    })
      .png()
      .toBuffer();
    mockFiles.getImage.mockResolvedValue({
      bytes: png,
      contentType: 'image/png',
    });
    mockPrisma.release.findUnique.mockResolvedValue({
      id: 'r1',
      courseId: 'c1',
      versionTag: 'v1',
      snapshotData: {
        pages: [
          {
            title: '图文',
            contentMd: `# 向量\n\n| 名称 | 说明 |\n| --- | --- |\n| 向量 | 有方向 |\n\n**重点**，见图：![图](/api/files/images/c1/${asset})\n\n_Exhibit 1.2 A cup of coffee, 20 mg/oz_\n\n_展品 1.2 一杯咖啡，20 mg/oz_\n\n![第二图](/api/files/images/c1/${asset2})`,
          },
          { title: '纯文本', contentMd: '# 原样保留\n\n$x=1$' },
        ],
      },
    });

    const { buffer } = await service.exportZip('r1');
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buffer);
    expect(zip.file('图文.docx')).not.toBeNull();
    expect(await zip.file('纯文本.md')!.async('string')).toBe(
      '# 原样保留\n\n$x=1$',
    );
    const docx = await JSZip.loadAsync(
      await zip.file('图文.docx')!.async('nodebuffer'),
    );
    expect(
      Object.keys(docx.files).some((name) => name.startsWith('word/media/')),
    ).toBe(true);
    expect(await docx.file('word/document.xml')!.async('string')).toContain(
      '向量',
    );
    expect(await docx.file('word/document.xml')!.async('string')).toContain(
      '<w:tbl>',
    );
    expect(mockFiles.getImage).toHaveBeenCalledWith('c1', asset);
    expect(mockFiles.getImage).toHaveBeenCalledWith('c1', asset2);

    const storage = {
      putMedia: jest.fn().mockResolvedValue(undefined),
      removeMedia: jest.fn(),
    };
    const prisma = {
      course: { findUnique: jest.fn().mockResolvedValue({ id: 'c1' }) },
      knowledgeImageAsset: { create: jest.fn().mockResolvedValue(undefined) },
    };
    const converter = new FilesService(storage as never, prisma as never);
    const word = await zip.file('图文.docx')!.async('nodebuffer');
    const imported = await converter.convertFile(
      {
        originalname: '图文.docx',
        buffer: word,
        size: word.length,
      } as Express.Multer.File,
      'c1',
    );
    expect(imported.markdown).toContain('# 向量');
    expect(imported.markdown).toContain('**重点**');
    expect(imported.markdown).toMatch(
      /[_*]Exhibit 1\.2 A cup of coffee, 20 mg\/oz[_*]/,
    );
    expect(imported.markdown).toMatch(/[_*]展品 1\.2 一杯咖啡，20 mg\/oz[_*]/);
    expect(imported.markdown).not.toContain('\\_');
    expect(imported.markdown).toMatch(
      /!\[[^\]]*\]\(\/api\/files\/images\/c1\/[0-9a-f-]+\.png\)/,
    );
    expect(
      imported.markdown.match(/\/api\/files\/images\/c1\/[0-9a-f-]+\.png/g),
    ).toHaveLength(2);
  });

  it('exportZip：页面引用的图片已丢失时不生成缺图 DOCX', async () => {
    mockFiles.getImage.mockResolvedValue(null);
    mockPrisma.release.findUnique.mockResolvedValue({
      id: 'r1',
      courseId: 'c1',
      versionTag: 'v1',
      snapshotData: {
        pages: [
          {
            title: '图文',
            contentMd:
              '![图](/api/files/images/c1/11111111-1111-4111-8111-111111111111.png)',
          },
        ],
      },
    });
    await expect(service.exportZip('r1')).rejects.toThrow('图片');
  });

  it('exportZip：WebP 图片转成 Word 可嵌入的 PNG', async () => {
    const png = await sharp({
      create: { width: 1, height: 1, channels: 4, background: '#ff0000' },
    })
      .png()
      .toBuffer();
    mockFiles.getImage.mockResolvedValue({
      bytes: await sharp(png).webp().toBuffer(),
      contentType: 'image/webp',
    });
    mockPrisma.release.findUnique.mockResolvedValue({
      id: 'r1',
      courseId: 'c1',
      versionTag: 'v1',
      snapshotData: {
        pages: [
          {
            title: '图文',
            contentMd:
              '![图](/api/files/images/c1/11111111-1111-4111-8111-111111111111.webp)',
          },
        ],
      },
    });
    const { buffer } = await service.exportZip('r1');
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buffer);
    const docx = await JSZip.loadAsync(
      await zip.file('图文.docx')!.async('nodebuffer'),
    );
    expect(Object.keys(docx.files).some((name) => name.endsWith('.png'))).toBe(
      true,
    );
  });

  it('exportZip：代码块里的图片语法仍按无图 MD 原样导出', async () => {
    const markdown = '```md\n![示例](images/not-an-image.png)\n```';
    mockPrisma.release.findUnique.mockResolvedValue({
      id: 'r1',
      courseId: 'c1',
      versionTag: 'v1',
      snapshotData: { pages: [{ title: '代码', contentMd: markdown }] },
    });
    const { buffer } = await service.exportZip('r1');
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buffer);
    expect(await zip.file('代码.md')!.async('string')).toBe(markdown);
    expect(mockFiles.getImage).not.toHaveBeenCalled();
  });

  it('exportZip：不存在的 release 抛 404', async () => {
    mockPrisma.release.findUnique.mockResolvedValue(null);
    await expect(service.exportZip('missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('exportZip：文件名含非法字符时自动清洗', async () => {
    mockPrisma.release.findUnique.mockResolvedValue({
      id: 'r3',
      versionTag: 'Course/A*B"<>202610300000',
      revisionNotes: 'x',
      createdAt: new Date(),
      snapshotData: {
        pages: [
          {
            id: 'p1',
            title: 'page\\with/slash',
            contentMd: '# hi',
            sectionTags: null,
          },
        ],
      },
    });

    const { buffer, filename } = await service.exportZip('r3');
    // versionTag 里的非法字符被替换为 _
    expect(filename).toContain('_');
    expect(filename).not.toMatch(/[\\/:*?"<>|]/);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buffer);
    // md 文件直接平铺在 ZIP 根目录
    const pageFiles = Object.keys(zip.files).filter(
      (k) => !k.endsWith('/') && k.endsWith('.md'),
    );
    expect(pageFiles).toHaveLength(1);
    expect(pageFiles[0]).not.toMatch(/[\\:*?"<>|]/);
    expect(pageFiles[0]).toBe('page_with_slash.md');
  });
});
