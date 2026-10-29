import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { signInAs } from './helpers/employee-session';
import { PrismaService } from '../src/prisma/prisma.service';
import { CatalogueSourceService } from '../src/sync/catalogue-source.service';

/**
 * 假同步数据源（2026-10-26）：同步数据源已改为 KS 内置课程 ID 映射表，
 * e2e 通过覆盖 `CatalogueSourceService` 注入带 lesson 结构的假课程，
 * 以继续覆盖「标题同步 + 课时建页」算法，同时不依赖任何外部服务。
 */
const PORTAL_COURSES = [
  {
    externalId: 'ext-quantum-001',
    title: 'Quantum Basics',
    description: 'Introduction to quantum mechanics',
    sections: [
      {
        externalId: 'sec-foundations',
        title: 'Foundations',
        lessons: [
          { externalId: 'lesson-foundations', title: 'Foundations', pages: [] },
        ],
      },
    ],
    lessons: [
      { externalId: 'lesson-foundations', title: 'Foundations', pages: [] },
    ],
  },
];
const fakeCatalogueSource = {
  listCourses: async () => PORTAL_COURSES,
  getCourse: async (externalId: string) =>
    PORTAL_COURSES.find((c) => c.externalId === externalId),
};

/**
 * Knowledge System 后端全流程 e2e（开发文档 §5.1、§5.3）。
 * 2026-10-16 扁平化：Course → Page 两级（原 Lesson → Page 合并）。
 */
describe('Knowledge API (e2e)', () => {
  let app: INestApplication<App>;
  let api: Awaited<ReturnType<typeof signInAs>>;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CatalogueSourceService)
      .useValue(fakeCatalogueSource)
      .compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    api = await signInAs(app);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    const courses = await prisma.course.findMany({
      where: {
        OR: [
          { title: { startsWith: 'E2E-' } },
          { externalId: 'ext-quantum-001' },
        ],
      },
      select: { id: true },
    });
    const ids = courses.map((c) => c.id);
    if (ids.length > 0) {
      await prisma.release.deleteMany({ where: { courseId: { in: ids } } });
      await prisma.course.deleteMany({ where: { id: { in: ids } } });
    }
    await app.close();
  });

  let courseId: string;
  let pageId: string;
  let releaseId: string;

  it('POST /api/courses 创建课程', async () => {
    const res = await api
      .post('/api/courses')
      .send({ title: 'E2E-测试课程', description: 'e2e 自动化' })
      .expect(201);
    expect(res.body).toEqual(expect.objectContaining({ success: true }));
    courseId = res.body.data.id;
    expect(courseId).toBeDefined();
  });

  it('POST /api/courses 缺少 title 应 400 VALIDATION_ERROR', async () => {
    const res = await api
      .post('/api/courses')
      .send({ description: '无标题' })
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.data).toBeNull();
  });

  it('GET /api/courses 列表包含新创建课程', async () => {
    const res = await api.get('/api/courses').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.some((c: { id: string }) => c.id === courseId)).toBe(
      true,
    );
  });

  it('PUT /api/courses/:id 更新课程', async () => {
    const res = await api
      .put(`/api/courses/${courseId}`)
      .send({ description: '更新后的描述' })
      .expect(200);
    expect(res.body.data.description).toBe('更新后的描述');
  });

  it('PUT /api/courses/:id 课程不存在应 404 NOT_FOUND', async () => {
    const res = await api
      .put('/api/courses/00000000-0000-0000-0000-000000000000')
      .send({ description: 'x' })
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('POST /api/courses/:courseId/pages 创建页面（含 contentMd 与 sectionTags，§5.1.2）', async () => {
    const res = await api
      .post(`/api/courses/${courseId}/pages`)
      .send({
        title: 'Introduction',
        contentMd: '# Overview\n\n公式 $E=mc^2$',
        sectionTags: { 'h1-overview': ['Core Knowledge'] },
      })
      .expect(201);
    pageId = res.body.data.id;
    expect(res.body.data.contentMd).toContain('E=mc^2');
    expect(res.body.data.sortOrder).toBe(0);
  });

  it('GET /api/courses/:id 详情应含 Pages（§5.1.1）', async () => {
    const res = await api.get(`/api/courses/${courseId}`).expect(200);
    expect(res.body.data.pages[0].id).toBe(pageId);
  });

  it('GET /api/pages/:id 返回 contentMd', async () => {
    const res = await api.get(`/api/pages/${pageId}`).expect(200);
    expect(res.body.data.title).toBe('Introduction');
  });

  it('PUT /api/pages/:id 更新内容与 sectionTags', async () => {
    const res = await api
      .put(`/api/pages/${pageId}`)
      .send({
        contentMd: '# 更新',
        sectionTags: { 'h1-geng-xin': ['Teaching Guidance'] },
        sortOrder: 1,
      })
      .expect(200);
    expect(res.body.data.contentMd).toBe('# 更新');
  });

  it('PUT /api/courses/:courseId/pages/reorder 批量重排 Page 顺序（§5.1.2，2026-10-19 新增）', async () => {
    const extra = await api
      .post(`/api/courses/${courseId}/pages`)
      .send({ title: 'Extensions', contentMd: '# Extensions' })
      .expect(201);
    const extraId = extra.body.data.id as string;

    await api
      .put(`/api/courses/${courseId}/pages/reorder`)
      .send({ orderedIds: [extraId, pageId] })
      .expect(200);

    const detail = await api.get(`/api/courses/${courseId}`).expect(200);
    expect(detail.body.data.pages.map((p: { id: string }) => p.id)).toEqual([
      extraId,
      pageId,
    ]);
    expect(
      detail.body.data.pages.map((p: { sortOrder: number }) => p.sortOrder),
    ).toEqual([0, 1]);

    // 还原顺序并删除临时页，避免影响后续发布快照断言
    await api
      .put(`/api/courses/${courseId}/pages/reorder`)
      .send({ orderedIds: [pageId, extraId] })
      .expect(200);
    await api.delete(`/api/pages/${extraId}`).expect(200);
  });

  it('PUT /api/courses/:courseId/pages/reorder 非完整排列应 400 VALIDATION_ERROR', async () => {
    const res = await api
      .put(`/api/courses/${courseId}/pages/reorder`)
      .send({ orderedIds: ['00000000-0000-0000-0000-000000000000'] })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('PUT /api/courses/:courseId/pages/reorder 含重复 id 应 400 VALIDATION_ERROR', async () => {
    // 造 2 个 Page，使 orderedIds 长度等于页数但含重复，命中重复校验分支
    const extra = await api
      .post(`/api/courses/${courseId}/pages`)
      .send({ title: 'Extensions-Dup', contentMd: '# Dup' })
      .expect(201);
    const extraId = extra.body.data.id as string;

    const res = await api
      .put(`/api/courses/${courseId}/pages/reorder`)
      .send({ orderedIds: [pageId, pageId] })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');

    await api.delete(`/api/pages/${extraId}`).expect(200);
  });

  it('PUT /api/courses/:courseId/pages/reorder 空数组应 400 VALIDATION_ERROR', async () => {
    const res = await api
      .put(`/api/courses/${courseId}/pages/reorder`)
      .send({ orderedIds: [] })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('PUT /api/courses/:courseId/pages/reorder 课程不存在应 404 NOT_FOUND', async () => {
    const res = await api
      .put('/api/courses/00000000-0000-0000-0000-000000000000/pages/reorder')
      .send({ orderedIds: ['00000000-0000-0000-0000-000000000000'] })
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('POST /api/courses/:id/release 发布快照（§5.1.3）', async () => {
    const res = await api
      .post(`/api/courses/${courseId}/release`)
      .send({ revisionNotes: 'e2e 首发' })
      .expect(201);
    releaseId = res.body.data.id;
    expect(res.body.data.versionTag).toMatch(/^E2E-测试课程_\d{12}$/);
    expect(res.body.data.snapshotData.pages[0].contentMd).toBe('# 更新');
  });

  it('POST /api/courses/:id/release 缺 revisionNotes 应 400', async () => {
    const res = await api
      .post(`/api/courses/${courseId}/release`)
      .send({})
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /api/courses/:id/releases 历史列表不含 snapshotData；纯快照发布后 isActive=false、isEditing=true，首个 Release 即测试所选（§3.4.3，QA A6）', async () => {
    const res = await api.get(`/api/courses/${courseId}/releases`).expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].snapshotData).toBeUndefined();
    // 纯快照：Create Release 不改动 Live 指针（2026-10-20 改拍）
    expect(res.body.data[0].isActive).toBe(false);
    // 课程此前没有测试 / Live 版本：首个 Release 自动作为 AI Tutor 测试所选版本（QA 2026-10-27 A6）
    expect(res.body.data[0].isTestSelected).toBe(true);
    // 新建 Release 落在新版本 → editing（2026-10-20 三次改拍）
    expect(res.body.data[0].isEditing).toBe(true);
  });

  it('POST /api/courses/:id/set-live 设为上线版本后 isActive=true（§3.4.4）', async () => {
    await api
      .post(`/api/courses/${courseId}/set-live`)
      .send({ releaseId })
      .expect(201);
    const res = await api.get(`/api/courses/${courseId}/releases`).expect(200);
    expect(
      res.body.data.find((r: { id: string }) => r.id === releaseId).isActive,
    ).toBe(true);
  });

  it('DELETE /api/releases/:releaseId Live 版本应 409 CONFLICT（§3.4.5 双保护）', async () => {
    const res = await api.delete(`/api/releases/${releaseId}`).expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('GET /api/releases/:releaseId 快照详情', async () => {
    const res = await api.get(`/api/releases/${releaseId}`).expect(200);
    expect(res.body.data.revisionNotes).toBe('e2e 首发');
    expect(res.body.data.snapshotData.pages).toBeDefined();
  });

  it('POST /api/courses/:id/activate-release 仅恢复快照到草稿，不改 Live 指针、置 editing（§3.4.2 二次/三次改拍）', async () => {
    await api
      .put(`/api/pages/${pageId}`)
      .send({ contentMd: '# v2 草稿内容' })
      .expect(200);
    const v2 = await api
      .post(`/api/courses/${courseId}/release`)
      .send({ revisionNotes: 'e2e 二发' })
      .expect(201);
    const v2Id = v2.body.data.id as string;

    // 先把 Live 指向 v2（set-live），以确保后续能验证 activate 未改动 Live 指针
    await api
      .post(`/api/courses/${courseId}/set-live`)
      .send({ releaseId: v2Id })
      .expect(201);

    // 切换到此版本（releaseId 快照）→ 仅重建草稿
    const act = await api
      .post(`/api/courses/${courseId}/activate-release`)
      .send({ releaseId })
      .expect(201);
    expect(act.body.data.id).toBe(releaseId);

    const detail = await api.get(`/api/courses/${courseId}`).expect(200);
    const pages = detail.body.data.pages;
    expect(pages).toHaveLength(1);
    expect(pages[0].contentMd).toBe('# 更新');
    expect(pages[0].syncState).toBe('SYNCED');
    pageId = pages[0].id as string;

    // Live 指针未被 activate 改动：仍指向 v2；releaseId 非 Live
    const list = await api.get(`/api/courses/${courseId}/releases`).expect(200);
    expect(
      list.body.data.find((r: { id: string }) => r.id === v2Id).isActive,
    ).toBe(true);
    expect(
      list.body.data.find((r: { id: string }) => r.id === releaseId).isActive,
    ).toBe(false);
    // 「切换到此版本」后 editing 落在被切换的版本（2026-10-20 三次改拍）
    expect(
      list.body.data.find((r: { id: string }) => r.id === releaseId).isEditing,
    ).toBe(true);
    expect(
      list.body.data.find((r: { id: string }) => r.id === v2Id).isEditing,
    ).toBe(false);
  });

  it('POST /api/courses/:id/activate-release releaseId 不属于该课程应 404', async () => {
    const res = await api
      .post(`/api/courses/${courseId}/activate-release`)
      .send({ releaseId: '00000000-0000-0000-0000-000000000000' })
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('DELETE /api/releases/:releaseId 后台测试所选版本应 409 CONFLICT（§3.4.5 双保护）', async () => {
    // 再发布一个快照并设为「后台测试所选」（非上线）→ 删除应被 409 拦截
    const r3 = await api
      .post(`/api/courses/${courseId}/release`)
      .send({ revisionNotes: 'e2e 三发（测试所选）' })
      .expect(201);
    const r3Id = r3.body.data.id as string;
    await api
      .put(`/api/ai/config/${courseId}/active-release`)
      .send({ releaseId: r3Id })
      .expect(200);
    const res = await api.delete(`/api/releases/${r3Id}`).expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('DELETE /api/releases/:releaseId 普通版本正常删除（§3.4.5）', async () => {
    const list = await api.get(`/api/courses/${courseId}/releases`).expect(200);
    // 取一个既非 Live、也非测试所选的版本删除
    const normal = list.body.data.find(
      (r: { isActive: boolean; isTestSelected: boolean }) =>
        !r.isActive && !r.isTestSelected,
    );
    expect(normal).toBeTruthy();
    await api.delete(`/api/releases/${normal.id}`).expect(200);
    const after = await api
      .get(`/api/courses/${courseId}/releases`)
      .expect(200);
    expect(
      after.body.data.find((r: { id: string }) => r.id === normal.id),
    ).toBeUndefined();
  });

  it('DELETE /api/releases/:releaseId 删除当前编辑版本时清空 editing 指针（§3.4.5 三次改拍）', async () => {
    const created = await api
      .post(`/api/courses/${courseId}/release`)
      .send({ revisionNotes: 'e2e 四发（编辑版本）' })
      .expect(201);
    const editingId = created.body.data.id as string;

    let list = await api.get(`/api/courses/${courseId}/releases`).expect(200);
    expect(
      list.body.data.find((r: { id: string }) => r.id === editingId).isEditing,
    ).toBe(true);

    // 该版本非 Live、非测试所选 → 允许删除
    await api.delete(`/api/releases/${editingId}`).expect(200);

    list = await api.get(`/api/courses/${courseId}/releases`).expect(200);
    expect(
      list.body.data.find((r: { id: string }) => r.id === editingId),
    ).toBeUndefined();
    // editing 指针已清空：无任何版本带 isEditing=true
    expect(
      list.body.data.some((r: { isEditing: boolean }) => r.isEditing),
    ).toBe(false);
  });

  it('DELETE /api/courses/:id 存在 Release 应 409 CONFLICT（删除保护）', async () => {
    const res = await api.delete(`/api/courses/${courseId}`).expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('DELETE /api/pages/:id 删除页面', async () => {
    await api.delete(`/api/pages/${pageId}`).expect(200);
    const res = await api.get(`/api/pages/${pageId}`).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('POST /api/sync/structure 仅同步课程/课时标题并幂等（§3.2.2/§5.1.4）', async () => {
    const externalId = 'ext-quantum-001';
    // 幂等前置：清理历史遗留的同一外部课程（Release 无级联，需先删）
    const leftover = await prisma.course.findFirst({ where: { externalId } });
    if (leftover) {
      await prisma.release.deleteMany({ where: { courseId: leftover.id } });
      await prisma.course.delete({ where: { id: leftover.id } });
    }

    const res = await api
      .post('/api/sync/structure')
      .send({ externalId })
      .expect(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.created).toBe(1);
    expect(res.body.data.unchanged).toBe(false);

    const course = await prisma.course.findFirst({
      where: { externalId },
      include: { pages: true },
    });
    expect(course).not.toBeNull();
    const firstPage = course!.pages[0];
    expect(firstPage.externalId).toBe('lesson-foundations');
    expect(firstPage.title).toBe('Foundations');
    expect(firstPage.contentMd).toBe(''); // Phase 1 内容不同步
    expect(firstPage.syncState).toBe('SYNCED');

    // 再次同步：无变更（幂等）
    const again = await api
      .post('/api/sync/structure')
      .send({ externalId })
      .expect(201);
    expect(again.body.data.unchanged).toBe(true);
  });

  it('POST /api/sync/all 内容同步已禁用应 400 CONTENT_SYNC_DISABLED（2026-10-22 拍板）', async () => {
    const res = await api
      .post('/api/sync/all')
      .send({ externalId: 'ext-quantum-001' })
      .expect(400);
    expect(res.body.error.code).toBe('CONTENT_SYNC_DISABLED');
  });

  it('POST /api/sync/structure 缺少 externalId 应 400 VALIDATION_ERROR', async () => {
    const res = await api.post('/api/sync/structure').send({}).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /api/sync/external-courses 返回外部课程列表与状态（§5.1.4）', async () => {
    const res = await api.get('/api/sync/external-courses').expect(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    const quantum = res.body.data.find(
      (c: { externalId: string }) => c.externalId === 'ext-quantum-001',
    );
    expect(quantum).toBeDefined();
    expect(quantum.status).toBe('synced');
  });

  it('未知路由应返回统一 404 信封且无堆栈泄露', async () => {
    const res = await api.get('/api/not-exist').expect(404);
    expect(res.body).toEqual({
      success: false,
      data: null,
      error: { code: 'NOT_FOUND', message: expect.any(String) },
    });
  });

  it('GET /api/courses 成功信封完整（§5.3）', async () => {
    const res = await api.get('/api/courses').expect(200);
    expect(Object.keys(res.body).sort()).toEqual(
      ['data', 'error', 'message', 'success'].sort(),
    );
    expect(res.body.message).toBe('操作成功');
  });
});
