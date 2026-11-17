import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import type TestAgent from 'supertest/lib/agent';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { CourseFixtures } from './helpers/course-fixture';
import type { ErrorResponse, SuccessResponse } from './helpers/http-response';

interface ExhibitRow {
  id: string;
  code: string;
  sortOrder: number;
}

interface Detail {
  lessons: Array<{ id: string; exhibits: ExhibitRow[] }>;
}

/**
 * Exhibit codes are allocated once for the whole course and never come back; exhibits have an
 * order that the editor can change; deleting one that is still used says where it is used.
 */
describe('Exhibits (e2e)', () => {
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

  const exhibitsUrl = (courseId: string, lessonId: string) =>
    `/api/backoffice/courses/${courseId}/lessons/${lessonId}/exhibits`;

  async function course(lessonCount = 1) {
    const made = await fixtures.createCourse(agent, { title: 'Exhibits' });
    const lessons: Array<{ id: string; code: string }> = [];
    for (let index = 0; index < lessonCount; index++) {
      lessons.push(await fixtures.createLesson(agent, made.id));
    }
    return { course: made, lessons };
  }

  async function addExhibit(
    courseId: string,
    lessonId: string,
    body: Record<string, unknown> = {},
  ): Promise<ExhibitRow> {
    const response: SuccessResponse<ExhibitRow> = await agent
      .post(exhibitsUrl(courseId, lessonId))
      .send({ type: 'IMAGE', ...body })
      .expect(201);
    return response.body.data;
  }

  async function listed(courseId: string, lessonId: string) {
    const response: SuccessResponse<Detail> = await agent
      .get(`/api/backoffice/courses/${courseId}`)
      .expect(200);
    return (
      response.body.data.lessons.find((lesson) => lesson.id === lessonId)
        ?.exhibits ?? []
    );
  }

  describe('codes', () => {
    it('gives each exhibit the next E code of the course, whatever lesson it is in', async () => {
      const { course: made, lessons } = await course(2);
      const first = await addExhibit(made.id, lessons[0].id);
      const second = await addExhibit(made.id, lessons[1].id);
      const third = await addExhibit(made.id, lessons[0].id);
      expect([first.code, second.code, third.code]).toEqual([
        'E001',
        'E002',
        'E003',
      ]);
    });

    it('ignores a code the client sends', async () => {
      const { course: made, lessons } = await course();
      const created = await addExhibit(made.id, lessons[0].id, {
        code: 'E777',
      });
      expect(created.code).toBe('E001');
    });

    it('does not give out the code of a deleted exhibit again', async () => {
      const { course: made, lessons } = await course();
      await addExhibit(made.id, lessons[0].id);
      const highest = await addExhibit(made.id, lessons[0].id);
      expect(highest.code).toBe('E002');
      await agent
        .delete(`${exhibitsUrl(made.id, lessons[0].id)}/${highest.id}`)
        .expect(200);

      const next = await addExhibit(made.id, lessons[0].id);
      expect(next.code).toBe('E003');
    });

    it('skips a code that an import already put in the course', async () => {
      const { course: made, lessons } = await course();
      await prisma.exhibit.create({
        data: {
          lessonId: lessons[0].id,
          courseId: made.id,
          code: 'E001',
          type: 'IMAGE',
          localized: {},
        },
      });
      const created = await addExhibit(made.id, lessons[0].id);
      expect(created.code).toBe('E002');
    });
  });

  describe('order', () => {
    it('puts a new exhibit last', async () => {
      const { course: made, lessons } = await course();
      const first = await addExhibit(made.id, lessons[0].id);
      const second = await addExhibit(made.id, lessons[0].id);
      expect(second.sortOrder).toBeGreaterThan(first.sortOrder);
      expect(
        (await listed(made.id, lessons[0].id)).map((row) => row.code),
      ).toEqual(['E001', 'E002']);
    });

    it('keeps the order the editor sends, and the course detail returns it', async () => {
      const { course: made, lessons } = await course();
      const a = await addExhibit(made.id, lessons[0].id);
      const b = await addExhibit(made.id, lessons[0].id);
      const c = await addExhibit(made.id, lessons[0].id);

      await agent
        .put(`${exhibitsUrl(made.id, lessons[0].id)}/order`)
        .send({ exhibitIds: [c.id, a.id, b.id] })
        .expect(200);

      expect(
        (await listed(made.id, lessons[0].id)).map((row) => row.code),
      ).toEqual([c.code, a.code, b.code]);

      // a new one still goes last
      const d = await addExhibit(made.id, lessons[0].id);
      expect(
        (await listed(made.id, lessons[0].id)).map((row) => row.code),
      ).toEqual([c.code, a.code, b.code, d.code]);
    });

    it('refuses a list that does not name every exhibit of the lesson once', async () => {
      const { course: made, lessons } = await course(2);
      const a = await addExhibit(made.id, lessons[0].id);
      const b = await addExhibit(made.id, lessons[0].id);
      const other = await addExhibit(made.id, lessons[1].id);
      const url = `${exhibitsUrl(made.id, lessons[0].id)}/order`;

      const partial: ErrorResponse = await agent
        .put(url)
        .send({ exhibitIds: [b.id] });
      expect(partial.status).toBe(400);
      expect(partial.body.error.code).toBe('EXHIBIT_ORDER_INCOMPLETE');

      const repeated: ErrorResponse = await agent
        .put(url)
        .send({ exhibitIds: [a.id, a.id] });
      expect(repeated.status).toBe(400);
      expect(repeated.body.error.code).toBe('EXHIBIT_ORDER_INVALID');

      const notAList: ErrorResponse = await agent
        .put(url)
        .send({ exhibitIds: 'x' });
      expect(notAList.status).toBe(400);
      expect(notAList.body.error.code).toBe('EXHIBIT_ORDER_INVALID');

      // an exhibit of another lesson is not one of this lesson's
      const foreign: ErrorResponse = await agent
        .put(url)
        .send({ exhibitIds: [a.id, other.id] });
      expect(foreign.status).toBe(404);
      expect(foreign.body.error.code).toBe('EXHIBIT_NOT_FOUND');

      expect(
        (await listed(made.id, lessons[0].id)).map((row) => row.code),
      ).toEqual([a.code, b.code]);
    });

    it('is a content change: the course has a draft after a reorder', async () => {
      const { course: made, lessons } = await course();
      const a = await addExhibit(made.id, lessons[0].id);
      const b = await addExhibit(made.id, lessons[0].id);
      await prisma.commerceCourse.update({
        where: { id: made.id },
        data: { hasDraft: false },
      });
      await agent
        .put(`${exhibitsUrl(made.id, lessons[0].id)}/order`)
        .send({ exhibitIds: [b.id, a.id] })
        .expect(200);
      const stored = await prisma.commerceCourse.findUniqueOrThrow({
        where: { id: made.id },
      });
      expect(stored.hasDraft).toBe(true);
    });
  });

  describe('delete', () => {
    async function inLessonTwo() {
      const { course: made, lessons } = await course(2);
      const exhibit = await addExhibit(made.id, lessons[1].id);
      const other = await addExhibit(made.id, lessons[1].id);
      return { course: made, lessons, exhibit, other };
    }

    async function deleteInUse(
      courseId: string,
      lessonId: string,
      exhibitId: string,
    ) {
      const response: ErrorResponse = await agent.delete(
        `${exhibitsUrl(courseId, lessonId)}/${exhibitId}`,
      );
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('EXHIBIT_IN_USE');
      return response.body.error;
    }

    async function saveTriggers(
      courseId: string,
      lessonId: string,
      triggers: unknown[],
    ) {
      await agent
        .put(`/api/backoffice/courses/${courseId}/lessons/${lessonId}/triggers`)
        .send({ language: 'en-GB', triggers })
        .expect(200);
    }

    async function saveText(
      courseId: string,
      lessonId: string,
      textHtml: string,
    ) {
      await agent
        .put(`/api/backoffice/courses/${courseId}/lessons/${lessonId}`)
        .send({ language: 'en-GB', textHtml })
        .expect(200);
    }

    const card = (exhibit: ExhibitRow) =>
      `<figure data-exhibit-code="${exhibit.code}" data-exhibit-id="${exhibit.id}" class="course-exhibit-card"><div><strong>Map</strong></div></figure><p><br/></p>`;

    it('deletes an exhibit that nothing uses', async () => {
      const { course: made, lessons, exhibit } = await inLessonTwo();
      const response: SuccessResponse<{ deleted: boolean }> = await agent
        .delete(`${exhibitsUrl(made.id, lessons[1].id)}/${exhibit.id}`)
        .expect(200);
      expect(response.body.data.deleted).toBe(true);
    });

    it('says which video trigger row uses it, counting the rows by time', async () => {
      const { course: made, lessons, exhibit, other } = await inLessonTwo();
      await saveTriggers(made.id, lessons[1].id, [
        { exhibitId: exhibit.id, timeSeconds: 30 },
        { exhibitId: other.id, timeSeconds: 10 },
      ]);
      const error = await deleteInUse(made.id, lessons[1].id, exhibit.id);
      expect(error.message).toBe('Used in Video 2.2. Remove it there first.');
      expect(error.details).toEqual({
        usages: [{ kind: 'VIDEO', language: 'en-GB', position: '2.2' }],
      });
      expect(await listed(made.id, lessons[1].id)).toHaveLength(2);
    });

    it('says under which learning point of the text it is used', async () => {
      const { course: made, lessons, exhibit } = await inLessonTwo();
      await saveText(
        made.id,
        lessons[1].id,
        `<h1>One</h1><p>a</p><h1>Two</h1><p>b</p><h1>Three</h1>${card(exhibit)}<p>c</p>`,
      );
      const error = await deleteInUse(made.id, lessons[1].id, exhibit.id);
      expect(error.message).toBe('Used in Text 2.3. Remove it there first.');
      expect(error.details).toEqual({
        usages: [{ kind: 'TEXT', language: 'en-GB', position: '2.3' }],
      });
    });

    it('says only the lesson when the card is before the first heading', async () => {
      const { course: made, lessons, exhibit } = await inLessonTwo();
      await saveText(
        made.id,
        lessons[1].id,
        `${card(exhibit)}<h1>One</h1><p>a</p>`,
      );
      const error = await deleteInUse(made.id, lessons[1].id, exhibit.id);
      expect(error.message).toBe('Used in Text 2. Remove it there first.');
    });

    it('names the video and the text place together', async () => {
      const { course: made, lessons, exhibit } = await inLessonTwo();
      await saveTriggers(made.id, lessons[1].id, [
        { exhibitId: exhibit.id, timeSeconds: 5 },
      ]);
      await saveText(
        made.id,
        lessons[1].id,
        `<h1>One</h1>${card(exhibit)}<p>a</p>`,
      );
      const error = await deleteInUse(made.id, lessons[1].id, exhibit.id);
      expect(error.message).toBe(
        'Used in Video 2.1, Text 2.1. Remove it there first.',
      );
    });

    it('can be deleted once the places are cleared', async () => {
      const { course: made, lessons, exhibit } = await inLessonTwo();
      await saveTriggers(made.id, lessons[1].id, [
        { exhibitId: exhibit.id, timeSeconds: 5 },
      ]);
      await deleteInUse(made.id, lessons[1].id, exhibit.id);
      await saveTriggers(made.id, lessons[1].id, []);
      await agent
        .delete(`${exhibitsUrl(made.id, lessons[1].id)}/${exhibit.id}`)
        .expect(200);
    });
  });
});
