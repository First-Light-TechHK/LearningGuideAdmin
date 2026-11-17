import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import type TestAgent from 'supertest/lib/agent';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { PublishingService } from '../src/commerce-courses/publishing.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CourseFixtures } from './helpers/course-fixture';
import type { ErrorResponse, SuccessResponse } from './helpers/http-response';

/**
 * Lessons: the Lesson ID is allocated and never reused, positions stay 1..N, a removed
 * lesson stays in what learners see until Publish, and a save keeps what was typed.
 */
describe('Course lessons (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let fixtures: CourseFixtures;
  let agent: TestAgent;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    fixtures = new CourseFixtures(app, prisma);
    agent = await fixtures.admin();
  });

  afterAll(async () => {
    await fixtures.removeCourses();
    await app.close();
  });

  const lessonUrl = (courseId: string, lessonId = '') =>
    `/api/backoffice/courses/${courseId}/lessons${lessonId ? `/${lessonId}` : ''}`;

  async function active(courseId: string) {
    return prisma.lesson.findMany({
      where: { courseId, archivedAt: null },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async function titlesOf(lessonId: string) {
    const rows = await prisma.lessonLocalization.findMany({
      where: { lessonId },
      orderBy: { language: 'asc' },
    });
    return rows.map((row) => [row.language, row.title]);
  }

  describe('create', () => {
    it('gives each new lesson the next L00n code, last in the list, and ignores a typed code', async () => {
      const course = await fixtures.createCourse(agent, { title: 'Codes' });
      const first = await fixtures.createLesson(agent, course.id, {
        title: 'One',
        code: 'MY-OWN',
      });
      const second = await fixtures.createLesson(agent, course.id);
      const third = await fixtures.createLesson(agent, course.id);
      expect([first.code, second.code, third.code]).toEqual([
        'L001',
        'L002',
        'L003',
      ]);
      expect((await active(course.id)).map((row) => row.sortOrder)).toEqual([
        1, 2, 3,
      ]);
    });

    it('never hands out a code again after a delete and a reorder', async () => {
      const course = await fixtures.createCourse(agent, { title: 'No reuse' });
      const one = await fixtures.createLesson(agent, course.id);
      const two = await fixtures.createLesson(agent, course.id);
      const three = await fixtures.createLesson(agent, course.id);

      await agent.delete(lessonUrl(course.id, two.id)).expect(200);
      await agent
        .put(`${lessonUrl(course.id)}/reorder`)
        .send({ lessonIds: [three.id, one.id] })
        .expect(200);
      const fourth = await fixtures.createLesson(agent, course.id);

      expect(fourth.code).toBe('L004');
      const rows = await active(course.id);
      expect(rows.map((row) => [row.code, row.sortOrder])).toEqual([
        ['L003', 1],
        ['L001', 2],
        ['L004', 3],
      ]);
    });

    it('stores a title for each language and lets a title stay empty', async () => {
      const course = await fixtures.createCourse(agent, { title: 'Titles' });
      const both = await fixtures.createLesson(agent, course.id, {
        titles: { 'en-GB': 'One', 'zh-CN': '一' },
      });
      expect(await titlesOf(both.id)).toEqual([
        ['en-GB', 'One'],
        ['zh-CN', '一'],
      ]);

      const blank = await fixtures.createLesson(agent, course.id, {});
      expect(await titlesOf(blank.id)).toEqual([
        ['en-GB', ''],
        ['zh-CN', ''],
      ]);
    });

    it('still takes the old body with one title and its language', async () => {
      const course = await fixtures.createCourse(agent, { title: 'Legacy' });
      const zh = await fixtures.createLesson(agent, course.id, {
        title: '只有中文',
        language: 'zh-CN',
      });
      expect(await titlesOf(zh.id)).toEqual([
        ['en-GB', ''],
        ['zh-CN', '只有中文'],
      ]);
      const plain = await fixtures.createLesson(agent, course.id, {
        title: 'Default language',
      });
      expect(await titlesOf(plain.id)).toEqual([
        ['en-GB', 'Default language'],
        ['zh-CN', ''],
      ]);
    });

    it('answers 400 for a title that is not text or a language that is not offered', async () => {
      const course = await fixtures.createCourse(agent, { title: 'Bad body' });
      for (const body of [
        { title: 12 },
        { titles: { 'en-GB': 7 } },
        { title: 'x', language: 'fr-FR' },
      ]) {
        const response = await agent.post(lessonUrl(course.id)).send(body);
        expect(response.status).toBe(400);
      }
      expect(await active(course.id)).toHaveLength(0);
    });

    it('answers 404 for a course that does not exist', async () => {
      const response = await agent
        .post(lessonUrl('00000000-0000-0000-0000-000000000000'))
        .send({ title: 'Nobody' });
      expect(response.status).toBe(404);
    });
  });

  describe('edit', () => {
    it('refuses to change the Lesson ID and saves nothing from that request', async () => {
      const course = await fixtures.createCourse(agent, { title: 'Immutable' });
      const lesson = await fixtures.createLesson(agent, course.id, {
        title: 'Before',
      });
      const response: ErrorResponse = await agent
        .put(lessonUrl(course.id, lesson.id))
        .send({ code: 'L009', title: 'After' });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('LESSON_ID_IMMUTABLE');
      expect((await titlesOf(lesson.id))[0]).toEqual(['en-GB', 'Before']);
      expect((await active(course.id))[0].code).toBe(lesson.code);
    });

    it('accepts the unchanged Lesson ID, in any case', async () => {
      const course = await fixtures.createCourse(agent, { title: 'Same id' });
      const lesson = await fixtures.createLesson(agent, course.id);
      await agent
        .put(lessonUrl(course.id, lesson.id))
        .send({ code: lesson.code.toLowerCase(), title: 'Renamed' })
        .expect(200);
      expect((await titlesOf(lesson.id))[0]).toEqual(['en-GB', 'Renamed']);
    });

    it('ignores a position in the body', async () => {
      const course = await fixtures.createCourse(agent, { title: 'Position' });
      await fixtures.createLesson(agent, course.id);
      const second = await fixtures.createLesson(agent, course.id);
      await agent
        .put(lessonUrl(course.id, second.id))
        .send({ sortOrder: 1, title: 'Still second' })
        .expect(200);
      expect((await active(course.id)).map((row) => row.id)).toEqual([
        (await active(course.id))[0].id,
        second.id,
      ]);
      expect((await active(course.id)).map((row) => row.sortOrder)).toEqual([
        1, 2,
      ]);
    });

    it('keeps an empty title empty instead of making it Untitled', async () => {
      const course = await fixtures.createCourse(agent, { title: 'Blank' });
      const lesson = await fixtures.createLesson(agent, course.id, {
        title: 'Filled',
      });
      await agent
        .put(lessonUrl(course.id, lesson.id))
        .send({ title: '' })
        .expect(200);
      expect((await titlesOf(lesson.id))[0]).toEqual(['en-GB', '']);
      // a language that has no row yet is created with the title that was typed
      await prisma.lessonLocalization.deleteMany({
        where: { lessonId: lesson.id, language: 'zh-CN' },
      });
      await agent
        .put(lessonUrl(course.id, lesson.id))
        .send({ language: 'zh-CN', description: '只有说明' })
        .expect(200);
      const row = await prisma.lessonLocalization.findUniqueOrThrow({
        where: {
          lessonId_language: { lessonId: lesson.id, language: 'zh-CN' },
        },
      });
      expect(row).toMatchObject({ title: '', description: '只有说明' });
    });

    it('answers 400 for text that is not text', async () => {
      const course = await fixtures.createCourse(agent, { title: 'Shapes' });
      const lesson = await fixtures.createLesson(agent, course.id);
      for (const body of [{ title: 5 }, { description: [] }, { textHtml: 3 }]) {
        const response = await agent
          .put(lessonUrl(course.id, lesson.id))
          .send(body);
        expect(response.status).toBe(400);
      }
    });
  });

  describe('remove', () => {
    it('archives the lesson and closes the gap in the positions', async () => {
      const course = await fixtures.createCourse(agent, { title: 'Compact' });
      const one = await fixtures.createLesson(agent, course.id);
      const two = await fixtures.createLesson(agent, course.id);
      const three = await fixtures.createLesson(agent, course.id);

      await agent.delete(lessonUrl(course.id, two.id)).expect(200);

      const rows = await active(course.id);
      expect(rows.map((row) => [row.id, row.sortOrder])).toEqual([
        [one.id, 1],
        [three.id, 2],
      ]);
      const archived = await prisma.lesson.findUniqueOrThrow({
        where: { id: two.id },
      });
      expect(archived.archivedAt).not.toBeNull();
    });

    it('keeps the trial row of the lesson that was removed', async () => {
      const course = await fixtures.createCourse(agent, { title: 'Trial' });
      const lesson = await fixtures.createLesson(agent, course.id);
      await prisma.trialSetting.create({
        data: { courseId: course.id, lessonId: lesson.id },
      });

      await agent.delete(lessonUrl(course.id, lesson.id)).expect(200);

      expect(
        await prisma.trialSetting.count({ where: { lessonId: lesson.id } }),
      ).toBe(1);
    });

    it('does not change what learners see before Publish', async () => {
      const course = await fixtures.createCourse(agent, { title: 'Live feed' });
      const one = await fixtures.createLesson(agent, course.id, {
        titles: { 'en-GB': 'One', 'zh-CN': '一' },
      });
      await fixtures.createLesson(agent, course.id, {
        titles: { 'en-GB': 'Two', 'zh-CN': '二' },
      });
      const spy = jest
        .spyOn(app.get(PublishingService), 'completenessForDraft')
        .mockResolvedValue({ canPublish: true, publishBlockers: [] } as never);
      try {
        await agent
          .post(`/api/backoffice/courses/${course.id}/publish`)
          .send({})
          .expect(200);
      } finally {
        spy.mockRestore();
      }
      await prisma.commerceCourse.update({
        where: { id: course.id },
        data: { liveStatus: 'ONLINE' },
      });
      const feed = async () => {
        const response: SuccessResponse<{
          lessonCount: number;
          sections: Array<{ lessons: Array<{ id: string }> }>;
        }> = await request(app.getHttpServer())
          .get(`/api/portal/v1/courses/${course.id}`)
          .expect(200);
        return {
          count: response.body.data.lessonCount,
          ids: response.body.data.sections.flatMap((section) =>
            section.lessons.map((lesson) => lesson.id),
          ),
        };
      };
      const before = await feed();
      expect(before.count).toBe(2);

      await agent.delete(lessonUrl(course.id, one.id)).expect(200);

      expect(await feed()).toEqual(before);
    });

    it('answers 404 the second time', async () => {
      const course = await fixtures.createCourse(agent, { title: 'Twice' });
      const lesson = await fixtures.createLesson(agent, course.id);
      await agent.delete(lessonUrl(course.id, lesson.id)).expect(200);
      await agent.delete(lessonUrl(course.id, lesson.id)).expect(404);
    });
  });

  describe('reorder', () => {
    async function threeLessons() {
      const course = await fixtures.createCourse(agent, { title: 'Order' });
      const lessons = [
        await fixtures.createLesson(agent, course.id),
        await fixtures.createLesson(agent, course.id),
        await fixtures.createLesson(agent, course.id),
      ];
      return { course, lessons };
    }

    it('puts the lessons in the order that was sent', async () => {
      const { course, lessons } = await threeLessons();
      const order = [lessons[2].id, lessons[0].id, lessons[1].id];
      await agent
        .put(`${lessonUrl(course.id)}/reorder`)
        .send({ lessonIds: order })
        .expect(200);
      expect((await active(course.id)).map((row) => row.id)).toEqual(order);
    });

    it('refuses a list that leaves a lesson out, and changes nothing', async () => {
      const { course, lessons } = await threeLessons();
      const response: ErrorResponse = await agent
        .put(`${lessonUrl(course.id)}/reorder`)
        .send({ lessonIds: [lessons[2].id, lessons[0].id] });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('LESSON_ORDER_INCOMPLETE');
      expect((await active(course.id)).map((row) => row.id)).toEqual(
        lessons.map((lesson) => lesson.id),
      );
    });

    it('does not move a removed lesson and refuses its id', async () => {
      const { course, lessons } = await threeLessons();
      await agent.delete(lessonUrl(course.id, lessons[1].id)).expect(200);
      const removed = await prisma.lesson.findUniqueOrThrow({
        where: { id: lessons[1].id },
      });
      const response = await agent
        .put(`${lessonUrl(course.id)}/reorder`)
        .send({ lessonIds: [lessons[2].id, lessons[1].id, lessons[0].id] });
      expect(response.status).toBe(404);
      const after = await prisma.lesson.findUniqueOrThrow({
        where: { id: lessons[1].id },
      });
      expect(after.sortOrder).toBe(removed.sortOrder);
    });
  });
});
