import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { signInAs } from './helpers/employee-session';
import { PrismaService } from '../src/prisma/prisma.service';
import { MAX_FILE_SIZE } from '../src/files/files.service';
import * as XLSX from 'xlsx';

/**
 * 文档转换 e2e（开发文档 §5.1.5、§3.2.3 两步弹窗流程）。
 * 2026-10-16 扁平化：Page 直接挂 Course，无 Lesson 层。
 */
describe('Files API (e2e)', () => {
  let app: INestApplication<App>;
  let api: Awaited<ReturnType<typeof signInAs>>;
  let prisma: PrismaService;
  let courseId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    api = await signInAs(app);
    prisma = app.get(PrismaService);

    const course = await api
      .post('/api/courses')
      .send({ title: 'E2E-上传测试课程' })
      .expect(201);
    courseId = course.body.data.id;
  });

  afterAll(async () => {
    const courses = await prisma.course.findMany({
      where: { title: { startsWith: 'E2E-上传测试课程' } },
      select: { id: true },
    });
    const ids = courses.map((c) => c.id);
    if (ids.length > 0) {
      await prisma.release.deleteMany({ where: { courseId: { in: ids } } });
      await prisma.course.deleteMany({ where: { id: { in: ids } } });
    }
    await app.close();
  });

  it('POST /api/files/convert 上传 md 应返回 title+markdown 且不建页（§5.1.5）', async () => {
    const before = await prisma.page.count({ where: { courseId } });
    const res = await api
      .post('/api/files/convert')
      .attach(
        'file',
        Buffer.from(
          '# 极限与连续\n\n$\\lim_{x\\to 0}\\frac{\\sin x}{x}=1$',
          'utf8',
        ),
        { filename: '上传笔记.md', contentType: 'text/markdown' },
      )
      .expect(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.title).toBe('上传笔记');
    expect(res.body.data.markdown).toContain('极限与连续');
    // 转换阶段绝不建页
    expect(await prisma.page.count({ where: { courseId } })).toBe(before);
  });

  it('POST /api/files/convert 上传旧版 .xls 应返回 Markdown 表格（2026-10-19 扩充）', async () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Term', 'Definition'],
      ['Carrying capacity', 'Maximum sustainable population size'],
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Glossary');
    const buffer = XLSX.write(workbook, {
      type: 'buffer',
      bookType: 'biff8',
    }) as Buffer;

    const res = await api
      .post('/api/files/convert')
      .attach('file', buffer, { filename: '术语表.xls' })
      .expect(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.title).toBe('术语表');
    expect(res.body.data.markdown).toContain('## Glossary');
    expect(res.body.data.markdown).toContain('Carrying capacity');
  });

  it('上传伪装成 .xls 的非表格文件应 400（内容签名校验，2026-10-19）', async () => {
    const res = await api
      .post('/api/files/convert')
      .attach('file', Buffer.from('this is not a real xls'), {
        filename: 'fake.xls',
      })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('不是有效的 .xls');
  });

  it('完整两步流程：convert 预览 → Import 经 §5.1.2 建页并落库', async () => {
    const conv = await api
      .post('/api/files/convert')
      .attach('file', Buffer.from('# Import 测试\n\n内容', 'utf8'), {
        filename: 'import-doc.md',
        contentType: 'text/markdown',
      })
      .expect(201);
    const created = await api
      .post(`/api/courses/${courseId}/pages`)
      .send({ title: conv.body.data.title, contentMd: conv.body.data.markdown })
      .expect(201);
    expect(created.body.data.title).toBe('import-doc');
    expect(created.body.data.syncState).toBe('SYNCED');
    const page = await prisma.page.findUnique({
      where: { id: created.body.data.id },
    });
    expect(page?.courseId).toBe(courseId);
    expect(page?.contentMd).toContain('Import 测试');
  });

  it('上传白名单外扩展名（.exe）应 400 且提示支持格式（§10.1）', async () => {
    const res = await api
      .post('/api/files/convert')
      .attach('file', Buffer.from('MZ\x90\x00binary'), {
        filename: 'virus.exe',
      })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('格式暂不支持');
  });

  it('未附带 file 字段应 400', async () => {
    const res = await api.post('/api/files/convert').expect(400);
    expect(res.body.error.message).toContain('未选择文件');
  });

  it('超过 15MB 应 400（multer 超限经 413 映射，§10.1）', async () => {
    const res = await api
      .post('/api/files/convert')
      .attach('file', Buffer.alloc(MAX_FILE_SIZE + 1, 0x41), {
        filename: 'big.md',
        contentType: 'text/markdown',
      })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('15MB');
  });

  it('错误信封不泄露堆栈/内部路径（§9）', async () => {
    const res = await api
      .post('/api/files/convert')
      .attach('file', Buffer.from('garbage'), { filename: 'x.pdf' })
      .expect(400);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('at ');
    expect(text).not.toContain('node_modules');
    expect(res.body.error.message).not.toContain('MarkItDown');
  });
});
