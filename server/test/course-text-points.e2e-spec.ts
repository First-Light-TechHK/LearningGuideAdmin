import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import type TestAgent from 'supertest/lib/agent';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { CourseFixtures } from './helpers/course-fixture';
import type { SuccessResponse } from './helpers/http-response';

interface Detail {
  lessons: Array<{
    id: string;
    localizations: Array<{ language: string; textHtml: string | null }>;
  }>;
}

/**
 * Text learning points are the Heading 1s of the text. The server stamps each with a
 * data-lp code, updates the rows in place, and gives back the stamped HTML.
 */
describe('Text learning points (e2e)', () => {
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

  async function lesson() {
    const course = await fixtures.createCourse(agent, { title: 'Text' });
    const created = await fixtures.createLesson(agent, course.id);
    return { course, lesson: created };
  }

  /** Save the text; the response's stamped HTML is what the editor holds from now on. */
  async function saveText(
    courseId: string,
    lessonId: string,
    textHtml: string,
  ) {
    const response: SuccessResponse<Detail> = await agent
      .put(`/api/backoffice/courses/${courseId}/lessons/${lessonId}`)
      .send({ language: 'en-GB', textHtml })
      .expect(200);
    const row = response.body.data.lessons
      .find((item) => item.id === lessonId)
      ?.localizations.find((loc) => loc.language === 'en-GB');
    return row?.textHtml ?? '';
  }

  async function points(lessonId: string) {
    return prisma.learningPoint.findMany({
      where: { lessonId, language: 'en-GB', source: 'TEXT' },
      orderBy: { sortOrder: 'asc' },
    });
  }

  it('stamps every Heading 1 and gives the stamped HTML back', async () => {
    const { course, lesson: made } = await lesson();
    const html = await saveText(
      course.id,
      made.id,
      '<h1>First</h1><p>One</p><h1>Second</h1><p>Two</p>',
    );
    expect(html).toBe(
      '<h1 data-lp="T1">First</h1><p>One</p><h1 data-lp="T2">Second</h1><p>Two</p>',
    );
    expect((await points(made.id)).map((row) => row.code)).toEqual([
      'T1',
      'T2',
    ]);
    const stored = await prisma.lessonLocalization.findUniqueOrThrow({
      where: { lessonId_language: { lessonId: made.id, language: 'en-GB' } },
    });
    expect(stored.textHtml).toBe(html);
  });

  it('keeps the id and code of a heading that was renamed', async () => {
    const { course, lesson: made } = await lesson();
    const stamped = await saveText(
      course.id,
      made.id,
      '<h1>Old name</h1><p>Body</p>',
    );
    const [before] = await points(made.id);

    await saveText(course.id, made.id, stamped.replace('Old name', 'New name'));

    const [after] = await points(made.id);
    expect(after).toMatchObject({
      id: before.id,
      code: before.code,
      title: 'New name',
    });
  });

  it('saves two headings with the same title, and saves them again', async () => {
    const { course, lesson: made } = await lesson();
    const html = '<h1>Same</h1><p>A</p><h1>Same</h1><p>B</p>';
    const first = await saveText(course.id, made.id, html);
    const ids = (await points(made.id)).map((row) => row.id);
    expect(ids).toHaveLength(2);

    // a page that lost the stamps still gets the same rows back, in order
    await saveText(course.id, made.id, html);
    expect((await points(made.id)).map((row) => row.id)).toEqual(ids);
    expect(first).toContain('data-lp="T1"');
    expect(first).toContain('data-lp="T2"');
  });

  it('stores an empty heading as a learning point with an empty title', async () => {
    const { course, lesson: made } = await lesson();
    await saveText(
      course.id,
      made.id,
      '<h1></h1><p>Body</p><h1>Next</h1><p>B</p>',
    );
    expect((await points(made.id)).map((row) => row.title)).toEqual([
      '',
      'Next',
    ]);
  });

  it('leaves the other codes alone when a heading is put in first', async () => {
    const { course, lesson: made } = await lesson();
    const stamped = await saveText(
      course.id,
      made.id,
      '<h1>Alpha</h1><p>A</p><h1>Beta</h1><p>B</p>',
    );
    const before = await points(made.id);

    const html = await saveText(
      course.id,
      made.id,
      `<h1>Brand new</h1><p>N</p>${stamped}`,
    );

    const after = await points(made.id);
    expect(after.map((row) => [row.code, row.title])).toEqual([
      ['T3', 'Brand new'],
      ['T1', 'Alpha'],
      ['T2', 'Beta'],
    ]);
    expect(after.slice(1).map((row) => row.id)).toEqual(
      before.map((row) => row.id),
    );
    expect(html.startsWith('<h1 data-lp="T3">Brand new</h1>')).toBe(true);
  });

  it('does not give the code of a deleted heading to a new one', async () => {
    const { course, lesson: made } = await lesson();
    const stamped = await saveText(
      course.id,
      made.id,
      '<h1>Alpha</h1><p>A</p><h1>Beta</h1><p>B</p>',
    );
    // remove Beta, then add a new heading
    const withoutBeta = stamped.replace(
      /<h1 data-lp="T2">Beta<\/h1><p>B<\/p>/,
      '',
    );
    await saveText(course.id, made.id, withoutBeta);
    await saveText(course.id, made.id, `${withoutBeta}<h1>Gamma</h1><p>G</p>`);
    expect((await points(made.id)).map((row) => row.code)).toEqual([
      'T1',
      'T3',
    ]);
  });

  it('removes the learning points when the text is cleared', async () => {
    const { course, lesson: made } = await lesson();
    await saveText(course.id, made.id, '<h1>Alpha</h1><p>A</p>');
    await agent
      .put(`/api/backoffice/courses/${course.id}/lessons/${made.id}`)
      .send({ language: 'en-GB', textHtml: null })
      .expect(200);
    expect(await points(made.id)).toHaveLength(0);
  });

  it('keeps the mirror on the lesson text in step with the rows', async () => {
    const { course, lesson: made } = await lesson();
    await saveText(
      course.id,
      made.id,
      '<h1>Alpha</h1><p>A</p><h1>Beta</h1><p>B</p>',
    );
    const stored = await prisma.lessonLocalization.findUniqueOrThrow({
      where: { lessonId_language: { lessonId: made.id, language: 'en-GB' } },
    });
    expect(stored.textLearningPoints).toEqual([
      { code: 'T1', heading: 'Alpha', level: 1 },
      { code: 'T2', heading: 'Beta', level: 1 },
    ]);
  });

  it('does not make a draft by stamping alone', async () => {
    const { course, lesson: made } = await lesson();
    await saveText(course.id, made.id, '<h1>Alpha</h1><p>A</p>');
    const before = await prisma.commerceCourse.findUniqueOrThrow({
      where: { id: course.id },
    });
    await agent.get(`/api/backoffice/courses/${course.id}`).expect(200);
    const after = await prisma.commerceCourse.findUniqueOrThrow({
      where: { id: course.id },
    });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });
});
