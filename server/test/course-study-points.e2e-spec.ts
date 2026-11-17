import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import type TestAgent from 'supertest/lib/agent';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { CourseFixtures } from './helpers/course-fixture';
import type { ErrorResponse, SuccessResponse } from './helpers/http-response';

interface Issue {
  field: string;
  message: string;
  language?: string;
}

interface SavedPoints {
  points: Array<{
    id: string;
    code: string;
    title: string;
    timeSeconds: number | null;
    sortOrder: number;
  }>;
}

/**
 * Video learning points keep their id and code across saves, and a save stores what was typed:
 * a blank title, an empty time or a time past the video are saved and reported as issues.
 * Only input that is malformed is refused.
 */
describe('Video learning points and exhibit triggers (e2e)', () => {
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

  async function lessonWithVideo(videoSeconds: number | null = null) {
    const course = await fixtures.createCourse(agent, { title: 'Points' });
    const lesson = await fixtures.createLesson(agent, course.id);
    if (videoSeconds !== null) {
      const video = await prisma.courseMediaAsset.create({
        data: {
          courseId: course.id,
          kind: 'VIDEO',
          originalName: 'lesson.mp4',
          mimeType: 'video/mp4',
          extension: 'mp4',
          size: 10,
          storageKey: `e2e/${course.id}/lesson.mp4`,
        },
      });
      await prisma.lessonLocalization.update({
        where: {
          lessonId_language: { lessonId: lesson.id, language: 'en-GB' },
        },
        data: { videoAssetId: video.id, videoDurationSeconds: videoSeconds },
      });
    }
    return { course, lesson };
  }

  const pointsUrl = (courseId: string, lessonId: string) =>
    `/api/backoffice/courses/${courseId}/lessons/${lessonId}/learning-points`;
  const triggersUrl = (courseId: string, lessonId: string) =>
    `/api/backoffice/courses/${courseId}/lessons/${lessonId}/triggers`;

  async function savePoints(
    courseId: string,
    lessonId: string,
    points: unknown[],
  ) {
    return agent
      .put(pointsUrl(courseId, lessonId))
      .send({ language: 'en-GB', points });
  }

  async function savedPoints(
    courseId: string,
    lessonId: string,
    points: unknown[],
  ) {
    const response: SuccessResponse<SavedPoints> = await savePoints(
      courseId,
      lessonId,
      points,
    );
    expect(response.status).toBe(200);
    return response.body.data.points;
  }

  async function issues(courseId: string): Promise<Issue[]> {
    const response: SuccessResponse<{ completeness: { issues: Issue[] } }> =
      await agent.get(`/api/backoffice/courses/${courseId}`).expect(200);
    return response.body.data.completeness.issues;
  }

  async function rows(lessonId: string) {
    return prisma.learningPoint.findMany({
      where: { lessonId, language: 'en-GB', source: 'VIDEO' },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async function exhibit(courseId: string, lessonId: string) {
    const response: SuccessResponse<{ id: string; code: string }> = await agent
      .post(`/api/backoffice/courses/${courseId}/lessons/${lessonId}/exhibits`)
      .send({ type: 'IMAGE' })
      .expect(201);
    return response.body.data;
  }

  describe('video learning points', () => {
    it('keeps the same ids and codes when the list is saved twice', async () => {
      const { course, lesson } = await lessonWithVideo();
      const first = await savedPoints(course.id, lesson.id, [
        { title: 'One', timeSeconds: 10 },
        { title: 'Two', timeSeconds: 20 },
      ]);
      expect(first.map((point) => point.code)).toEqual(['V1', 'V2']);

      // by id, and by code only
      const second = await savedPoints(course.id, lesson.id, [
        { id: first[0].id, title: 'One, renamed', timeSeconds: 11 },
        { code: first[1].code, title: 'Two', timeSeconds: 20 },
      ]);

      expect(second.map((point) => [point.id, point.code])).toEqual(
        first.map((point) => [point.id, point.code]),
      );
      const stored = await rows(lesson.id);
      expect(stored).toHaveLength(2);
      expect(stored[0]).toMatchObject({
        title: 'One, renamed',
        timeSeconds: 11,
      });
    });

    it('follows the order of the request', async () => {
      const { course, lesson } = await lessonWithVideo();
      const first = await savedPoints(course.id, lesson.id, [
        { title: 'One', timeSeconds: 10 },
        { title: 'Two', timeSeconds: 20 },
      ]);
      await savedPoints(course.id, lesson.id, [
        { id: first[1].id, title: 'Two', timeSeconds: 20 },
        { id: first[0].id, title: 'One', timeSeconds: 10 },
      ]);
      expect((await rows(lesson.id)).map((row) => row.code)).toEqual([
        'V2',
        'V1',
      ]);
    });

    it('does not give a deleted code to a new point', async () => {
      const { course, lesson } = await lessonWithVideo();
      const three = await savedPoints(course.id, lesson.id, [
        { title: 'A', timeSeconds: 1 },
        { title: 'B', timeSeconds: 2 },
        { title: 'C', timeSeconds: 3 },
      ]);
      await savedPoints(course.id, lesson.id, [
        { id: three[0].id, title: 'A', timeSeconds: 1 },
        { id: three[2].id, title: 'C', timeSeconds: 3 },
      ]);
      const after = await savedPoints(course.id, lesson.id, [
        { id: three[0].id, title: 'A', timeSeconds: 1 },
        { id: three[2].id, title: 'C', timeSeconds: 3 },
        { title: 'D', timeSeconds: 4 },
      ]);
      expect(after.map((point) => point.code)).toEqual(['V1', 'V3', 'V4']);
    });

    it('replaces a code the page made up with an allocated one', async () => {
      const { course, lesson } = await lessonWithVideo();
      const saved = await savedPoints(course.id, lesson.id, [
        { code: 'V9', title: 'Made up', timeSeconds: 5 },
      ]);
      expect(saved[0].code).toBe('V1');
    });

    it('saves a blank title and reports it', async () => {
      const { course, lesson } = await lessonWithVideo();
      await savedPoints(course.id, lesson.id, [{ title: '', timeSeconds: 5 }]);
      expect((await rows(lesson.id))[0].title).toBe('');
      expect(
        (await issues(course.id)).some(
          (issue) =>
            issue.field === 'videoLearningPoints[V1].title' &&
            issue.message === 'Required',
        ),
      ).toBe(true);
    });

    it('saves a time that is not filled in and reports it', async () => {
      const { course, lesson } = await lessonWithVideo();
      await savedPoints(course.id, lesson.id, [
        { title: 'No time', timeSeconds: null },
        { title: 'Empty time', timeSeconds: '' },
      ]);
      expect((await rows(lesson.id)).map((row) => row.timeSeconds)).toEqual([
        null,
        null,
      ]);
      expect(
        (await issues(course.id)).some(
          (issue) => issue.field === 'videoLearningPoints[V1].timeSeconds',
        ),
      ).toBe(true);
    });

    it('saves a time past the end of the video and reports it', async () => {
      const { course, lesson } = await lessonWithVideo(60);
      await savedPoints(course.id, lesson.id, [
        { title: 'Late', timeSeconds: 120 },
      ]);
      expect((await rows(lesson.id))[0].timeSeconds).toBe(120);
      expect(
        (await issues(course.id)).some(
          (issue) =>
            issue.field === 'videoLearningPoints[V1].timeSeconds' &&
            issue.message.startsWith('Beyond video length'),
        ),
      ).toBe(true);
    });

    it('answers 400 INVALID_TIME with the row for a time that is not a whole number, and writes nothing', async () => {
      const { course, lesson } = await lessonWithVideo();
      await savedPoints(course.id, lesson.id, [
        { title: 'Kept', timeSeconds: 5 },
      ]);
      for (const bad of ['abc', -1, 1.5, {}, true]) {
        const response: ErrorResponse = await savePoints(course.id, lesson.id, [
          { title: 'Fine', timeSeconds: 3 },
          { title: 'Bad', timeSeconds: bad },
        ]);
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('INVALID_TIME');
        expect(response.body.error.details).toMatchObject({ row: 2 });
      }
      expect((await rows(lesson.id)).map((row) => row.title)).toEqual(['Kept']);
    });

    it('answers 400 for a list that is not a list or rows that are not objects', async () => {
      const { course, lesson } = await lessonWithVideo();
      const notList = await agent
        .put(pointsUrl(course.id, lesson.id))
        .send({ language: 'en-GB', points: 'one' });
      expect(notList.status).toBe(400);
      const notObject = await savePoints(course.id, lesson.id, ['text']);
      expect(notObject.status).toBe(400);
      const badTitle = await savePoints(course.id, lesson.id, [{ title: 5 }]);
      expect(badTitle.status).toBe(400);
      const badLanguage = await agent
        .put(pointsUrl(course.id, lesson.id))
        .send({ language: 'fr-FR', points: [] });
      expect(badLanguage.status).toBe(400);
    });

    it('can empty the list', async () => {
      const { course, lesson } = await lessonWithVideo();
      await savedPoints(course.id, lesson.id, [{ title: 'A', timeSeconds: 1 }]);
      await savedPoints(course.id, lesson.id, []);
      expect(await rows(lesson.id)).toHaveLength(0);
    });
  });

  describe('exhibit triggers', () => {
    async function saveTriggers(
      courseId: string,
      lessonId: string,
      triggers: unknown[],
    ) {
      return agent
        .put(triggersUrl(courseId, lessonId))
        .send({ language: 'en-GB', triggers });
    }

    async function triggerRows(lessonId: string) {
      return prisma.exhibitTrigger.findMany({
        where: { lessonId, language: 'en-GB' },
        orderBy: { sortOrder: 'asc' },
      });
    }

    it('saves a trigger whose exhibit is not chosen yet, as null or as an empty string', async () => {
      const { course, lesson } = await lessonWithVideo();
      await saveTriggers(course.id, lesson.id, [
        { exhibitId: null, timeSeconds: 5 },
        { exhibitId: '', timeSeconds: 6 },
        { timeSeconds: 7 },
      ]).then((response) => expect(response.status).toBe(200));
      const stored = await triggerRows(lesson.id);
      expect(stored.map((row) => [row.exhibitId, row.timeSeconds])).toEqual([
        [null, 5],
        [null, 6],
        [null, 7],
      ]);
      expect(
        (await issues(course.id)).some(
          (issue) =>
            issue.field === 'triggers[0].exhibitId' &&
            issue.message === 'Choose an exhibit',
        ),
      ).toBe(true);
    });

    it('saves the same exhibit at two times', async () => {
      const { course, lesson } = await lessonWithVideo();
      const shown = await exhibit(course.id, lesson.id);
      const response = await saveTriggers(course.id, lesson.id, [
        { exhibitId: shown.id, timeSeconds: 5 },
        { exhibitId: shown.id, timeSeconds: 50 },
      ]);
      expect(response.status).toBe(200);
      expect(await triggerRows(lesson.id)).toHaveLength(2);
    });

    it('answers 400 DUPLICATE_TRIGGER for the same exhibit at the same time', async () => {
      const { course, lesson } = await lessonWithVideo();
      const shown = await exhibit(course.id, lesson.id);
      const response: ErrorResponse = await saveTriggers(course.id, lesson.id, [
        { exhibitId: shown.id, timeSeconds: 5 },
        { exhibitId: shown.id, timeSeconds: 5 },
      ]);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('DUPLICATE_TRIGGER');
      expect(response.body.error.details).toMatchObject({ row: 2 });
      expect(await triggerRows(lesson.id)).toHaveLength(0);
    });

    it('answers 400 EXHIBIT_NOT_IN_LESSON for an exhibit of another lesson', async () => {
      const { course, lesson } = await lessonWithVideo();
      const other = await fixtures.createLesson(agent, course.id);
      const elsewhere = await exhibit(course.id, other.id);
      const response: ErrorResponse = await saveTriggers(course.id, lesson.id, [
        { exhibitId: elsewhere.id, timeSeconds: 5 },
      ]);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('EXHIBIT_NOT_IN_LESSON');
      expect(response.body.error.details).toMatchObject({ row: 1 });
    });

    it('answers 400 INVALID_TIME for a time that is not a whole number', async () => {
      const { course, lesson } = await lessonWithVideo();
      const response: ErrorResponse = await saveTriggers(course.id, lesson.id, [
        { exhibitId: null, timeSeconds: 'abc' },
      ]);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_TIME');
    });

    it('saves a time that is empty or past the video, and reports it', async () => {
      const { course, lesson } = await lessonWithVideo(30);
      const shown = await exhibit(course.id, lesson.id);
      const response = await saveTriggers(course.id, lesson.id, [
        { exhibitId: shown.id, timeSeconds: 90 },
        { exhibitId: shown.id, timeSeconds: null },
      ]);
      expect(response.status).toBe(200);
      const found = await issues(course.id);
      expect(
        found.some(
          (issue) =>
            issue.field.startsWith('triggers[') &&
            issue.message.startsWith('Beyond video length'),
        ),
      ).toBe(true);
    });

    it('gives the triggers back ordered by time', async () => {
      const { course, lesson } = await lessonWithVideo();
      const shown = await exhibit(course.id, lesson.id);
      await saveTriggers(course.id, lesson.id, [
        { exhibitId: shown.id, timeSeconds: 40 },
        { exhibitId: shown.id, timeSeconds: 10 },
        { exhibitId: shown.id, timeSeconds: 25 },
      ]).then((response) => expect(response.status).toBe(200));
      const response: SuccessResponse<{
        lessons: Array<{ triggers: Array<{ timeSeconds: number }> }>;
      }> = await agent.get(`/api/backoffice/courses/${course.id}`).expect(200);
      expect(
        response.body.data.lessons[0].triggers.map((row) => row.timeSeconds),
      ).toEqual([10, 25, 40]);
    });
  });
});
