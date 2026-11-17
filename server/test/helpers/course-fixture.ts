import { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import type TestAgent from 'supertest/lib/agent';

import { PrismaService } from '../../src/prisma/prisma.service';
import type { SuccessResponse } from './http-response';
import { signInAs } from './employee-session';

/**
 * Course fixtures for the course e2e suites: create a course through the real API (so the
 * code allocator, slug and History run as in production) and seed lesson content straight
 * into the database where driving every editor endpoint would only hide what a test is about.
 *
 * Every course made here is remembered, so `removeCourses` can clean up whatever a test
 * leaves behind, whether or not it knew the code (codes are allocated by the server).
 */
export interface CourseFixture {
  id: string;
  code: string;
  slug: string;
}

export class CourseFixtures {
  private readonly created: string[] = [];

  constructor(
    private readonly app: INestApplication<App>,
    private readonly prisma: PrismaService,
  ) {}

  async admin(): Promise<TestAgent> {
    return signInAs(this.app, 'ADMIN');
  }

  /** Sign in as another role, for the permission checks. */
  async agentFor(role: string): Promise<TestAgent> {
    return signInAs(this.app, role);
  }

  /** Create a course through `POST /api/backoffice/courses`. Extra body keys are sent as is. */
  async createCourse(
    agent: TestAgent,
    body: Record<string, unknown> = {},
  ): Promise<CourseFixture> {
    const response: SuccessResponse<CourseFixture> = await agent
      .post('/api/backoffice/courses')
      .send({ title: `Fixture course ${Date.now()}`, ...body });
    if (response.status !== 201 && response.status !== 200) {
      throw new Error(
        `createCourse failed: ${response.status} ${JSON.stringify(response.body)}`,
      );
    }
    const { id, code, slug } = response.body.data;
    this.created.push(id);
    return { id, code, slug };
  }

  /** Remember a course made by other means (an import, a direct insert) for cleanup. */
  track(courseId: string): void {
    this.created.push(courseId);
  }

  /**
   * Create a lesson through the API; returns its id and the code the server gave it.
   * The endpoint answers with the whole course, so the new lesson is the last one.
   */
  async createLesson(
    agent: TestAgent,
    courseId: string,
    body: Record<string, unknown> = { title: 'Lesson' },
  ): Promise<{ id: string; code: string; sortOrder: number }> {
    const response: SuccessResponse<{
      lessons: Array<{ id: string; code: string; sortOrder: number }>;
    }> = await agent
      .post(`/api/backoffice/courses/${courseId}/lessons`)
      .send(body)
      .expect(201);
    const lessons = [...response.body.data.lessons].sort(
      (a, b) => a.sortOrder - b.sortOrder,
    );
    const { id, code, sortOrder } = lessons[lessons.length - 1];
    return { id, code, sortOrder };
  }

  /** Seed a video learning point (V code, time in seconds) directly in the database. */
  async seedVideoPoint(
    lessonId: string,
    language: string,
    code: string,
    title: string,
    timeSeconds: number | null,
    sortOrder = 0,
  ): Promise<{ id: string }> {
    return this.prisma.learningPoint.create({
      data: {
        lessonId,
        language,
        code,
        source: 'VIDEO',
        title,
        timeSeconds,
        sortOrder,
      },
      select: { id: true },
    });
  }

  /** Delete every course this fixture made, newest first, children included. */
  async removeCourses(): Promise<void> {
    for (const id of this.created.splice(0).reverse()) {
      await this.prisma.commerceCourse
        .update({ where: { id }, data: { liveVersionId: null } })
        .catch(() => undefined);
      await this.prisma.courseVersion
        .deleteMany({ where: { courseId: id } })
        .catch(() => undefined);
      await this.prisma.commerceCourse
        .delete({ where: { id } })
        .catch(() => undefined);
    }
  }
}
