import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import type TestAgent from 'supertest/lib/agent';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { PublishingService } from '../src/commerce-courses/publishing.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CourseFixtures } from './helpers/course-fixture';
import type { SuccessResponse } from './helpers/http-response';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n1EAAAAASUVORK5CYII=',
  'base64',
);

const READING = {
  type: 'BOOK',
  title: 'A book',
  author: 'An author',
  whyRecommended: 'Because',
};

/**
 * One write path: every content save is one transaction that locks the course, writes, and
 * decides the draft state in the same transaction. A read never writes.
 */
describe('Course write path (e2e)', () => {
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

  async function saveReadings(
    courseId: string,
    lessonId: string,
    title: string,
  ) {
    return agent
      .put(`/api/backoffice/courses/${courseId}/lessons/${lessonId}/readings`)
      .send({ language: 'en-GB', readings: [{ ...READING, title }] })
      .expect(200);
  }

  /** A course with one lesson and one reading, published once. */
  async function publishedCourse() {
    const course = await fixtures.createCourse(agent, { title: 'Writes' });
    const lesson = await fixtures.createLesson(agent, course.id);
    await saveReadings(course.id, lesson.id, 'First');
    // Completeness is not what these tests are about.
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
    return { course, lesson };
  }

  it('keeps the import source when a lesson title is saved', async () => {
    const course = await fixtures.createCourse(agent, { title: 'Imported' });
    const lesson = await fixtures.createLesson(agent, course.id);
    await prisma.commerceCourse.update({
      where: { id: course.id },
      data: {
        draftSourceType: 'IMPORT',
        draftSourceEnvironment: 'Production',
        draftSourceVersionLabel: 'Version 3',
      },
    });

    await agent
      .put(`/api/backoffice/courses/${course.id}/lessons/${lesson.id}`)
      .send({ title: 'Renamed' })
      .expect(200);

    const row = await prisma.commerceCourse.findUniqueOrThrow({
      where: { id: course.id },
    });
    expect(row).toMatchObject({
      hasDraft: true,
      draftSourceType: 'IMPORT',
      draftSourceEnvironment: 'Production',
      draftSourceVersionLabel: 'Version 3',
    });
  });

  it('keeps the import source for every other kind of save too', async () => {
    const course = await fixtures.createCourse(agent, { title: 'Sources' });
    const lesson = await fixtures.createLesson(agent, course.id);
    await prisma.commerceCourse.update({
      where: { id: course.id },
      data: {
        draftSourceType: 'RESTORE',
        draftSourceVersionLabel: 'Version 1',
      },
    });
    await saveReadings(course.id, lesson.id, 'Kept');
    await agent
      .put(`/api/backoffice/courses/${course.id}`)
      .send({ subtitle: 'Sub' })
      .expect(200);
    await agent
      .put(`/api/backoffice/courses/${course.id}/localizations/en-GB`)
      .send({ title: 'Course' })
      .expect(200);
    const row = await prisma.commerceCourse.findUniqueOrThrow({
      where: { id: course.id },
    });
    expect(row.draftSourceType).toBe('RESTORE');
    expect(row.draftSourceVersionLabel).toBe('Version 1');
  });

  it('says No draft right after a change is undone, without opening the course again', async () => {
    const { course, lesson } = await publishedCourse();
    expect(
      (
        await prisma.commerceCourse.findUniqueOrThrow({
          where: { id: course.id },
        })
      ).hasDraft,
    ).toBe(false);

    await saveReadings(course.id, lesson.id, 'Changed');
    expect(
      (
        await prisma.commerceCourse.findUniqueOrThrow({
          where: { id: course.id },
        })
      ).hasDraft,
    ).toBe(true);

    await saveReadings(course.id, lesson.id, 'First');
    const row = await prisma.commerceCourse.findUniqueOrThrow({
      where: { id: course.id },
    });
    expect(row.hasDraft).toBe(false);
    expect(row.draftSourceType).toBeNull();
  });

  it('does not write when the course is opened', async () => {
    const { course } = await publishedCourse();
    // a flag left behind by something else: opening the course must not "fix" it by writing
    await prisma.commerceCourse.update({
      where: { id: course.id },
      data: { hasDraft: true },
    });
    const before = await prisma.commerceCourse.findUniqueOrThrow({
      where: { id: course.id },
    });

    await agent.get(`/api/backoffice/courses/${course.id}`).expect(200);
    await agent.get(`/api/backoffice/courses/${course.id}`).expect(200);

    const after = await prisma.commerceCourse.findUniqueOrThrow({
      where: { id: course.id },
    });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.hasDraft).toBe(true);
  });

  it('queues two saves on the same course and keeps both', async () => {
    const course = await fixtures.createCourse(agent, { title: 'Parallel' });
    const lesson = await fixtures.createLesson(agent, course.id);
    const [title, readings] = await Promise.all([
      agent
        .put(`/api/backoffice/courses/${course.id}/lessons/${lesson.id}`)
        .send({ title: 'Both land' }),
      agent
        .put(
          `/api/backoffice/courses/${course.id}/lessons/${lesson.id}/readings`,
        )
        .send({ language: 'en-GB', readings: [READING] }),
    ]);
    expect([title.status, readings.status]).toEqual([200, 200]);
    const localization = await prisma.lessonLocalization.findUniqueOrThrow({
      where: { lessonId_language: { lessonId: lesson.id, language: 'en-GB' } },
    });
    expect(localization.title).toBe('Both land');
    expect(
      await prisma.recommendedReading.count({ where: { lessonId: lesson.id } }),
    ).toBe(1);
  });

  it('writes nothing when a save is refused half way', async () => {
    const course = await fixtures.createCourse(agent, { title: 'Atomic' });
    const lesson = await fixtures.createLesson(agent, course.id);
    const url = `/api/backoffice/courses/${course.id}/lessons/${lesson.id}/knowledge-test`;
    await agent
      .put(url)
      .send({
        enabled: true,
        questions: [{ question: 'One?', referenceAnswer: 'Yes' }],
      })
      .expect(200);

    const refused = await agent.put(url).send({
      enabled: true,
      questions: [
        { question: 'Changed?', referenceAnswer: 'Yes' },
        { question: 'Second?', referenceAnswer: '' },
      ],
    });
    expect(refused.status).toBe(400);
    const rows = await prisma.knowledgeQuestion.findMany({
      where: { lessonId: lesson.id },
    });
    expect(rows.map((row) => row.question)).toEqual(['One?']);
  });

  it('leaves no file behind when the cover could not be attached', async () => {
    const course = await fixtures.createCourse(agent, { title: 'Cover' });
    const spy = jest
      .spyOn(prisma, '$transaction')
      .mockRejectedValueOnce(new Error('write failed'));
    try {
      const response = await agent
        .post(`/api/backoffice/courses/${course.id}/cover`)
        .attach('file', PNG, {
          filename: 'cover.png',
          contentType: 'image/png',
        });
      expect(response.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(
      await prisma.courseMediaAsset.count({ where: { courseId: course.id } }),
    ).toBe(0);
    const row = await prisma.commerceCourse.findUniqueOrThrow({
      where: { id: course.id },
    });
    expect(row.coverAssetId).toBeNull();

    // the same upload works once the write goes through
    await agent
      .post(`/api/backoffice/courses/${course.id}/cover`)
      .attach('file', PNG, { filename: 'cover.png', contentType: 'image/png' })
      .expect(201);
    expect(
      await prisma.courseMediaAsset.count({ where: { courseId: course.id } }),
    ).toBe(1);
  });

  it('answers 404 for a save on a course that does not exist', async () => {
    const response: SuccessResponse<unknown> = await agent
      .put(
        '/api/backoffice/courses/00000000-0000-0000-0000-000000000000/localizations/en-GB',
      )
      .send({ title: 'Nobody' });
    expect(response.status).toBe(404);
  });
});
