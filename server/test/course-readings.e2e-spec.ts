import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import type TestAgent from 'supertest/lib/agent';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { CourseFixtures } from './helpers/course-fixture';
import type { ErrorResponse, SuccessResponse } from './helpers/http-response';

interface SavedReading {
  id: string;
  type: string;
  title: string;
  author: string;
  whyRecommended: string;
  sortOrder: number;
}

interface ImportResult {
  rowsRead: number;
  added: number;
  byLesson: Array<{ lessonCode: string; added: number }>;
  errors: Array<{ row: number; message: string }>;
}

const BOM = String.fromCharCode(0xfeff);
const HEADER =
  'Course ID,Lesson ID,Lesson title,Type,Title,Author,Why we recommend it';

/**
 * Recommended reading is one English list per lesson. It saves what was typed (a blank
 * author is saved and reported as incomplete), keeps row ids, and imports from a spreadsheet
 * in one transaction, reporting each row it could not take.
 */
describe('Recommended reading (e2e)', () => {
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

  async function course(lessonCount = 1) {
    const made = await fixtures.createCourse(agent, { title: 'Reading' });
    const lessons: Array<{ id: string; code: string }> = [];
    for (let index = 0; index < lessonCount; index++) {
      lessons.push(await fixtures.createLesson(agent, made.id));
    }
    return { course: made, lessons };
  }

  const readingsUrl = (courseId: string, lessonId: string) =>
    `/api/backoffice/courses/${courseId}/lessons/${lessonId}/readings`;

  function save(
    courseId: string,
    lessonId: string,
    readings: unknown,
    language: string | undefined = 'en-GB',
  ) {
    return agent
      .put(readingsUrl(courseId, lessonId))
      .send({ language, readings });
  }

  async function saved(
    courseId: string,
    lessonId: string,
    readings: unknown[],
  ) {
    const response: SuccessResponse<{ readings: SavedReading[] }> = await save(
      courseId,
      lessonId,
      readings,
    );
    expect(response.status).toBe(200);
    return response.body.data.readings;
  }

  async function stored(lessonId: string) {
    return prisma.recommendedReading.findMany({
      where: { lessonId },
      orderBy: { sortOrder: 'asc' },
    });
  }

  const book = (title: string, extra: Record<string, unknown> = {}) => ({
    type: 'BOOK',
    title,
    author: 'An author',
    whyRecommended: 'Because',
    ...extra,
  });

  describe('save', () => {
    it('saves a reading whose author, reason and title are blank', async () => {
      const { course: made, lessons } = await course();
      await saved(made.id, lessons[0].id, [
        { type: 'Article', title: '', author: '', whyRecommended: '' },
        { type: 'Paper' },
      ]);
      const rows = await stored(lessons[0].id);
      expect(rows.map((row) => [row.type, row.title, row.language])).toEqual([
        ['ARTICLE', '', 'en-GB'],
        ['PAPER', '', 'en-GB'],
      ]);

      // and the course says what is missing instead of refusing the save
      const detail: SuccessResponse<{
        completeness: { issues: Array<{ field: string }> };
      }> = await agent.get(`/api/backoffice/courses/${made.id}`).expect(200);
      expect(
        detail.body.data.completeness.issues.map((issue) => issue.field),
      ).toEqual(expect.arrayContaining(['readings[0].title']));
    });

    it('stores the list as English whatever language the request names', async () => {
      const { course: made, lessons } = await course();
      await saved(made.id, lessons[0].id, [book('One')]);
      await save(made.id, lessons[0].id, [book('One'), book('Two')], 'zh-CN');
      const rows = await stored(lessons[0].id);
      expect(rows.map((row) => [row.title, row.language])).toEqual([
        ['One', 'en-GB'],
        ['Two', 'en-GB'],
      ]);
      await save(made.id, lessons[0].id, [book('Three')], undefined);
      expect((await stored(lessons[0].id)).map((row) => row.title)).toEqual([
        'Three',
      ]);
    });

    it('turns a list kept under another language into the one English list', async () => {
      const { course: made, lessons } = await course();
      const old = await prisma.recommendedReading.create({
        data: {
          lessonId: lessons[0].id,
          language: 'zh-CN',
          type: 'BOOK',
          title: 'Old',
          author: 'A',
          whyRecommended: 'B',
          sortOrder: 0,
        },
      });
      await saved(made.id, lessons[0].id, [
        { id: old.id, ...book('Old, kept') },
        book('New'),
      ]);
      const rows = await stored(lessons[0].id);
      expect(rows.map((row) => [row.title, row.language])).toEqual([
        ['Old, kept', 'en-GB'],
        ['New', 'en-GB'],
      ]);
      expect(rows[0].id).toBe(old.id);
    });

    it('refuses a type that is not Book, Article, Paper or Other, and saves nothing', async () => {
      const { course: made, lessons } = await course();
      await saved(made.id, lessons[0].id, [book('Keep')]);
      const response: ErrorResponse = await save(made.id, lessons[0].id, [
        book('New'),
        book('Bad', { type: 'Podcast' }),
      ]);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('READING_TYPE_INVALID');
      expect(response.body.error.details).toMatchObject({ row: 2 });
      expect((await stored(lessons[0].id)).map((row) => row.title)).toEqual([
        'Keep',
      ]);

      const blank: ErrorResponse = await save(made.id, lessons[0].id, [
        { title: 'No type' },
      ]);
      expect(blank.status).toBe(400);
      expect(blank.body.error.code).toBe('READING_TYPE_INVALID');
    });

    it('keeps the id of a row that is saved again, and follows the request order', async () => {
      const { course: made, lessons } = await course();
      const [first, second] = await saved(made.id, lessons[0].id, [
        book('One'),
        book('Two'),
      ]);

      const again = await saved(made.id, lessons[0].id, [
        { id: second.id, ...book('Two, edited') },
        { id: first.id, ...book('One') },
        book('Three'),
      ]);

      expect(again.map((row) => row.id).slice(0, 2)).toEqual([
        second.id,
        first.id,
      ]);
      const rows = await stored(lessons[0].id);
      expect(rows.map((row) => row.title)).toEqual([
        'Two, edited',
        'One',
        'Three',
      ]);
      expect(rows.map((row) => row.sortOrder)).toEqual([0, 1, 2]);
    });

    it('deletes the rows that are left out of the list', async () => {
      const { course: made, lessons } = await course();
      const [first] = await saved(made.id, lessons[0].id, [
        book('One'),
        book('Two'),
      ]);
      await saved(made.id, lessons[0].id, [{ id: first.id, ...book('One') }]);
      expect((await stored(lessons[0].id)).map((row) => row.title)).toEqual([
        'One',
      ]);
      await saved(made.id, lessons[0].id, []);
      expect(await stored(lessons[0].id)).toHaveLength(0);
    });

    it('does not take a row id that belongs to another lesson', async () => {
      const { course: made, lessons } = await course(2);
      const [other] = await saved(made.id, lessons[1].id, [book('Other')]);
      await saved(made.id, lessons[0].id, [{ id: other.id, ...book('Mine') }]);
      expect((await stored(lessons[1].id)).map((row) => row.title)).toEqual([
        'Other',
      ]);
      const mine = await stored(lessons[0].id);
      expect(mine.map((row) => row.title)).toEqual(['Mine']);
      expect(mine[0].id).not.toBe(other.id);
    });
  });

  describe('import', () => {
    function upload(courseId: string, csv: string | Buffer, name = 'r.csv') {
      return agent
        .post(`/api/backoffice/courses/${courseId}/readings/import`)
        .attach('file', Buffer.isBuffer(csv) ? csv : Buffer.from(csv), name);
    }

    async function imported(courseId: string, csv: string | Buffer) {
      const response: SuccessResponse<ImportResult> = await upload(
        courseId,
        csv,
      );
      expect(response.status).toBe(201);
      return response.body.data;
    }

    it('adds the good rows, says what is wrong with the others, and counts per lesson', async () => {
      const { course: made, lessons } = await course(2);
      const csv = [
        HEADER,
        `${made.code},${lessons[0].code},,Book,Alpha,Ann,Because`,
        `${made.code},${lessons[0].code},,Podcast,Beta,Bob,Because`,
        `${made.code},L010,,Book,Gamma,Cy,Because`,
        `${made.code},${lessons[1].code},,Paper,Delta,Di,Because`,
        `${made.code},${lessons[0].code},,Article,Echo,Ed,Because`,
      ].join('\n');

      const result = await imported(made.id, csv);

      expect(result).toEqual({
        rowsRead: 5,
        added: 3,
        byLesson: [
          { lessonCode: lessons[0].code, added: 2 },
          { lessonCode: lessons[1].code, added: 1 },
        ],
        errors: [
          {
            row: 3,
            message: 'Row 3 · Type must be Book, Article, Paper or Other',
          },
          { row: 4, message: "Row 4 · Lesson ID L010 doesn't exist" },
        ],
      });
      expect((await stored(lessons[0].id)).map((row) => row.title)).toEqual([
        'Alpha',
        'Echo',
      ]);
      expect((await stored(lessons[1].id)).map((row) => row.title)).toEqual([
        'Delta',
      ]);
    });

    it('adds after what the lesson already has', async () => {
      const { course: made, lessons } = await course();
      await saved(made.id, lessons[0].id, [book('Existing')]);
      await imported(
        made.id,
        `${HEADER}\n${made.code},${lessons[0].code},,Book,Added,Ann,Because\n`,
      );
      expect((await stored(lessons[0].id)).map((row) => row.title)).toEqual([
        'Existing',
        'Added',
      ]);
    });

    it('imports a row with a blank author and skips template rows nobody filled in', async () => {
      const { course: made, lessons } = await course(2);
      const result = await imported(
        made.id,
        [
          HEADER,
          `${made.code},${lessons[0].code},Lesson one,Book,Alpha,,`,
          `${made.code},${lessons[1].code},Lesson two,,,,`,
        ].join('\n'),
      );
      expect(result).toMatchObject({ rowsRead: 1, added: 1, errors: [] });
      expect((await stored(lessons[0].id))[0]).toMatchObject({
        title: 'Alpha',
        language: 'en-GB',
      });
      expect(await stored(lessons[1].id)).toHaveLength(0);
    });

    it('reads a CSV saved with a BOM and accented text', async () => {
      const { course: made, lessons } = await course();
      const result = await imported(
        made.id,
        `${BOM}${HEADER}\r\n${made.code},${lessons[0].code},,Book,"Models, big and small",Müller 王,Because\r\n`,
      );
      expect(result.added).toBe(1);
      expect((await stored(lessons[0].id))[0]).toMatchObject({
        title: 'Models, big and small',
        author: 'Müller 王',
      });
    });

    it('refuses a file with the wrong columns and adds nothing', async () => {
      const { course: made, lessons } = await course();
      const response: ErrorResponse = await upload(
        made.id,
        `Lesson ID,Question,Reference answer\n${lessons[0].code},Why?,Because\n`,
      );
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('READING_COLUMNS_INVALID');
      expect(response.body.error.details).toMatchObject({
        missing: ['Type', 'Title', 'Author', 'Why we recommend it'],
      });
      expect(await stored(lessons[0].id)).toHaveLength(0);
    });

    it('leaves nothing behind when the database fails part way', async () => {
      const { course: made, lessons } = await course();
      const csv = [
        HEADER,
        `${made.code},${lessons[0].code},,Book,Alpha,Ann,Because`,
        // Postgres cannot store a NUL character in text: this row fails after the first went in
        `${made.code},${lessons[0].code},,Book,Beta,Bo\u0000b,Because`,
      ].join('\n');
      const response = await upload(made.id, csv);
      expect(response.status).toBe(500);
      expect(await stored(lessons[0].id)).toHaveLength(0);
    });
  });

  describe('template', () => {
    it('starts with a BOM, is prefilled, and has the same width on every row', async () => {
      const { course: made, lessons } = await course(2);
      await agent
        .put(`/api/backoffice/courses/${made.id}/lessons/${lessons[0].id}`)
        .send({ language: 'en-GB', title: 'Models, and more' })
        .expect(200);

      const response = await agent
        .get(`/api/backoffice/courses/${made.id}/readings/template`)
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);

      const bytes = response.body as Buffer;
      expect(response.headers['content-type']).toContain('text/csv');
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const text = bytes.toString('utf8').slice(1);
      const lines = text.trim().split(/\r?\n/);
      expect(lines[0]).toBe(HEADER);
      expect(lines).toHaveLength(3);
      expect(lines[1]).toBe(
        `${made.code},${lessons[0].code},"Models, and more",,,,`,
      );
      expect(lines[2]).toMatch(
        new RegExp(`^${made.code},${lessons[1].code},[^,]*,,,,$`),
      );
    });

    it('can be filled in and imported back', async () => {
      const { course: made, lessons } = await course();
      const template = await agent
        .get(`/api/backoffice/courses/${made.id}/readings/template`)
        .expect(200);
      const rows = String(template.text).trim().split(/\r?\n/);
      expect(rows[1]).toMatch(new RegExp(`^${made.code},${lessons[0].code},`));
      rows[1] = rows[1].replace(/,,,,$/, ',Book,Alpha,Ann,Because');
      const response: SuccessResponse<ImportResult> = await agent
        .post(`/api/backoffice/courses/${made.id}/readings/import`)
        .attach('file', Buffer.from(`${rows.join('\r\n')}\r\n`), 'filled.csv');
      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({ rowsRead: 1, added: 1 });
    });

    it('is not available for a course that does not exist', async () => {
      await agent
        .get(
          '/api/backoffice/courses/00000000-0000-0000-0000-000000000000/readings/template',
        )
        .expect(404);
    });
  });
});
