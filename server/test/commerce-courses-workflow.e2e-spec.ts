import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { signInAs } from './helpers/employee-session';

/**
 * 商品课程上线流程的幂等与原子性：重复点"审批""上线"（或两人同时点）
 * 只生成一个线上版本，不返回 500。
 */
describe('Commerce course workflow (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const code = `E2E-WF-${Date.now()}`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    const course = await prisma.commerceCourse.findFirst({ where: { code } });
    if (course) {
      await prisma.commerceCourse.update({ where: { id: course.id }, data: { liveVersionId: null } });
      await prisma.courseVersion.deleteMany({ where: { courseId: course.id } });
      await prisma.commerceCourse.delete({ where: { id: course.id } }).catch(() => undefined);
    }
    await app.close();
  });

  it('approves and goes live once when both buttons are pressed twice at the same time', async () => {
    const agent = await signInAs(app, 'ADMIN');
    const created = await agent
      .post('/api/backoffice/courses')
      .send({ code, title: 'Workflow e2e' });
    expect([200, 201]).toContain(created.status);
    const id: string = created.body.data.id;

    await agent.post(`/api/backoffice/courses/${id}/publish-uat`).expect(200);

    const approvals = await Promise.all([
      agent.post(`/api/backoffice/courses/${id}/approve`),
      agent.post(`/api/backoffice/courses/${id}/approve`),
    ]);
    expect(approvals.map((r) => r.status)).toEqual([200, 200]);

    const lives = await Promise.all([
      agent.post(`/api/backoffice/courses/${id}/go-live`),
      agent.post(`/api/backoffice/courses/${id}/go-live`),
    ]);
    expect(lives.map((r) => r.status)).toEqual([200, 200]);

    const versions = await prisma.courseVersion.findMany({ where: { courseId: id } });
    expect(versions).toHaveLength(1);
    const course = await prisma.commerceCourse.findUnique({ where: { id } });
    expect(course?.lifecycleStatus).toBe('LIVE');
    expect(course?.liveVersionId).toBe(versions[0].id);
  });

  it('still refuses to go live from a course that was never approved', async () => {
    const agent = await signInAs(app, 'ADMIN');
    const created = await agent
      .post('/api/backoffice/courses')
      .send({ code: `${code}-B`, title: 'Workflow e2e B' });
    const id: string = created.body.data.id;
    const res = await agent.post(`/api/backoffice/courses/${id}/go-live`);
    expect(res.status).toBe(409);
    await prisma.commerceCourse.delete({ where: { id } });
  });
});
