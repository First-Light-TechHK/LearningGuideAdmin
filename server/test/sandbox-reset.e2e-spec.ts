import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { SandboxResetService } from '../src/commerce-courses/sandbox-reset.service';
import { PrismaService } from '../src/prisma/prisma.service';
import type { ErrorResponse, SuccessResponse } from './helpers/http-response';
import { signInAs } from './helpers/employee-session';

/**
 * Sandbox 课程内容重置（Sandbox 专项）。
 * 需要 PG；只在 APP_ENV=SANDBOX 且 SANDBOX_RESET_ENABLED=true 的测试进程里跑，
 * 并以 --runInBand 执行（会清空课程域，不能与其它会建课程的 e2e 并发）。
 */
describe('Sandbox reset (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let resets: SandboxResetService;
  let admin: Awaited<ReturnType<typeof signInAs>>;
  let tempRoot: string;
  const originalEnv = {
    APP_ENV: process.env.APP_ENV,
    SANDBOX_RESET_ENABLED: process.env.SANDBOX_RESET_ENABLED,
    PACKAGE_JOB_POLL_MS: process.env.PACKAGE_JOB_POLL_MS,
    COURSE_PACKAGE_ROOT: process.env.COURSE_PACKAGE_ROOT,
    COURSE_MEDIA_ROOT: process.env.COURSE_MEDIA_ROOT,
  };
  const stamp = Date.now();

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-sandbox-reset-'));
    process.env.APP_ENV = 'SANDBOX';
    process.env.SANDBOX_RESET_ENABLED = 'true';
    // 关掉轮询，测试里手动 claim/execute，避免与 worker 抢作业。
    process.env.PACKAGE_JOB_POLL_MS = '60000';
    process.env.COURSE_PACKAGE_ROOT = path.join(tempRoot, 'package');
    process.env.COURSE_MEDIA_ROOT = path.join(tempRoot, 'media');

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    resets = app.get(SandboxResetService);
    admin = await signInAs(app, 'ADMIN');
  });

  afterAll(async () => {
    await prisma.sandboxResetJob.deleteMany({}).catch(() => undefined);
    await app.close();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  function restoreAppEnv(): void {
    process.env.APP_ENV = 'SANDBOX';
  }

  it('exposes the reset state and impact only to ADMIN', async () => {
    const state: SuccessResponse<{
      enabled: boolean;
      environment: string;
      impact: { courses: number };
    }> = await admin.get('/api/backoffice/sandbox/reset').expect(200);
    expect(state.body.data.enabled).toBe(true);
    expect(state.body.data.environment).toBe('SANDBOX');
    expect(typeof state.body.data.impact.courses).toBe('number');

    const operationAdmin = await signInAs(app, 'OPERATION_ADMIN');
    await operationAdmin.get('/api/backoffice/sandbox/reset').expect(403);
  });

  it('is disabled outside a sandbox environment', async () => {
    process.env.APP_ENV = 'UAT';
    try {
      const denied: ErrorResponse = await admin
        .get('/api/backoffice/sandbox/reset')
        .expect(403);
      expect(denied.body.error.code).toBe('SANDBOX_RESET_DISABLED');
    } finally {
      restoreAppEnv();
    }
  });

  it('requires the confirmation phrase, a reason and a non-empty scope', async () => {
    const missingConfirm: ErrorResponse = await admin
      .post('/api/backoffice/sandbox/reset')
      .send({ confirm: 'reset sandbox', reason: 'why' })
      .expect(409);
    expect(missingConfirm.body.error.code).toBe('RESET_CONFIRMATION_REQUIRED');

    const emptyScope: ErrorResponse = await admin
      .post('/api/backoffice/sandbox/reset')
      .send({
        confirm: 'RESET SANDBOX',
        reason: 'why',
        scope: {
          courses: false,
          media: false,
          staging: false,
          packageJobs: false,
          resetCodeCounters: false,
        },
      })
      .expect(422);
    expect(emptyScope.body.error.code).toBe('RESET_SCOPE_EMPTY');
  });

  it('refuses to start while an import job is active', async () => {
    const job = await prisma.coursePackageJob.create({
      data: { kind: 'IMPORT', status: 'VALIDATING' },
    });
    try {
      const busy: ErrorResponse = await admin
        .post('/api/backoffice/sandbox/reset')
        .send({ confirm: 'RESET SANDBOX', reason: 'fresh import' })
        .expect(409);
      expect(busy.body.error.code).toBe('RESET_BUSY');
    } finally {
      await prisma.coursePackageJob.delete({ where: { id: job.id } });
    }
  });

  it('clears courses, versions, media and package jobs but keeps employees, settings and categories', async () => {
    const course = await prisma.commerceCourse.create({
      data: {
        code: `E2E-RESET-${stamp}`,
        slug: `e2e-reset-${stamp}`,
        learningMode: 'VIDEO_ONLY',
        learningLanguages: ['en-GB'],
      },
    });
    await prisma.courseVersion.create({
      data: {
        courseId: course.id,
        versionNo: 1,
        snapshotData: {},
      },
    });
    await prisma.courseMediaAsset.create({
      data: {
        courseId: course.id,
        kind: 'IMAGE',
        originalName: 'cover.png',
        mimeType: 'image/png',
        extension: 'png',
        size: 123,
        storageKey: `course-media/${course.id}/cover.png`,
      },
    });
    await prisma.coursePackageJob.create({
      data: { kind: 'EXPORT', status: 'READY', courseId: course.id },
    });
    const setting = await prisma.backofficeSetting.create({
      data: { key: `e2e.reset.${stamp}`, value: 'kept' },
    });
    const category = await prisma.courseCatalogueEntry.create({
      data: { name: `E2E Reset Category ${stamp}` },
    });
    await prisma.courseCodeCounter.create({
      data: { key: `e2e-reset-counter-${stamp}`, next: 5 },
    });
    const employeesBefore = await prisma.employee.count();

    const created: SuccessResponse<{ jobId: string }> = await admin
      .post('/api/backoffice/sandbox/reset')
      .send({
        confirm: 'RESET SANDBOX',
        reason: 'e2e full reset',
        scope: {},
      })
      .expect(202);
    const jobId = created.body.data.jobId;

    // 手动执行（轮询已关闭）：领取 → 执行。
    expect(await resets.claimNext()).toBe(jobId);
    await resets.execute(jobId);

    const finished: SuccessResponse<{ status: string; report: unknown }> =
      await admin.get(`/api/backoffice/sandbox/reset/${jobId}`).expect(200);
    expect(finished.body.data.status).toBe('SUCCEEDED');

    expect(
      await prisma.commerceCourse.count({ where: { id: course.id } }),
    ).toBe(0);
    expect(
      await prisma.courseVersion.count({ where: { courseId: course.id } }),
    ).toBe(0);
    expect(
      await prisma.courseMediaAsset.count({ where: { courseId: course.id } }),
    ).toBe(0);
    expect(await prisma.coursePackageJob.count()).toBe(0);
    expect(
      await prisma.backofficeSetting.count({ where: { key: setting.key } }),
    ).toBe(1);
    expect(
      await prisma.courseCatalogueEntry.count({ where: { id: category.id } }),
    ).toBe(1);
    expect(await prisma.employee.count()).toBe(employeesBefore);

    // 默认 scope 清空编号计数器
    expect(
      await prisma.courseCodeCounter.count({
        where: { key: `e2e-reset-counter-${stamp}` },
      }),
    ).toBe(0);

    const audit = await prisma.auditEvent.findMany({
      where: {
        eventName: {
          in: ['SANDBOX_RESET_REQUESTED', 'SANDBOX_RESET_COMPLETED'],
        },
        newValue: { contains: jobId },
      },
      select: { eventName: true },
    });
    expect(audit.map((row) => row.eventName).sort()).toEqual([
      'SANDBOX_RESET_COMPLETED',
      'SANDBOX_RESET_REQUESTED',
    ]);
  });

  it('keeps code counters when resetCodeCounters is false', async () => {
    const counter = await prisma.courseCodeCounter.create({
      data: { key: `e2e-reset-keep-${stamp}`, next: 9 },
    });

    const created: SuccessResponse<{ jobId: string }> = await admin
      .post('/api/backoffice/sandbox/reset')
      .send({
        confirm: 'RESET SANDBOX',
        reason: 'keep counters',
        scope: { resetCodeCounters: false },
      })
      .expect(202);
    const jobId = created.body.data.jobId;

    expect(await resets.claimNext()).toBe(jobId);
    await resets.execute(jobId);

    expect(
      await prisma.courseCodeCounter.count({ where: { key: counter.key } }),
    ).toBe(1);
  });

  it('does not expose the reset endpoint in a non-sandbox app environment', async () => {
    process.env.APP_ENV = 'SIT';
    try {
      const denied: ErrorResponse = await admin
        .get('/api/backoffice/sandbox/reset')
        .expect(403);
      expect(denied.body.error.code).toBe('SANDBOX_RESET_DISABLED');
      const state = await resets.state().catch((error: unknown) => error);
      expect(state).toMatchObject({ code: 'SANDBOX_RESET_DISABLED' });
    } finally {
      restoreAppEnv();
    }
  });
});
