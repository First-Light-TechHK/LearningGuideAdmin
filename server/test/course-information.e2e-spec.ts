import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import type TestAgent from 'supertest/lib/agent';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { PublishingService } from '../src/commerce-courses/publishing.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CourseFixtures } from './helpers/course-fixture';
import type { ErrorResponse, SuccessResponse } from './helpers/http-response';

interface CourseDetail {
  id: string;
  code: string;
  learningMode: string;
  learningLanguages: string[];
  defaultContentLanguage: string;
  localizations: Array<{
    language: string;
    title: string;
    shortDescription: string | null;
    overview: string | null;
    whatYouLearn: unknown;
    provides: unknown;
  }>;
  completeness: { issues: Array<{ field: string; language?: string }> };
}

/**
 * Create a course, add a language, save Course Information (PRD step 1).
 * A save stores what was typed; only malformed input is refused.
 */
describe('Course Information (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let fixtures: CourseFixtures;
  let agent: TestAgent;
  const categoryIds: string[] = [];

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
    await prisma.courseCatalogueEntry.deleteMany({
      where: { id: { in: categoryIds } },
    });
    await app.close();
  });

  async function createCategory(
    status: 'ACTIVE' | 'ARCHIVED' = 'ACTIVE',
    parentId: string | null = null,
  ) {
    const row = await prisma.courseCatalogueEntry.create({
      data: {
        name: `info-e2e-${Math.random().toString(36).slice(2, 10)}`,
        status,
        parentId,
      },
    });
    categoryIds.unshift(row.id);
    return row;
  }

  async function create(body: Record<string, unknown>) {
    const response: SuccessResponse<CourseDetail> = await agent
      .post('/api/backoffice/courses')
      .send(body);
    if (response.status === 201) fixtures.track(response.body.data.id);
    return response;
  }

  async function history(courseId: string, action: string) {
    return prisma.courseAuthoringActivity.findMany({
      where: { courseId, action },
    });
  }

  describe('create', () => {
    it('stores the title of each language in one request', async () => {
      const response = await create({
        titles: { 'en-GB': 'Modeling life', 'zh-CN': '建模人生' },
        learningMode: 'VIDEO_AND_TEXT',
        learningLanguages: ['en-GB', 'zh-CN'],
        defaultContentLanguage: 'en-GB',
      });
      expect(response.status).toBe(201);
      const rows = await prisma.courseLocalization.findMany({
        where: { courseId: response.body.data.id },
        orderBy: { language: 'asc' },
      });
      expect(rows.map((row) => [row.language, row.title])).toEqual([
        ['en-GB', 'Modeling life'],
        ['zh-CN', '建模人生'],
      ]);
    });

    it('still takes the old body with one title and its language', async () => {
      const response = await create({
        title: 'Only Chinese',
        language: 'zh-CN',
      });
      expect(response.status).toBe(201);
      expect(response.body.data.defaultContentLanguage).toBe('zh-CN');
      const rows = await prisma.courseLocalization.findMany({
        where: { courseId: response.body.data.id },
      });
      expect(rows.find((row) => row.language === 'zh-CN')?.title).toBe(
        'Only Chinese',
      );
      // both Course Information rows exist; the missing one is reported as Required
      expect(rows.map((row) => row.language).sort()).toEqual([
        'en-GB',
        'zh-CN',
      ]);
    });

    it('writes the CREATE_COURSE history with the code, mode and languages', async () => {
      const response = await create({
        titles: { 'en-GB': 'History', 'zh-CN': '历史' },
        learningMode: 'TEXT_ONLY',
        learningLanguages: ['en-GB', 'zh-CN'],
      });
      const [entry] = await history(response.body.data.id, 'CREATE_COURSE');
      expect(entry.detail).toEqual({
        courseCode: response.body.data.code,
        learningMode: 'TEXT_ONLY',
        learningLanguages: ['en-GB', 'zh-CN'],
      });
    });

    it('creates nothing when the history cannot be written', async () => {
      const title = `Rolled back ${Date.now()}`;
      const spy = jest
        .spyOn(app.get(PublishingService), 'recordHistory')
        .mockRejectedValueOnce(new Error('history is down'));
      try {
        const response = await agent
          .post('/api/backoffice/courses')
          .send({ title, titles: { 'zh-CN': '回滚' } });
        expect(response.status).toBe(500);
      } finally {
        spy.mockRestore();
      }
      const remaining = await prisma.courseLocalization.count({
        where: { title },
      });
      expect(remaining).toBe(0);
    });

    it('answers 400 for a learning mode that does not exist', async () => {
      const response = await agent
        .post('/api/backoffice/courses')
        .send({ title: 'Bad mode', learningMode: 'X' });
      expect(response.status).toBe(400);
      expect((response.body as ErrorResponse['body']).error.code).toBe(
        'LEARNING_MODE_INVALID',
      );
    });

    it('answers 400 for a language that is not offered', async () => {
      const unknownDefault = await agent
        .post('/api/backoffice/courses')
        .send({ title: 'Bad language', defaultContentLanguage: 'fr-FR' });
      expect(unknownDefault.status).toBe(400);
      const unknownLearning = await agent
        .post('/api/backoffice/courses')
        .send({ title: 'Bad language', learningLanguages: ['en-GB', 'fr-FR'] });
      expect(unknownLearning.status).toBe(400);
      const notLearning = await agent.post('/api/backoffice/courses').send({
        title: 'Default not learned',
        defaultContentLanguage: 'zh-CN',
        learningLanguages: ['en-GB'],
      });
      expect(notLearning.status).toBe(400);
    });

    it('answers 400 for malformed titles', async () => {
      const response = await agent
        .post('/api/backoffice/courses')
        .send({ titles: { 'en-GB': 42 } });
      expect(response.status).toBe(400);
    });

    it('answers 400 CATEGORY_NOT_FOUND for a category that does not exist, and creates nothing', async () => {
      const title = `No category ${Date.now()}`;
      const response = await agent.post('/api/backoffice/courses').send({
        titles: { 'en-GB': title, 'zh-CN': '无分类' },
        categoryId: '00000000-0000-0000-0000-000000000000',
      });
      expect(response.status).toBe(400);
      expect((response.body as ErrorResponse['body']).error.code).toBe(
        'CATEGORY_NOT_FOUND',
      );
      const remaining = await prisma.courseLocalization.count({
        where: { title },
      });
      expect(remaining).toBe(0);
    });

    it('refuses an archived category and one that is deeper than two levels', async () => {
      const archived = await createCategory('ARCHIVED');
      const top = await createCategory();
      const child = await createCategory('ACTIVE', top.id);
      const grandchild = await createCategory('ACTIVE', child.id);
      const codes: string[] = [];
      for (const id of [archived.id, grandchild.id]) {
        const response = await agent
          .post('/api/backoffice/courses')
          .send({ title: 'Category rules', categoryId: id });
        expect(response.status).toBe(400);
        codes.push((response.body as ErrorResponse['body']).error.code);
      }
      expect(codes).toEqual(['CATEGORY_ARCHIVED', 'CATEGORY_INVALID_LEVEL']);
      const ok = await create({ title: 'Level two', categoryId: child.id });
      expect(ok.status).toBe(201);
    });
  });

  describe('learning languages', () => {
    it('writes ADD_LEARNING_LANGUAGE when a language is added', async () => {
      const course = await fixtures.createCourse(agent, {
        title: 'Add language',
        learningLanguages: ['en-GB'],
      });
      expect(await history(course.id, 'ADD_LEARNING_LANGUAGE')).toHaveLength(0);

      await agent
        .put(`/api/backoffice/courses/${course.id}`)
        .send({ learningLanguages: ['en-GB', 'zh-CN'] })
        .expect(200);

      const entries = await history(course.id, 'ADD_LEARNING_LANGUAGE');
      expect(entries).toHaveLength(1);
      expect(entries[0].detail).toEqual({
        courseCode: course.code,
        from: ['en-GB'],
        to: ['en-GB', 'zh-CN'],
      });
    });

    it('writes nothing when the list is sent again unchanged', async () => {
      const course = await fixtures.createCourse(agent, {
        title: 'Same languages',
        learningLanguages: ['en-GB', 'zh-CN'],
      });
      await agent
        .put(`/api/backoffice/courses/${course.id}`)
        .send({ learningLanguages: ['en-GB', 'zh-CN'], subtitle: 'Sub' })
        .expect(200);
      expect(await history(course.id, 'ADD_LEARNING_LANGUAGE')).toHaveLength(0);
    });

    it('still refuses to remove a language, change the mode or change the code', async () => {
      const course = await fixtures.createCourse(agent, {
        title: 'Locked',
        learningLanguages: ['en-GB', 'zh-CN'],
        learningMode: 'VIDEO_ONLY',
      });
      const url = `/api/backoffice/courses/${course.id}`;
      const removed = await agent
        .put(url)
        .send({ learningLanguages: ['en-GB'] });
      expect(removed.status).toBe(409);
      const mode = await agent.put(url).send({ learningMode: 'TEXT_ONLY' });
      expect(mode.status).toBe(409);
      const code = await agent.put(url).send({ code: 'C999999' });
      expect(code.status).toBe(409);
    });

    it('keeps the language list and writes no history when the save is refused', async () => {
      const course = await fixtures.createCourse(agent, {
        title: 'Refused half way',
        learningLanguages: ['en-GB'],
      });
      const refused = await agent
        .put(`/api/backoffice/courses/${course.id}`)
        .send({
          learningLanguages: ['en-GB', 'zh-CN'],
          categoryId: '00000000-0000-0000-0000-000000000000',
        });
      expect(refused.status).toBe(400);
      const row = await prisma.commerceCourse.findUniqueOrThrow({
        where: { id: course.id },
      });
      expect(row.learningLanguages).toEqual(['en-GB']);
      expect(await history(course.id, 'ADD_LEARNING_LANGUAGE')).toHaveLength(0);
    });
  });

  describe('localizations', () => {
    it('keeps the title when only the overview is sent', async () => {
      const course = await fixtures.createCourse(agent, {
        titles: { 'en-GB': 'Keep me', 'zh-CN': '保留' },
      });
      await agent
        .put(`/api/backoffice/courses/${course.id}/localizations/en-GB`)
        .send({ shortDescription: 'Short', whatYouLearn: ['A', '', 'C'] })
        .expect(200);
      await agent
        .put(`/api/backoffice/courses/${course.id}/localizations/en-GB`)
        .send({ overview: 'Overview only' })
        .expect(200);
      const row = await prisma.courseLocalization.findUniqueOrThrow({
        where: {
          courseId_language: { courseId: course.id, language: 'en-GB' },
        },
      });
      expect(row).toMatchObject({
        title: 'Keep me',
        shortDescription: 'Short',
        overview: 'Overview only',
        whatYouLearn: ['A', '', 'C'],
      });
    });

    it('clears a field that is sent as null and nothing else', async () => {
      const course = await fixtures.createCourse(agent, {
        titles: { 'en-GB': 'Clear', 'zh-CN': '清除' },
      });
      const url = `/api/backoffice/courses/${course.id}/localizations/en-GB`;
      await agent
        .put(url)
        .send({ shortDescription: 'Short', overview: 'Long' })
        .expect(200);
      await agent.put(url).send({ shortDescription: null }).expect(200);
      const row = await prisma.courseLocalization.findUniqueOrThrow({
        where: {
          courseId_language: { courseId: course.id, language: 'en-GB' },
        },
      });
      expect(row).toMatchObject({
        title: 'Clear',
        shortDescription: null,
        overview: 'Long',
      });
    });

    it('creates the row with an empty title when it is missing', async () => {
      const course = await fixtures.createCourse(agent, { title: 'Missing' });
      await prisma.courseLocalization.deleteMany({
        where: { courseId: course.id, language: 'zh-CN' },
      });
      await agent
        .put(`/api/backoffice/courses/${course.id}/localizations/zh-CN`)
        .send({ overview: '只有概述' })
        .expect(200);
      const row = await prisma.courseLocalization.findUniqueOrThrow({
        where: {
          courseId_language: { courseId: course.id, language: 'zh-CN' },
        },
      });
      expect(row).toMatchObject({ title: '', overview: '只有概述' });
    });

    it('answers 400 for a language that is not offered and for the wrong shapes', async () => {
      const course = await fixtures.createCourse(agent, { title: 'Shapes' });
      const base = `/api/backoffice/courses/${course.id}/localizations`;
      const refused = [
        { language: 'fr-FR', body: { title: 'Non' } },
        { language: 'en-GB', body: { title: 5 } },
        { language: 'en-GB', body: { whatYouLearn: 'one' } },
        { language: 'en-GB', body: { provides: [1, 2] } },
      ];
      for (const { language, body } of refused) {
        const response = await agent.put(`${base}/${language}`).send(body);
        expect(response.status).toBe(400);
      }
    });
  });

  describe('PUT :id/information', () => {
    it('saves the whole of step 1 in one request and returns the course with its issues', async () => {
      const category = await createCategory();
      const course = await fixtures.createCourse(agent, {
        title: 'Information',
        learningLanguages: ['en-GB'],
      });
      const response: SuccessResponse<CourseDetail> = await agent
        .put(`/api/backoffice/courses/${course.id}/information`)
        .send({
          categoryId: category.id,
          addLearningLanguages: ['zh-CN'],
          localizations: {
            'en-GB': {
              title: 'Information',
              shortDescription: 'Short',
              whatYouLearn: ['A', 'B'],
            },
            'zh-CN': {
              title: '信息',
              shortDescription: '简介',
              whatYouLearn: ['甲', '乙'],
            },
          },
        })
        .expect(200);

      const data = response.body.data;
      expect(data.learningLanguages).toEqual(['en-GB', 'zh-CN']);
      expect(
        data.localizations.map((loc) => [loc.language, loc.title]).sort(),
      ).toEqual([
        ['en-GB', 'Information'],
        ['zh-CN', '信息'],
      ]);
      // the same response says what is still missing
      expect(
        data.completeness.issues.some(
          (issue) => issue.field === 'learn' && issue.language === 'en-GB',
        ),
      ).toBe(true);
      const row = await prisma.commerceCourse.findUniqueOrThrow({
        where: { id: course.id },
      });
      expect(row.categoryId).toBe(category.id);
      expect(await history(course.id, 'ADD_LEARNING_LANGUAGE')).toHaveLength(1);
    });

    it('saves nothing when one part of it is refused', async () => {
      const course = await fixtures.createCourse(agent, {
        titles: { 'en-GB': 'Before', 'zh-CN': '之前' },
      });
      const refused = await agent
        .put(`/api/backoffice/courses/${course.id}/information`)
        .send({
          categoryId: '00000000-0000-0000-0000-000000000000',
          localizations: { 'en-GB': { title: 'After' } },
        });
      expect(refused.status).toBe(400);
      const row = await prisma.courseLocalization.findUniqueOrThrow({
        where: {
          courseId_language: { courseId: course.id, language: 'en-GB' },
        },
      });
      expect(row.title).toBe('Before');
    });

    it('refuses a language that is not offered and a body that is not an object', async () => {
      const course = await fixtures.createCourse(agent, { title: 'Refuse' });
      const url = `/api/backoffice/courses/${course.id}/information`;
      const refused = [
        { localizations: { 'fr-FR': { title: 'x' } } },
        { localizations: [] },
        { addLearningLanguages: ['fr-FR'] },
      ];
      for (const body of refused) {
        const response = await agent.put(url).send(body);
        expect(response.status).toBe(400);
      }
    });

    it('answers 404 for a course that does not exist', async () => {
      const response = await agent
        .put(
          '/api/backoffice/courses/00000000-0000-0000-0000-000000000000/information',
        )
        .send({ localizations: { 'en-GB': { title: 'Nobody' } } });
      expect(response.status).toBe(404);
    });

    it('can be used by someone who may edit a course but not create one', async () => {
      const course = await fixtures.createCourse(agent, { title: 'Editor' });
      const editor = await fixtures.agentFor('GRAPHIC_DESIGNER');
      const saved = await editor
        .put(`/api/backoffice/courses/${course.id}/information`)
        .send({ localizations: { 'en-GB': { overview: 'By an editor' } } });
      expect(saved.status).toBe(200);
      const created = await editor
        .post('/api/backoffice/courses')
        .send({ title: 'Not allowed' });
      expect(created.status).toBe(403);
    });
  });
});
