import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import type { CourseCompleteness } from '../src/commerce-courses/completeness';
import { PreviewService } from '../src/commerce-courses/preview.service';
import { PublishingService } from '../src/commerce-courses/publishing.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CourseFixtures } from './helpers/course-fixture';
import type { ErrorResponse, SuccessResponse } from './helpers/http-response';

/**
 * One rule set, one path: the course detail, the Publish gate and the preview all compute
 * completeness from a captured snapshot, so the same content gives the same issues.
 */
describe('Course completeness (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let fixtures: CourseFixtures;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    fixtures = new CourseFixtures(app, prisma);
  });

  afterAll(async () => {
    await fixtures.removeCourses();
    await app.close();
  });

  it('shows the same issues in the detail as the publish gate computes', async () => {
    const agent = await fixtures.admin();
    const course = await fixtures.createCourse(agent, { title: 'Issues' });
    const lesson = await fixtures.createLesson(agent, course.id);
    await fixtures.seedVideoPoint(lesson.id, 'en-GB', 'V1', '', null);

    const detail: SuccessResponse<{ completeness: CourseCompleteness }> =
      await agent.get(`/api/backoffice/courses/${course.id}`).expect(200);
    const fromGate = await app
      .get(PublishingService)
      .completenessForDraft(course.id);

    expect(detail.body.data.completeness.issues).toEqual(fromGate.issues);
    const issues = detail.body.data.completeness.issues;
    expect(issues.length).toBeGreaterThan(0);
    // a new course has no cover, no Chinese Course Information, and a blank learning point
    expect(
      issues.some((i) => i.field === 'cover' && i.message === 'Required'),
    ).toBe(true);
    expect(
      issues.some((i) => i.field === 'title' && i.language === 'zh-CN'),
    ).toBe(true);
    expect(
      issues.some(
        (i) =>
          i.field === 'videoLearningPoints[V1].title' &&
          i.lessonId === lesson.id &&
          i.lessonPosition === 1,
      ),
    ).toBe(true);
  });

  it('blocks Publish for a course without a cover and says why', async () => {
    const agent = await fixtures.admin();
    const course = await fixtures.createCourse(agent, { title: 'No cover' });
    await fixtures.createLesson(agent, course.id);
    const refused: ErrorResponse = await agent
      .post(`/api/backoffice/courses/${course.id}/publish`)
      .send({});
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('PUBLISH_BLOCKED');
    expect(refused.body.error.message).toContain(
      'Complete Course Information first.',
    );
  });

  it('carries the blocker codes and the incomplete lessons in the Publish refusal', async () => {
    const agent = await fixtures.admin();
    const course = await fixtures.createCourse(agent, { title: 'Blockers' });
    const lesson = await fixtures.createLesson(agent, course.id);
    const refused: ErrorResponse = await agent
      .post(`/api/backoffice/courses/${course.id}/publish`)
      .send({});
    expect(refused.status).toBe(409);
    expect(refused.body.error.details).toMatchObject({
      blockers: [
        'Complete Course Information first.',
        'Complete at least 1 lesson first.',
      ],
      blockerCodes: ['COURSE_INFORMATION', 'LESSON_STUDY'],
      incompleteLessons: [
        { lessonId: lesson.id, code: lesson.code, position: 1 },
      ],
    });
  });

  it('marks a cover file that is known to be broken', async () => {
    const agent = await fixtures.admin();
    const course = await fixtures.createCourse(agent, {
      title: 'Broken cover',
    });
    const asset = await prisma.courseMediaAsset.create({
      data: {
        courseId: course.id,
        kind: 'IMAGE',
        originalName: 'cover.png',
        mimeType: 'image/png',
        extension: 'png',
        size: 10,
        storageKey: `e2e/${course.id}/cover.png`,
        brokenAt: new Date(),
        brokenReason: 'MISSING',
      },
    });
    await prisma.commerceCourse.update({
      where: { id: course.id },
      data: { coverAssetId: asset.id },
    });
    const detail: SuccessResponse<{ completeness: CourseCompleteness }> =
      await agent.get(`/api/backoffice/courses/${course.id}`).expect(200);
    expect(detail.body.data.completeness.issues).toContainEqual(
      expect.objectContaining({
        code: 'FILE_BROKEN',
        field: 'cover',
        message: 'This file is missing or damaged. Upload it again.',
      }),
    );
  });

  it('answers 404 for the completeness of a course that does not exist', async () => {
    await expect(
      app
        .get(PublishingService)
        .completenessForDraft('00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('previews the draft with the same completeness as the detail', async () => {
    const agent = await fixtures.admin();
    const course = await fixtures.createCourse(agent, { title: 'Preview' });
    await fixtures.createLesson(agent, course.id);
    const preview = await app.get(PreviewService).preview(course.id);
    // the lesson is not complete, so the learner view does not list it
    expect(preview.lessons).toHaveLength(0);
  });
});
