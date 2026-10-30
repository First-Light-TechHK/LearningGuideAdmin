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
    await prisma.commerceCourse.deleteMany({
      where: { code: { in: [`${code}-L`, `${code}-O`] } },
    });
    const course = await prisma.commerceCourse.findFirst({ where: { code } });
    if (course) {
      await prisma.commerceCourse.update({
        where: { id: course.id },
        data: { liveVersionId: null },
      });
      await prisma.courseVersion.deleteMany({ where: { courseId: course.id } });
      await prisma.commerceCourse
        .delete({ where: { id: course.id } })
        .catch(() => undefined);
    }
    await app.close();
  });

  it('keeps lesson edits consistent under double clicks', async () => {
    const agent = await signInAs(app, 'ADMIN');
    const created = await agent
      .post('/api/backoffice/courses')
      .send({ code: `${code}-L`, title: 'Lessons e2e' });
    const id: string = created.body.data.id;

    // 同时新建两节课：序号和默认 code 各不相同
    const made = await Promise.all([
      agent
        .post(`/api/backoffice/courses/${id}/lessons`)
        .send({ title: 'One' }),
      agent
        .post(`/api/backoffice/courses/${id}/lessons`)
        .send({ title: 'Two' }),
    ]);
    expect(made.map((r) => r.status)).toEqual([201, 201]);
    const lessons = await prisma.lesson.findMany({
      where: { courseId: id },
      orderBy: { sortOrder: 'asc' },
    });
    expect(lessons.map((l) => l.sortOrder)).toEqual([1, 2]);
    expect(new Set(lessons.map((l) => l.code)).size).toBe(2);

    // 改成另一节课已有的 code：409，标题也不会被写进去
    const dup = await agent
      .put(`/api/backoffice/courses/${id}/lessons/${lessons[1].id}`)
      .send({ code: lessons[0].code, title: 'Should not stick' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('LESSON_CODE_DUPLICATE');
    const title = await prisma.lessonLocalization.findFirst({
      where: { lessonId: lessons[1].id },
    });
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
    const mine = await agent
      .post('/api/backoffice/courses')
      .send({ code: `${code}-O`, title: 'Order e2e' });
    const other = await prisma.commerceCourse.findFirst({
      where: { code: `${code}-L` },
    });
    const myId: string = mine.body.data.id;
    await agent
      .post(`/api/backoffice/courses/${myId}/lessons`)
      .send({ title: 'Mine' });
    const myLesson = await prisma.lesson.findFirstOrThrow({
      where: { courseId: myId },
    });
    const otherLesson = await prisma.lesson.findFirstOrThrow({
      where: { courseId: other!.id },
    });

    const res = await agent
      .put(`/api/backoffice/courses/${myId}/lessons/reorder`)
      .send({ lessonIds: [myLesson.id, otherLesson.id] });
    expect(res.status).toBe(404);
    const untouched = await prisma.lesson.findUniqueOrThrow({
      where: { id: otherLesson.id },
    });
    expect(untouched.sortOrder).toBe(otherLesson.sortOrder);
    const unchanged = await prisma.lesson.findUniqueOrThrow({
      where: { id: myLesson.id },
    });
    expect(unchanged.sortOrder).toBe(myLesson.sortOrder);

    await agent
      .put(`/api/backoffice/courses/${myId}/lessons/reorder`)
      .send({})
      .expect(400);
  });

  it('imports a confirmed package at most once and never cancels one that is importing', async () => {
    const agent = await signInAs(app, 'ADMIN');
    const job = await prisma.coursePackageJob.create({
      data: {
        kind: 'IMPORT',
        status: 'AWAITING_CONFIRM',
        sourceFileName: 'e2e.zip',
      },
    });
    // 让两次确认都先读到 AWAITING_CONFIRM 再往下走：并发窗口在本机只有一两毫秒，
    // 不卡住就很难撞上。旧代码（先查再改）在这里会两次都开始导入，没有 409。
    // 只拦确认接口里的读（看调用栈），别的地方读同一任务照常放行。
    const delegate = prisma.coursePackageJob;
    const original = delegate.findUnique.bind(
      delegate,
    ) as typeof delegate.findUnique;
    let arrived = 0;
    let done = 0;
    let release: () => void = () => undefined;
    const bothRead = new Promise<void>((resolve) => (release = resolve));
    const spy = jest.spyOn(delegate, 'findUnique').mockImplementation(((
      args: Parameters<typeof original>[0],
    ) => {
      const read = original(args);
      const fromConfirm = new Error().stack?.includes('confirmImport');
      if (args.where.id !== job.id || !fromConfirm || arrived >= 2) return read;
      arrived += 1;
      // 两次读都拿到结果之后才一起放行，保证两边看到的都是 AWAITING_CONFIRM
      return read.then(async (row) => {
        done += 1;
        if (done === 2) release();
        await bothRead;
        return row;
      });
    }) as unknown as typeof delegate.findUnique);
    try {
      const confirms = await Promise.all([
        agent
          .post(`/api/backoffice/courses/import/${job.id}/confirm`)
          .send({ onConflict: 'ABORT' }),
        agent
          .post(`/api/backoffice/courses/import/${job.id}/confirm`)
          .send({ onConflict: 'ABORT' }),
      ]);
      // 只有一次能认领任务；另一次 409。认领到的那次因为暂存文件不存在而失败，这里不关心
      expect(arrived).toBe(2);
      expect(confirms.filter((r) => r.status === 409)).toHaveLength(1);
      spy.mockRestore();

      await prisma.coursePackageJob.update({
        where: { id: job.id },
        data: { status: 'IMPORTING' },
      });
      await agent
        .post(`/api/backoffice/courses/import/${job.id}/cancel`)
        .expect(409);
      const after = await prisma.coursePackageJob.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect(after.status).toBe('IMPORTING');
    } finally {
      spy.mockRestore();
      await prisma.coursePackageJob.delete({ where: { id: job.id } });
    }
  });
});
