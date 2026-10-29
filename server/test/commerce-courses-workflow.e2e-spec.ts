import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { signInAs } from './helpers/employee-session';

/**
 * 商品课程上线流程与课时编辑的幂等与原子性：重复点"审批""上线"（或两人同时点）
 * 只生成一个线上版本；课时并发新建、改成重复 code、重复删除、跨课程排序都不返回 500。
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
    await prisma.commerceCourse.deleteMany({ where: { code: { in: [`${code}-L`, `${code}-O`] } } });
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

  it('keeps lesson edits consistent under double clicks', async () => {
    const agent = await signInAs(app, 'ADMIN');
    const created = await agent
      .post('/api/backoffice/courses')
      .send({ code: `${code}-L`, title: 'Lessons e2e' });
    const id: string = created.body.data.id;

    // 同时新建两节课：序号和默认 code 各不相同
    const made = await Promise.all([
      agent.post(`/api/backoffice/courses/${id}/lessons`).send({ title: 'One' }),
      agent.post(`/api/backoffice/courses/${id}/lessons`).send({ title: 'Two' }),
    ]);
    expect(made.map((r) => r.status)).toEqual([201, 201]);
    const lessons = await prisma.lesson.findMany({ where: { courseId: id }, orderBy: { sortOrder: 'asc' } });
    expect(lessons.map((l) => l.sortOrder)).toEqual([1, 2]);
    expect(new Set(lessons.map((l) => l.code)).size).toBe(2);

    // 改成另一节课已有的 code：409，标题也不会被写进去
    const dup = await agent
      .put(`/api/backoffice/courses/${id}/lessons/${lessons[1].id}`)
      .send({ code: lessons[0].code, title: 'Should not stick' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('LESSON_CODE_DUPLICATE');
    const title = await prisma.lessonLocalization.findFirst({ where: { lessonId: lessons[1].id } });
    expect(title?.title).toBe('Two');

    // 重复删除：一次 200，一次 404
    const deletes = await Promise.all([
      agent.delete(`/api/backoffice/courses/${id}/lessons/${lessons[1].id}`),
      agent.delete(`/api/backoffice/courses/${id}/lessons/${lessons[1].id}`),
    ]);
    expect(deletes.map((r) => r.status).sort()).toEqual([200, 404]);
  });

  it('refuses to reorder lessons that belong to another course', async () => {
    const agent = await signInAs(app, 'ADMIN');
    const mine = await agent.post('/api/backoffice/courses').send({ code: `${code}-O`, title: 'Order e2e' });
    const other = await prisma.commerceCourse.findFirst({ where: { code: `${code}-L` } });
    const myId: string = mine.body.data.id;
    await agent.post(`/api/backoffice/courses/${myId}/lessons`).send({ title: 'Mine' });
    const myLesson = await prisma.lesson.findFirstOrThrow({ where: { courseId: myId } });
    const otherLesson = await prisma.lesson.findFirstOrThrow({ where: { courseId: other!.id } });

    const res = await agent
      .put(`/api/backoffice/courses/${myId}/lessons/reorder`)
      .send({ lessonIds: [myLesson.id, otherLesson.id] });
    expect(res.status).toBe(404);
    const untouched = await prisma.lesson.findUniqueOrThrow({ where: { id: otherLesson.id } });
    expect(untouched.sortOrder).toBe(otherLesson.sortOrder);
    const unchanged = await prisma.lesson.findUniqueOrThrow({ where: { id: myLesson.id } });
    expect(unchanged.sortOrder).toBe(myLesson.sortOrder);

    await agent
      .put(`/api/backoffice/courses/${myId}/lessons/reorder`)
      .send({})
      .expect(400);
  });
});
