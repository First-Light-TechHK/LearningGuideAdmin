import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { CourseFixtures } from './helpers/course-fixture';
import type { SuccessResponse } from './helpers/http-response';

/**
 * Codes people see (PRD ID table): allocated once by the server, never typed, never reused.
 */
describe('Course identity (e2e)', () => {
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

  function numberOf(code: string): number {
    return Number(code.slice(1));
  }

  it('gives two courses created at the same moment two different C-style codes', async () => {
    const agent = await fixtures.admin();
    const [first, second] = await Promise.all([
      fixtures.createCourse(agent, { title: 'Parallel Alpha' }),
      fixtures.createCourse(agent, { title: 'Parallel Beta' }),
    ]);
    expect(first.code).toMatch(/^C\d{3,}$/);
    expect(second.code).toMatch(/^C\d{3,}$/);
    expect(first.code).not.toBe(second.code);
    // other suites create courses at the same time, so only distinctness can be asserted
  });

  it('ignores a Course ID typed by the Operator and returns the real one', async () => {
    const agent = await fixtures.admin();
    const created = await fixtures.createCourse(agent, {
      title: 'Typed code',
      code: 'my-own-code',
    });
    expect(created.code).toMatch(/^C\d{3,}$/);
  });

  it('skips a code that a package import already took', async () => {
    const agent = await fixtures.admin();
    const peek: SuccessResponse<{ code: string }> = await agent
      .get('/api/backoffice/courses/next-code')
      .expect(200);
    const taken = peek.body.data.code;
    const imported = await prisma.commerceCourse.create({
      data: {
        code: taken,
        slug: `imported-${taken.toLowerCase()}`,
        learningMode: 'VIDEO_AND_TEXT',
        learningLanguages: ['en-GB'],
      },
    });
    fixtures.track(imported.id);

    const created = await fixtures.createCourse(agent, {
      title: 'After import',
    });
    expect(created.code).not.toBe(taken);
    expect(numberOf(created.code)).toBeGreaterThan(numberOf(taken));
  });

  it('creates two courses whose titles have no Latin letters', async () => {
    const agent = await fixtures.admin();
    const first = await fixtures.createCourse(agent, { title: '建模人生' });
    const second = await fixtures.createCourse(agent, { title: '量子世界' });
    expect(first.code).not.toBe(second.code);
    expect(first.slug).not.toBe(second.slug);
    expect(first.slug).toBe(first.code.toLowerCase());
  });

  it('creates two courses with the same title', async () => {
    const agent = await fixtures.admin();
    const first = await fixtures.createCourse(agent, { title: 'Same Title' });
    const second = await fixtures.createCourse(agent, { title: 'Same Title' });
    expect(first.slug).not.toBe(second.slug);
  });

  it('shows the code the next create will assign', async () => {
    const agent = await fixtures.admin();
    // Suites run side by side and any of them may create a course between the peek and the
    // create, so a few tries are allowed; a peek that took the code would never match.
    const seen: string[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const peek: SuccessResponse<{ code: string }> = await agent
        .get('/api/backoffice/courses/next-code')
        .expect(200);
      const created = await fixtures.createCourse(agent, { title: 'Peeked' });
      seen.push(`${peek.body.data.code}>${created.code}`);
      if (created.code === peek.body.data.code) return;
    }
    throw new Error(
      `The peeked code was never the one assigned: ${seen.join(', ')}`,
    );
  });

  it('never repeats a code across 20 parallel creates', async () => {
    const agent = await fixtures.admin();
    const created = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        fixtures.createCourse(agent, { title: `Burst ${i}` }),
      ),
    );
    const codes = created.map((course) => course.code);
    expect(new Set(codes).size).toBe(20);
    for (const code of codes) expect(code).toMatch(/^C\d{3,}$/);
  });

  it('answers 400 for a title that is not text', async () => {
    const agent = await fixtures.admin();
    const response = await agent
      .post('/api/backoffice/courses')
      .send({ title: 12345 });
    expect(response.status).toBe(400);
  });

  it('lets a viewer read the next code but not create', async () => {
    const viewer = await fixtures.agentFor('COURSE_CREATOR');
    await viewer.get('/api/backoffice/courses/next-code').expect(200);
    await viewer
      .post('/api/backoffice/courses')
      .send({ title: 'Nope' })
      .expect(403);
  });
});
