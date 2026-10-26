import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { createAppModule } from '../src/app.module';
import type { AppRole } from '../src/app-roles';
import {
  PrismaRateLimitStore,
  RateLimitService,
} from '../src/ai/rate-limit.service';
import { configureApp } from '../src/common/app-setup';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * 引擎拆分 e2e（docs/Engine_Split_Implementation.md）：
 * 同一镜像按角色起成两个进程——ks 只给内部接口，agent 只给学员对话，
 * agent 经 HTTP 调 ks；ks 停掉时 agent 返回 503 KS_UNAVAILABLE，而不是崩或当成没课。
 */
describe('Engine split (e2e)', () => {
  const TOKEN = 'ks-e2e-token';
  const SLUG = `split-e2e-${Date.now()}`;
  let ks: INestApplication<App>;
  let agent: INestApplication<App>;
  let ksUrl: string;
  let prisma: PrismaService;
  let courseId: string;

  async function start(roles: AppRole[]): Promise<INestApplication<App>> {
    const moduleRef = await Test.createTestingModule({
      imports: [createAppModule(roles)],
    }).compile();
    const app = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.init();
    return app;
  }

  beforeAll(async () => {
    process.env.KS_SERVICE_TOKEN = TOKEN;
    ks = await start(['ks']);
    await ks.listen(0, '127.0.0.1');
    ksUrl = await ks.getUrl();
    process.env.KS_BASE_URL = ksUrl.replace('[::1]', '127.0.0.1');
    agent = await start(['agent']);
    prisma = agent.get(PrismaService);

    const course = await prisma.course.create({
      data: { title: 'Split-E2E课程', externalId: SLUG, aiTutorOnline: true },
    });
    courseId = course.id;
    const release = await prisma.release.create({
      data: {
        courseId,
        versionTag: 'Split_202610240000',
        revisionNotes: 'e2e',
        snapshotData: { pages: [{ title: '页', contentMd: '# 页\n\n内容' }] },
      },
    });
    await prisma.course.update({
      where: { id: courseId },
      data: { currentReleaseId: release.id },
    });
  });

  afterAll(async () => {
    await prisma.release.deleteMany({ where: { courseId } });
    await prisma.course.deleteMany({ where: { id: courseId } });
    await prisma.$executeRaw`DELETE FROM ai_rate_limit_hits WHERE key LIKE 'split-e2e-%'`;
    await agent?.close();
    await ks?.close().catch(() => undefined);
    delete process.env.KS_BASE_URL;
    delete process.env.KS_SERVICE_TOKEN;
  });

  it('ks 进程只挂内部接口，且必须带服务令牌', async () => {
    const server = ks.getHttpServer();
    await request(server).get('/api/ks/v1/courses').expect(401);
    await request(server)
      .get('/api/ks/v1/courses')
      .set('authorization', 'Bearer wrong')
      .expect(401);
    const res = await request(server)
      .get(`/api/ks/v1/courses/by-external/${SLUG}`)
      .set('authorization', `Bearer ${TOKEN}`)
      .expect(200);
    expect((res.body as { data: unknown }).data).toMatchObject({
      id: courseId,
      aiTutorOnline: true,
    });
    await request(server)
      .get('/api/ks/v1/courses/no-such-course')
      .set('authorization', `Bearer ${TOKEN}`)
      .expect(404);
    // 员工侧与学员侧接口都不在这个进程里
    await request(server).get('/api/courses').expect(404);
    await request(server).get('/api/user/ai-tutors').expect(404);
    await request(server).get('/api/health').expect(200);
  });

  it('agent 进程只挂学员对话，经 HTTP 从 ks 读到课程', async () => {
    const server = agent.getHttpServer();
    const res = await request(server).get('/api/user/ai-tutors').expect(200);
    const tutors = (res.body as { data: unknown }).data as {
      externalId: string;
      available: boolean;
    }[];
    expect(tutors.find((t) => t.externalId === SLUG)).toMatchObject({
      courseId,
      available: true,
    });
    await request(server).get('/api/ai/models').expect(404);
    await request(server).get('/api/courses').expect(404);
    await request(server).post('/api/auth/sign-in').send({}).expect(404);
  });

  it('多个实例共用数据库限流：并发 15 次只放行 10 次', async () => {
    const replicas = [0, 1, 2].map(
      () => new RateLimitService(new PrismaRateLimitStore(prisma)),
    );
    const key = `split-e2e-${Date.now()}`;
    const results = await Promise.allSettled(
      Array.from({ length: 15 }, (_, i) =>
        replicas[i % replicas.length].assertAllowed(key),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    for (const rejected of results.filter((r) => r.status === 'rejected')) {
      expect((rejected.reason as { getStatus(): number }).getStatus()).toBe(
        429,
      );
    }
  });

  it('ks 停掉后，agent 返回 503 KS_UNAVAILABLE', async () => {
    await ks.close();
    const res = await request(agent.getHttpServer())
      .get('/api/user/ai-tutors')
      .expect(503);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      'KS_UNAVAILABLE',
    );
  });
});
