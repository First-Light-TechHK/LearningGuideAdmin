import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import JSZip from 'jszip';
import { App } from 'supertest/types';
import type TestAgent from 'supertest/lib/agent';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { CourseStorageService } from '../src/commerce-courses/storage.service';
import { CourseFixtures } from './helpers/course-fixture';
import type { ErrorResponse, SuccessResponse } from './helpers/http-response';

// 直传上限按真实配置（默认 200MB）无法用内存文件验证，本套件把它调到 1MB；
// 分块会话的 8GB 上限仍走默认的 PACKAGE_MAX_BYTES。
const ORIGINAL_DIRECT_UPLOAD_BYTES = process.env.PACKAGE_DIRECT_UPLOAD_BYTES;
process.env.PACKAGE_DIRECT_UPLOAD_BYTES = String(1024 * 1024);
// 导出作业由 worker 轮询处理；缩短轮询间隔（只影响本进程的 e2e）。
process.env.PACKAGE_JOB_POLL_MS =
  process.env.PACKAGE_JOB_POLL_MS ??
  process.env.E2E_PACKAGE_JOB_POLL_MS ??
  '100';

interface JobView {
  jobId: string;
  kind: string;
  status: string;
  error: string | null;
  courseId: string | null;
  versionLabel?: string | null;
  fileLabel?: string | null;
  report: {
    errors: Array<{ code: string; message: string; path?: string }>;
    warnings: Array<{ code: string; message: string; path?: string }>;
  };
  conflict?: {
    existingCourseId: string;
    existingCourseCode: string;
    live: boolean;
  } | null;
}

interface ConfirmView {
  jobId: string;
  status: string;
  courseId?: string;
  refused?: string;
  requiresOverwrite?: boolean;
}

interface ExportStartView {
  jobId: string;
  status: string;
  versionId: string | null;
  versionLabel: string;
  fileName: string;
}

/** 24 字节的 ftyp 头 + 可带 mvhd 的 moov 片段（够 validateMediaFile 与 mvhd 解析用）。 */
function mp4Bytes(durationSeconds: number | null): Buffer {
  const ftyp = Buffer.alloc(24);
  ftyp.writeUInt32BE(24, 0);
  ftyp.write('ftyp', 4, 'ascii');
  ftyp.write('isom', 8, 'ascii');
  if (durationSeconds === null) {
    // 有合法 ftyp 签名、但没有 mvhd：探测应失败
    return Buffer.concat([ftyp, Buffer.alloc(24)]);
  }
  const mvhd = Buffer.alloc(28);
  mvhd.write('mvhd', 0, 'ascii');
  mvhd.writeUInt8(0, 4); // version 0
  mvhd.writeUInt32BE(1000, 4 + 12); // timescale
  mvhd.writeUInt32BE(Math.round(durationSeconds * 1000), 4 + 16); // duration
  return Buffer.concat([ftyp, mvhd]);
}

function packageManifest(options: {
  code: string;
  slug: string;
  title?: string;
  /** undefined = 省略可选 durationSeconds（导入时探测）；null = 显式不写（用于探测失败包）。 */
  durationSeconds?: number;
  includeDuration: boolean;
}) {
  const video: Record<string, unknown> = {
    file: 'media/video/L001/en-GB.mp4',
    learningPoints: [{ code: 'V1', timeSeconds: 1, title: 'First point' }],
    exhibitTriggers: [],
  };
  if (options.includeDuration) {
    video.durationSeconds = options.durationSeconds ?? 3;
  }
  return {
    format: 'lg-course-package',
    formatVersion: 1,
    packageId: `pkg_${options.code}_${Date.now().toString(36)}`,
    exportedAt: new Date().toISOString(),
    source: {
      environment: 'E2E',
      courseCode: options.code,
      sourceVersion: 'working',
    },
    incomplete: false,
    course: {
      code: options.code,
      slug: options.slug,
      category: 'E2E Science',
      learningMode: 'VIDEO_ONLY',
      learningLanguages: ['en-GB'],
      defaultContentLanguage: 'en-GB',
      localized: {
        'en-GB': {
          title: options.title ?? `Package ${options.code}`,
          shortDescription: 'Short description',
          overview: 'Overview',
          whatYouLearn: ['one', 'two', 'three', 'four'],
          provides: [],
        },
      },
      lessons: [
        {
          code: 'L001',
          order: 1,
          exhibits: [],
          localized: {
            'en-GB': {
              title: 'Lesson one',
              description: 'Lesson description',
              video,
            },
          },
          recommendedReading: {},
          knowledgeTest: { enabled: false, questions: [] },
        },
      ],
      trial: { enabled: false, lessons: [] },
      pricing: [],
    },
  };
}

async function zipPackage(
  manifest: unknown,
  video: Buffer = mp4Bytes(3),
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('media/video/L001/en-GB.mp4', video);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

describe('Course package QA fixes 2026-11-20 (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let fixtures: CourseFixtures;
  let agent: TestAgent;
  const createdJobIds: string[] = [];

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
    await prisma.coursePackageJob.deleteMany({
      where: { id: { in: createdJobIds } },
    });
    await fixtures.removeCourses();
    await app.close();
    if (ORIGINAL_DIRECT_UPLOAD_BYTES === undefined) {
      delete process.env.PACKAGE_DIRECT_UPLOAD_BYTES;
    } else {
      process.env.PACKAGE_DIRECT_UPLOAD_BYTES = ORIGINAL_DIRECT_UPLOAD_BYTES;
    }
  });

  async function uploadPackage(zip: Buffer): Promise<JobView> {
    const response: SuccessResponse<JobView> = await agent
      .post('/api/backoffice/courses/import')
      .attach('file', zip, 'qa.lgcourse.zip')
      .expect(201);
    createdJobIds.push(response.body.data.jobId);
    return response.body.data;
  }

  async function confirm(
    jobId: string,
    body: Record<string, unknown>,
  ): Promise<{
    status: number;
    body: { data?: ConfirmView; error?: { code: string; message: string } };
  }> {
    const response = await agent
      .post(`/api/backoffice/courses/import/${jobId}/confirm`)
      .send(body);
    return {
      status: response.status,
      body: response.body as {
        data?: ConfirmView;
        error?: { code: string; message: string };
      },
    };
  }

  async function importPackage(
    zip: Buffer,
    confirmBody: Record<string, unknown> = { onConflict: 'ABORT' },
  ): Promise<{ job: JobView; courseId: string }> {
    const uploaded = await uploadPackage(zip);
    expect(uploaded.status).toBe('AWAITING_CONFIRM');
    expect(uploaded.report.errors).toEqual([]);
    const confirmed = await confirm(uploaded.jobId, confirmBody);
    expect(confirmed.status).toBe(200);
    const courseId = confirmed.body.data?.courseId as string;
    fixtures.track(courseId);
    return { job: uploaded, courseId };
  }

  // ===== MED-1: 省略 durationSeconds 时按真实文件探测 =====

  describe('MED-1 video duration probing', () => {
    it('probes mvhd when the manifest omits durationSeconds and stores the real length', async () => {
      const suffix = randomUUID().slice(0, 8);
      const code = `E2E-DUR-${suffix.toUpperCase()}`;
      const zip = await zipPackage(
        packageManifest({
          code,
          slug: `e2e-dur-${suffix}`,
          includeDuration: false,
        }),
        mp4Bytes(3),
      );
      const { job, courseId } = await importPackage(zip);

      // 探测值落库：3 秒的 mvhd → videoDurationSeconds = 3
      const lesson = await prisma.lesson.findFirstOrThrow({
        where: { courseId, code: 'L001' },
      });
      const loc = await prisma.lessonLocalization.findFirstOrThrow({
        where: { lessonId: lesson.id, language: 'en-GB' },
      });
      expect(loc.videoDurationSeconds).toBe(3);

      // 导入报告没有"时长读不出"的 warning
      const status: SuccessResponse<JobView> = await agent
        .get(`/api/backoffice/courses/import/${job.jobId}`)
        .expect(200);
      expect(
        status.body.data.report.warnings.filter(
          (warning) => warning.code === 'VIDEO_DURATION_UNREADABLE',
        ),
      ).toEqual([]);

      // completeness 不再因为时长缺失而阻断该语言
      const detail: SuccessResponse<{
        completeness: {
          issues: Array<{ field: string; language?: string; code: string }>;
        };
      }> = await agent.get(`/api/backoffice/courses/${courseId}`).expect(200);
      expect(
        detail.body.data.completeness.issues.filter(
          (issue) =>
            issue.field === 'video.duration' &&
            issue.language === 'en-GB' &&
            issue.code === 'DURATION_UNREADABLE',
        ),
      ).toEqual([]);
    }, 60_000);

    it('keeps duration null and reports a warning when the file has no readable mvhd', async () => {
      const suffix = randomUUID().slice(0, 8);
      const code = `E2E-DURX-${suffix.toUpperCase()}`;
      const zip = await zipPackage(
        packageManifest({
          code,
          slug: `e2e-durx-${suffix}`,
          includeDuration: false,
        }),
        mp4Bytes(null),
      );
      const { job, courseId } = await importPackage(zip);

      const lesson = await prisma.lesson.findFirstOrThrow({
        where: { courseId, code: 'L001' },
      });
      const loc = await prisma.lessonLocalization.findFirstOrThrow({
        where: { lessonId: lesson.id, language: 'en-GB' },
      });
      expect(loc.videoDurationSeconds).toBeNull();

      const status: SuccessResponse<JobView> = await agent
        .get(`/api/backoffice/courses/import/${job.jobId}`)
        .expect(200);
      expect(
        status.body.data.report.warnings.some(
          (warning) => warning.code === 'VIDEO_DURATION_UNREADABLE',
        ),
      ).toBe(true);

      // 探测失败仍为 null：completeness 明确给出 DURATION_UNREADABLE
      const detail: SuccessResponse<{
        completeness: {
          issues: Array<{ field: string; language?: string; code: string }>;
        };
      }> = await agent.get(`/api/backoffice/courses/${courseId}`).expect(200);
      expect(
        detail.body.data.completeness.issues.some(
          (issue) =>
            issue.field === 'video.duration' &&
            issue.language === 'en-GB' &&
            issue.code === 'DURATION_UNREADABLE',
        ),
      ).toBe(true);
    }, 60_000);

    it('keeps an explicit durationSeconds instead of the probed value', async () => {
      const suffix = randomUUID().slice(0, 8);
      const code = `E2E-DURM-${suffix.toUpperCase()}`;
      const zip = await zipPackage(
        packageManifest({
          code,
          slug: `e2e-durm-${suffix}`,
          includeDuration: true,
          durationSeconds: 42,
        }),
        mp4Bytes(3),
      );
      const { courseId } = await importPackage(zip);
      const lesson = await prisma.lesson.findFirstOrThrow({
        where: { courseId, code: 'L001' },
      });
      const loc = await prisma.lessonLocalization.findFirstOrThrow({
        where: { lessonId: lesson.id, language: 'en-GB' },
      });
      expect(loc.videoDurationSeconds).toBe(42);
    }, 60_000);
  });

  // ===== MED-4: 冲突策略 =====

  describe('MED-4 conflict strategies', () => {
    it('returns 409 PACKAGE_CONFLICT for ABORT, 422 for unimplemented strategies, and keeps overwriteDraft', async () => {
      const suffix = randomUUID().slice(0, 8);
      const code = `E2E-CONF-${suffix.toUpperCase()}`;
      const slug = `e2e-conf-${suffix}`;
      const first = await importPackage(
        await zipPackage(
          packageManifest({
            code,
            slug,
            title: 'Original draft',
            includeDuration: true,
          }),
        ),
      );

      const conflictingJob = await uploadPackage(
        await zipPackage(
          packageManifest({
            code,
            slug: `${slug}-again`,
            title: 'Replacement draft',
            includeDuration: true,
          }),
        ),
      );
      expect(conflictingJob.status).toBe('AWAITING_CONFIRM');
      const preflight: SuccessResponse<JobView> = await agent
        .get(`/api/backoffice/courses/import/${conflictingJob.jobId}`)
        .expect(200);
      expect(preflight.body.data.conflict).toMatchObject({
        existingCourseId: first.courseId,
        existingCourseCode: code,
        live: false,
      });

      // ABORT：409 PACKAGE_CONFLICT，作业回到 AWAITING_CONFIRM 等待换策略/覆盖
      const abort = await confirm(conflictingJob.jobId, {
        onConflict: 'ABORT',
      });
      expect(abort.status).toBe(409);
      expect(abort.body.error?.code).toBe('PACKAGE_CONFLICT');
      expect(abort.body.data).toBeNull();
      const afterAbort = await prisma.coursePackageJob.findUniqueOrThrow({
        where: { id: conflictingJob.jobId },
      });
      expect(afterAbort.status).toBe('AWAITING_CONFIRM');

      // 未实现的策略不再静默返回 requiresOverwrite：明确 4xx
      const createNew = await confirm(conflictingJob.jobId, {
        onConflict: 'CREATE_NEW_COURSE',
      });
      expect(createNew.status).toBe(422);
      expect(createNew.body.error?.code).toBe(
        'PACKAGE_CONFLICT_STRATEGY_UNSUPPORTED',
      );
      const newVersion = await confirm(conflictingJob.jobId, {
        onConflict: 'NEW_VERSION',
      });
      expect(newVersion.status).toBe(422);
      expect(newVersion.body.error?.code).toBe(
        'PACKAGE_CONFLICT_STRATEGY_UNSUPPORTED',
      );

      // 未发生静默覆盖：原课程仍是原内容，且没有多出第二门课
      const beforeOverwrite = await prisma.courseLocalization.findFirstOrThrow({
        where: { courseId: first.courseId, language: 'en-GB' },
      });
      expect(beforeOverwrite.title).toBe('Original draft');
      expect(await prisma.commerceCourse.count({ where: { code } })).toBe(1);

      // overwriteDraft=true：保留覆盖既有草稿的行为
      const overwrite = await confirm(conflictingJob.jobId, {
        onConflict: 'ABORT',
        overwriteDraft: true,
      });
      expect(overwrite.status).toBe(200);
      expect(overwrite.body.data?.status).toBe('READY');
      expect(overwrite.body.data?.courseId).toBe(first.courseId);
      const afterOverwrite = await prisma.courseLocalization.findFirstOrThrow({
        where: { courseId: first.courseId, language: 'en-GB' },
      });
      expect(afterOverwrite.title).toBe('Replacement draft');
      expect(await prisma.commerceCourse.count({ where: { code } })).toBe(1);
    }, 60_000);

    it('refuses to overwrite a live course instead of silently replacing it', async () => {
      const suffix = randomUUID().slice(0, 8);
      const code = `E2E-LIVE-${suffix.toUpperCase()}`;
      const first = await importPackage(
        await zipPackage(
          packageManifest({
            code,
            slug: `e2e-live-${suffix}`,
            title: 'Live course',
            includeDuration: true,
          }),
        ),
      );
      const version = await prisma.courseVersion.create({
        data: {
          courseId: first.courseId,
          versionNo: 1,
          versionLabel: '1.1',
          snapshotData: {},
        },
      });
      await prisma.commerceCourse.update({
        where: { id: first.courseId },
        data: { liveVersionId: version.id },
      });

      const conflictingJob = await uploadPackage(
        await zipPackage(
          packageManifest({
            code,
            slug: `e2e-live-${suffix}-again`,
            title: 'Should not replace',
            includeDuration: true,
          }),
        ),
      );
      const outcome = await confirm(conflictingJob.jobId, {
        onConflict: 'ABORT',
        overwriteDraft: true,
      });
      expect(outcome.status).toBe(200);
      expect(outcome.body.data?.refused).toBe('COURSE_ALREADY_LIVE');
      const loc = await prisma.courseLocalization.findFirstOrThrow({
        where: { courseId: first.courseId, language: 'en-GB' },
      });
      expect(loc.title).toBe('Live course');
    }, 60_000);
  });

  // ===== MED-2 / B2: 导出只允许当前线上版本（PRD §16.2） =====

  describe('MED-2/B2 export selectors — only the current live version', () => {
    async function waitForExport(jobId: string): Promise<JobView> {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const response: SuccessResponse<JobView> = await agent
          .get(`/api/backoffice/courses/export/${jobId}`)
          .expect(200);
        const job = response.body.data;
        if (job.status === 'READY' || job.status === 'FAILED') return job;
        if (Date.now() > deadline) return job;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    async function startExport(
      courseId: string,
      body: Record<string, unknown>,
    ): Promise<ExportStartView> {
      const response: SuccessResponse<ExportStartView> = await agent
        .post(`/api/backoffice/courses/${courseId}/export`)
        .send(body)
        .expect(202);
      createdJobIds.push(response.body.data.jobId);
      return response.body.data;
    }

    /**
     * 造一门三步都完整的课并真实 Publish（PRD §16.2：线上版本 3 步完整才能导出）。
     * 课程/课时走真实 API，其余内容用 Prisma 补齐后由真实 publish 生成不可变快照；
     * 导出断言不 mock assertExportable。
     */
    async function createPublishableCourse(title: string) {
      const course = await fixtures.createCourse(agent, { title });
      const category = await prisma.courseCatalogueEntry.findFirstOrThrow({
        where: { name: 'Society' },
      });
      const items = ['one', 'two', 'three', 'four'];
      for (const [language, label] of [
        ['en-GB', title],
        ['zh-CN', `${title}（中文）`],
      ] as const) {
        await prisma.courseLocalization.update({
          where: { courseId_language: { courseId: course.id, language } },
          data: {
            title: label,
            shortDescription: 'Short description',
            overview: 'Overview',
            whatYouLearn: items,
            provides: items,
          },
        });
      }
      const coverBytes = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(16),
      ]);
      const cover = await prisma.courseMediaAsset.create({
        data: {
          courseId: course.id,
          kind: 'IMAGE',
          originalName: 'cover.png',
          mimeType: 'image/png',
          extension: 'png',
          size: coverBytes.length,
          storageKey: `e2e/${course.id}/export-cover.png`,
        },
      });
      await app
        .get(CourseStorageService)
        .putMedia(cover.storageKey, coverBytes);
      const videoBytes = mp4Bytes(3);
      const video = await prisma.courseMediaAsset.create({
        data: {
          courseId: course.id,
          kind: 'VIDEO',
          originalName: 'L001-en-GB.mp4',
          mimeType: 'video/mp4',
          extension: 'mp4',
          size: videoBytes.length,
          storageKey: `e2e/${course.id}/export-video.mp4`,
          durationSeconds: 3,
        },
      });
      await app
        .get(CourseStorageService)
        .putMedia(video.storageKey, videoBytes);
      await prisma.commerceCourse.update({
        where: { id: course.id },
        data: {
          categoryId: category.id,
          coverAssetId: cover.id,
          learningMode: 'VIDEO_ONLY',
          learningLanguages: ['en-GB'],
          trialEnabled: false,
        },
      });
      const lesson = await fixtures.createLesson(agent, course.id);
      for (const [language, label] of [
        ['en-GB', 'Lesson one'],
        ['zh-CN', '第一课'],
      ] as const) {
        await prisma.lessonLocalization.update({
          where: { lessonId_language: { lessonId: lesson.id, language } },
          data: {
            title: label,
            description: 'Lesson description',
            videoAssetId: video.id,
            videoDurationSeconds: 3,
          },
        });
      }
      await prisma.learningPoint.create({
        data: {
          lessonId: lesson.id,
          language: 'en-GB',
          code: 'V1',
          title: 'First point',
          source: 'VIDEO',
          timeSeconds: 1,
          sortOrder: 0,
        },
      });
      await prisma.recommendedReading.create({
        data: {
          lessonId: lesson.id,
          language: 'en-GB',
          type: 'BOOK',
          title: 'Book',
          author: 'Author',
          whyRecommended: 'Why',
          sortOrder: 0,
        },
      });
      const published: SuccessResponse<{
        versionId: string;
        versionLabel: string;
      }> = await agent
        .post(`/api/backoffice/courses/${course.id}/publish`)
        .send({})
        .expect(200);
      expect(published.body.data.versionLabel).toBe('1.1');
      return course;
    }

    it('exports the current live version and rejects draft / specific-version selectors with 400', async () => {
      const course = await createPublishableCourse('Export selectors');
      const live = await prisma.courseVersion.findFirstOrThrow({
        where: { courseId: course.id },
        orderBy: { versionNo: 'desc' },
      });
      expect(live.versionLabel).toBe('1.1');

      // 1) 草稿/指定版本选择器：400 VALIDATION_ERROR，文案说明只能导出线上版本，且不产生作业。
      const rejected: Array<Record<string, unknown>> = [
        { version: 'working' },
        { version: 'draft' },
        { version: 'version:1' },
        { version: 'version:1.1' },
        { versionId: live.id },
        { sourceVersion: 'live' },
        { sourceVersion: 'version:2' },
      ];
      for (const body of rejected) {
        const before = await prisma.coursePackageJob.count({
          where: { courseId: course.id, kind: 'EXPORT' },
        });
        const response: ErrorResponse = await agent
          .post(`/api/backoffice/courses/${course.id}/export`)
          .send(body);
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(response.body.error.message).toContain('current live version');
        expect(
          await prisma.coursePackageJob.count({
            where: { courseId: course.id, kind: 'EXPORT' },
          }),
        ).toBe(before);
      }

      // 2) 默认（无选择器）= 导出当前线上版本；worker 真拼包到 READY。
      const byDefault = await startExport(course.id, {});
      expect(byDefault.versionId).toBe(live.id);
      expect(byDefault.versionLabel).toBe('1.1');
      expect(byDefault.fileName).toBe(`${course.code}_1.1.zip`);
      const defaultJob = await waitForExport(byDefault.jobId);
      expect(defaultJob.status).toBe('READY');

      // 3) 显式 live 同样只导线上版本。
      const byLive = await startExport(course.id, { version: 'live' });
      expect(byLive.versionId).toBe(live.id);
      expect(byLive.versionLabel).toBe('1.1');
      expect((await waitForExport(byLive.jobId)).status).toBe('READY');

      // 4) 未发布：assertExportable 仍然拦截（409 EXPORT_REQUIRES_LIVE_VERSION）。
      await prisma.commerceCourse.update({
        where: { id: course.id },
        data: { liveVersionId: null },
      });
      const unpublished: ErrorResponse = await agent
        .post(`/api/backoffice/courses/${course.id}/export`)
        .send({});
      expect(unpublished.status).toBe(409);
      expect(unpublished.body.error.code).toBe('EXPORT_REQUIRES_LIVE_VERSION');

      // 5) 线上版本 3 步不完整：409 VERSION_INCOMPLETE（导出仍走完整 assertExportable）。
      const snapshot = live.snapshotData as {
        course: { learningLanguages: string[] };
      };
      await prisma.courseVersion.update({
        where: { id: live.id },
        data: {
          snapshotData: {
            ...snapshot,
            course: { ...snapshot.course, learningLanguages: [] },
          },
        },
      });
      await prisma.commerceCourse.update({
        where: { id: course.id },
        data: { liveVersionId: live.id },
      });
      const incomplete: ErrorResponse = await agent
        .post(`/api/backoffice/courses/${course.id}/export`)
        .send({});
      expect(incomplete.status).toBe(409);
      expect(incomplete.body.error.code).toBe('VERSION_INCOMPLETE');
      expect(incomplete.body.error.message).toContain('Complete all 3 steps');
    }, 60_000);
  });

  // ===== MED-3 / LOW-1: 上传上限与文案 =====

  describe('MED-3/LOW-1 upload limits', () => {
    const GIB = 1024 * 1024 * 1024;

    async function rawSession(body: Record<string, unknown>): Promise<{
      status: number;
      body: {
        data?: { jobId: string; chunkSize: number };
        error?: { code: string; message: string };
      };
    }> {
      const response = await agent
        .post('/api/backoffice/courses/import/raw/session')
        .send(body);
      const parsed = response.body as {
        data?: { jobId: string; chunkSize: number };
        error?: { code: string; message: string };
      };
      if (parsed.data?.jobId) {
        createdJobIds.push(parsed.data.jobId);
      }
      return { status: response.status, body: parsed };
    }

    it('accepts raw sessions up to PACKAGE_MAX_BYTES without a 500 at 4 GiB', async () => {
      const fourGiB = await rawSession({
        fileName: 'raw.zip',
        bytesTotal: 4 * GIB,
      });
      expect(fourGiB.status).toBe(200);
      expect(fourGiB.body.data?.chunkSize).toBe(5 * 1024 * 1024);

      const atLimit = await rawSession({
        fileName: 'raw.zip',
        bytesTotal: 8 * GIB,
      });
      expect(atLimit.status).toBe(200);
    }, 30_000);

    it('rejects raw sessions above PACKAGE_MAX_BYTES with 400 VALIDATION_ERROR and the real limit', async () => {
      const over = await rawSession({
        fileName: 'raw.zip',
        bytesTotal: 8 * GIB + 1,
      });
      expect(over.status).toBe(400);
      expect(over.body.error?.code).toBe('VALIDATION_ERROR');
      expect(over.body.error?.message).toContain('8 GB');
      expect(over.body.error?.message).not.toContain('15MB');
    }, 30_000);

    it('pre-validates the raw session file extension at session creation', async () => {
      for (const fileName of ['raw.exe', 'raw.7z']) {
        const rejected = await rawSession({ fileName, bytesTotal: 1024 });
        expect(rejected.status).toBe(400);
        expect(rejected.body.error?.code).toBe('PACKAGE_INVALID_ZIP');
        expect(rejected.body.error?.message).toContain('.zip');
      }
      const accepted = await rawSession({
        fileName: 'raw.zip',
        bytesTotal: 1024,
      });
      expect(accepted.status).toBe(200);
    }, 30_000);

    it('rejects direct uploads above PACKAGE_DIRECT_UPLOAD_BYTES with the configured limit, not 15MB', async () => {
      const tooBig = Buffer.alloc(1024 * 1024 + 1, 0x41);
      const response: ErrorResponse = await agent
        .post('/api/backoffice/courses/import')
        .attach('file', tooBig, 'too-big.zip');
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.message).toContain('1 MB');
      expect(response.body.error.message).not.toContain('15MB');
      expect(response.body.error.message.toLowerCase()).toContain('chunked');

      // 原始素材直传超过 PACKAGE_MAX_BYTES 的文案走同一套 formatBytes；内存里造不出
      // 8GB 文件，这里只断言 1MB 直传包不再落到"15MB 限制"文案。
    }, 60_000);

    it('imports a package through the chunked package session (no Excel conversion)', async () => {
      const suffix = randomUUID().slice(0, 8);
      const code = `E2E-CHUNK-${suffix.toUpperCase()}`;
      const zip = await zipPackage(
        packageManifest({
          code,
          slug: `e2e-chunk-${suffix}`,
          includeDuration: true,
        }),
      );
      const session = await agent
        .post('/api/backoffice/courses/import/package/session')
        .send({ fileName: 'chunked.lgcourse.zip', bytesTotal: zip.length });
      expect(session.status).toBe(200);
      const jobId = (session.body as { data?: { jobId?: string } }).data
        ?.jobId as string;
      createdJobIds.push(jobId);

      const chunk = await agent
        .put(`/api/backoffice/courses/import/package/${jobId}/chunk?index=0`)
        .attach('chunk', zip, 'chunk.bin');
      expect(chunk.status).toBe(200);

      const complete = await agent
        .post(`/api/backoffice/courses/import/package/${jobId}/complete`)
        .expect(200);
      expect(
        (complete.body as { data?: { stage?: string } }).data?.stage,
      ).toMatch(/PACKAGE_QUEUED|VALIDATING/);

      let status = (complete.body as { data?: JobView }).data as JobView;
      for (
        let attempt = 0;
        attempt < 100 &&
        status.status !== 'AWAITING_CONFIRM' &&
        status.status !== 'FAILED';
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const polled: SuccessResponse<JobView> = await agent
          .get(`/api/backoffice/courses/import/${jobId}`)
          .expect(200);
        status = polled.body.data;
      }
      expect(status.status).toBe('AWAITING_CONFIRM');
      expect(status.report.errors).toEqual([]);

      const confirmed = await confirm(jobId, { onConflict: 'ABORT' });
      expect(confirmed.status).toBe(200);
      fixtures.track(confirmed.body.data?.courseId as string);
    }, 60_000);
  });
});
