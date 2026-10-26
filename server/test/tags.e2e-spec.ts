import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { signInAs } from './helpers/employee-session';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Tags API e2e（§5.1.6 / §3.3.3 方案 B）。
 * 覆盖 GET / POST / PUT / DELETE 全流程 + 校验：
 * - 列表、创建（含可选 color）、改色、删除
 * - 重复创建幂等
 * - 非法 color 校验 400
 * - 删除不存在的 tag 仍成功（幂等）
 */
describe('Tags API (e2e)', () => {
  let app: INestApplication<App>;
  let api: Awaited<ReturnType<typeof signInAs>>;
  let prisma: PrismaService;

  const TEST_TAG_PREFIX = 'E2E-Tag-';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    api = await signInAs(app);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    // 清理 e2e 创建的 tag
    await prisma.tag.deleteMany({
      where: { name: { startsWith: TEST_TAG_PREFIX } },
    });
    await app.close();
  });

  it('GET /api/tags 应返回统一响应格式且 data 为数组', async () => {
    const res = await api.get('/api/tags').expect(200);
    expect(res.body).toEqual(
      expect.objectContaining({ success: true, error: null }),
    );
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('POST /api/tags 不传 color 应自动分配颜色', async () => {
    const name = `${TEST_TAG_PREFIX}AutoColor`;
    const res = await api.post('/api/tags').send({ name }).expect(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.name).toBe(name);
    expect(res.body.data.color).toBeDefined();
    expect(typeof res.body.data.color).toBe('string');
  });

  it('POST /api/tags 传 color 应使用指定颜色', async () => {
    const name = `${TEST_TAG_PREFIX}CustomColor`;
    const res = await api
      .post('/api/tags')
      .send({ name, color: 'red' })
      .expect(201);
    expect(res.body.data.color).toBe('red');
  });

  it('POST /api/tags 重复创建应幂等返回已有记录', async () => {
    const name = `${TEST_TAG_PREFIX}Idempotent`;
    const res1 = await api.post('/api/tags').send({ name }).expect(201);
    const res2 = await api.post('/api/tags').send({ name }).expect(201);
    expect(res2.body.data.id).toBe(res1.body.data.id);
  });

  it('POST /api/tags 空 name 应 400', async () => {
    const res = await api.post('/api/tags').send({ name: '   ' }).expect(400);
    expect(res.body.success).toBe(false);
  });

  it('POST /api/tags 非法 color 应 400', async () => {
    const res = await api
      .post('/api/tags')
      .send({ name: `${TEST_TAG_PREFIX}BadColor`, color: 'not-a-color' })
      .expect(400);
    expect(res.body.success).toBe(false);
  });

  it('PUT /api/tags/:name 应更新颜色', async () => {
    const name = `${TEST_TAG_PREFIX}UpdateMe`;
    // 先创建
    await api.post('/api/tags').send({ name, color: 'blue' }).expect(201);
    // 改色
    const res = await api
      .put(`/api/tags/${encodeURIComponent(name)}`)
      .send({ color: 'green' })
      .expect(200);
    expect(res.body.data.color).toBe('green');
  });

  it('PUT /api/tags/:name 不存在的 tag 应 404', async () => {
    const res = await api
      .put(`/api/tags/${TEST_TAG_PREFIX}NotExist`)
      .send({ color: 'red' })
      .expect(404);
    expect(res.body.success).toBe(false);
  });

  it('PUT /api/tags/:name 非法 color 应 400', async () => {
    const name = `${TEST_TAG_PREFIX}BadUpdate`;
    await api.post('/api/tags').send({ name }).expect(201);
    const res = await api
      .put(`/api/tags/${encodeURIComponent(name)}`)
      .send({ color: 'invalid' })
      .expect(400);
    expect(res.body.success).toBe(false);
  });

  it('DELETE /api/tags/:name 应删除成功', async () => {
    const name = `${TEST_TAG_PREFIX}DeleteMe`;
    await api.post('/api/tags').send({ name }).expect(201);
    const res = await api
      .delete(`/api/tags/${encodeURIComponent(name)}`)
      .expect(200);
    expect(res.body.success).toBe(true);
    // 确认已删除
    const list = await api.get('/api/tags');
    expect(
      list.body.data.find((t: { name: string }) => t.name === name),
    ).toBeUndefined();
  });

  it('DELETE /api/tags/:name 不存在的 tag 仍返回 success（幂等）', async () => {
    const res = await api
      .delete(`/api/tags/${TEST_TAG_PREFIX}NeverExisted`)
      .expect(200);
    expect(res.body.success).toBe(true);
  });
});
