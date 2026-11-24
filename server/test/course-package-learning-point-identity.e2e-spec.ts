import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import JSZip from 'jszip';
import type { Response } from 'supertest';
import { App } from 'supertest/types';
import type TestAgent from 'supertest/lib/agent';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { CourseStorageService } from '../src/commerce-courses/storage.service';
import { CourseFixtures } from './helpers/course-fixture';
import type { SuccessResponse } from './helpers/http-response';

// 导出作业由 worker 轮询处理；缩短轮询间隔让往返测试无需等默认的 2s。
// 只影响本进程的 e2e，业务代码仍按环境变量读取。
process.env.PACKAGE_JOB_POLL_MS =
  process.env.PACKAGE_JOB_POLL_MS ??
  process.env.E2E_PACKAGE_JOB_POLL_MS ??
  '100';

interface JobView {
  jobId: string;
  status: string;
  error: string | null;
  courseId: string | null;
  report: {
    errors: Array<{ code: string; message: string }>;
    warnings: Array<{ code: string; message: string }>;
  };
}

interface ConfirmView {
  jobId: string;
  status: string;
  courseId?: string;
}

function videoBytes(): Buffer {
  // validateMediaFile 对 .mp4 只要求前 12 字节里有 ftyp 签名；内容本身不参与校验。
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypisom', 'ascii'),
    Buffer.alloc(16),
  ]);
}

/**
 * docs/Course_Module_Import_Export_Design.md §4.2 同形的 v1 包：
 * 视频学习点与文本学习点都用编号 "1.1"（包规范允许，两种 source 是不同身份），
 * 试看的文本截止点指向 "1.1"——它必须落在 TEXT 行，不能落到同编号的 VIDEO 行。
 */
function v1Manifest(courseCode: string, slug: string) {
  return {
    format: 'lg-course-package',
    formatVersion: 1,
    packageId: `pkg_${courseCode}`,
    exportedAt: new Date().toISOString(),
    source: {
      environment: 'E2E',
      courseCode,
      sourceVersion: 'working',
    },
    incomplete: false,
    course: {
      code: courseCode,
      slug,
      category: 'E2E Science',
      learningMode: 'VIDEO_AND_TEXT',
      learningLanguages: ['en-GB'],
      defaultContentLanguage: 'en-GB',
      localized: {
        'en-GB': {
          title: 'Learning point identity',
          shortDescription: 'Same code on video and text points.',
          overview: 'Video and text learning points may share a code.',
          whatYouLearn: ['Codes are per source'],
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
              title: 'Same code, two sources',
              description: 'One video point and one text point share 1.1',
              video: {
                file: 'media/video/L001/en-GB.mp4',
                durationSeconds: 120,
                learningPoints: [
                  { code: '1.1', timeSeconds: 10, title: 'State Variables' },
                ],
                exhibitTriggers: [],
              },
              text: {
                html:
                  '<h1>State Variables</h1><p>Body of the first heading.</p>' +
                  '<h1>Trajectories</h1><p>Body of the second heading.</p>',
                learningPoints: [
                  { code: '1.1', heading: 'State Variables', level: 1 },
                  { code: '1.2', heading: 'Trajectories', level: 1 },
                ],
              },
            },
          },
          recommendedReading: {},
          knowledgeTest: { enabled: false, questions: [] },
        },
      ],
      trial: {
        enabled: true,
        lessons: [
          {
            lessonRef: 'L001',
            videoCutoffSeconds: 60,
            textCutoffLearningPoint: '1.1',
            status: 'READY',
          },
        ],
      },
      pricing: [],
    },
  };
}

async function zipPackage(manifest: unknown): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('media/video/L001/en-GB.mp4', videoBytes());
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** supertest 的二进制响应解析器（课程包下载是 zip，不是 JSON）。 */
function binaryParser(
  res: Response,
  callback: (error: Error | null, body: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
  res.on('error', (error: Error) => callback(error, Buffer.alloc(0)));
}

describe('Course package learning-point identity (e2e)', () => {
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

  async function uploadPackage(
    zip: Buffer,
    options: { courseId?: string; fileName: string },
  ): Promise<SuccessResponse<JobView>> {
    const url = options.courseId
      ? `/api/backoffice/courses/${options.courseId}/import`
      : '/api/backoffice/courses/import';
    const response: SuccessResponse<JobView> = await agent
      .post(url)
      .attach('file', zip, options.fileName)
      .expect(201);
    return response;
  }

  async function confirmImport(
    jobId: string,
    onConflict: 'ABORT' | 'CREATE_NEW_COURSE',
  ): Promise<{ status: number; body: { data?: ConfirmView } }> {
    const response = await agent
      .post(`/api/backoffice/courses/import/${jobId}/confirm`)
      .send({ onConflict });
    const body = response.body as { data?: ConfirmView };
    return { status: response.status, body };
  }

  async function waitForExport(jobId: string): Promise<JobView> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const response: SuccessResponse<JobView> = await agent
        .get(`/api/backoffice/courses/export/${jobId}`)
        .expect(200);
      const job = response.body.data;
      if (job.status === 'READY') return job;
      if (job.status === 'FAILED')
        throw new Error(`export job failed: ${job.error}`);
      if (Date.now() > deadline)
        throw new Error(`export job ${jobId} did not finish in time`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * 导入的包只带 en-GB 信息和视频，先补齐 Publish/Export 三步门禁要求的内容
   * （封面、双语课程/课时信息、延伸阅读），然后由真实 Publish 生成线上版本快照。
   * PRD §16.2：导出只导当前线上版本，测试不能再走草稿导出。
   */
  async function completeCourseForPublish(courseId: string): Promise<void> {
    const items = ['one', 'two', 'three', 'four'];
    for (const [language, title] of [
      ['en-GB', 'Learning point identity'],
      ['zh-CN', '学习点身份'],
    ] as const) {
      await prisma.courseLocalization.upsert({
        where: { courseId_language: { courseId, language } },
        update: {
          title,
          shortDescription: 'Same code on video and text points.',
          overview: 'Video and text points may share a code.',
          whatYouLearn: items,
          provides: items,
        },
        create: {
          courseId,
          language,
          title,
          shortDescription: 'Same code on video and text points.',
          overview: 'Video and text points may share a code.',
          whatYouLearn: items,
          provides: items,
        },
      });
    }
    const course = await prisma.commerceCourse.findUniqueOrThrow({
      where: { id: courseId },
    });
    if (!course.coverAssetId) {
      // 合法 PNG 签名（重导入时按扩展名校验文件头）
      const bytes = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(16),
      ]);
      const cover = await prisma.courseMediaAsset.create({
        data: {
          courseId,
          kind: 'IMAGE',
          originalName: 'cover.png',
          mimeType: 'image/png',
          extension: 'png',
          size: bytes.length,
          storageKey: `e2e/${courseId}/lp-identity-cover.png`,
        },
      });
      await app.get(CourseStorageService).putMedia(cover.storageKey, bytes);
      await prisma.commerceCourse.update({
        where: { id: courseId },
        data: { coverAssetId: cover.id },
      });
    }
    const lesson = await prisma.lesson.findFirstOrThrow({
      where: { courseId, code: 'L001' },
    });
    for (const [language, title] of [
      ['en-GB', 'Same code, two sources'],
      ['zh-CN', '同编号两种来源'],
    ] as const) {
      await prisma.lessonLocalization.upsert({
        where: { lessonId_language: { lessonId: lesson.id, language } },
        update: { title, description: 'Lesson description' },
        create: {
          lessonId: lesson.id,
          language,
          title,
          description: 'Lesson description',
        },
      });
    }
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
  }

  it('imports a video+text package sharing code 1.1, keeps both rows, binds the text cut-off to the TEXT row, and round-trips through export', async () => {
    const suffix = randomBytes(4).toString('hex');
    const courseCode = `E2E-LPID-${suffix}`;
    const slug = `e2e-lp-identity-${suffix}`;
    const zip = await zipPackage(v1Manifest(courseCode, slug));

    // 1) 上传：校验通过，等待确认
    const uploaded = await uploadPackage(zip, {
      fileName: 'lp-identity.lgcourse.zip',
    });
    const job = uploaded.body.data;
    expect(job.status).toBe('AWAITING_CONFIRM');
    expect(job.report.errors).toEqual([]);

    // 2) 确认导入 —— 修复前这里因 (lessonId, language, code) 唯一约束 500
    const confirmed = await confirmImport(job.jobId, 'CREATE_NEW_COURSE');
    if (confirmed.status !== 200) {
      // 红跑证据：把 confirm 的原始响应留在日志里
      console.log(
        'confirm failed:',
        confirmed.status,
        JSON.stringify(confirmed.body),
      );
    }
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data?.status).toBe('READY');
    const courseId = confirmed.body.data?.courseId as string;
    fixtures.track(courseId);

    // 3) 数据库：同编号两行，VIDEO 带时间点、TEXT 带锚点标题
    const lesson = await prisma.lesson.findFirstOrThrow({
      where: { courseId, code: 'L001' },
    });
    const rows = await prisma.learningPoint.findMany({
      where: { lessonId: lesson.id, language: 'en-GB', code: '1.1' },
    });
    expect(rows).toHaveLength(2);
    const videoRow = rows.find((row) => row.source === 'VIDEO');
    const textRow = rows.find((row) => row.source === 'TEXT');
    expect(videoRow).toMatchObject({
      timeSeconds: 10,
      anchorHeading: null,
      title: 'State Variables',
    });
    expect(textRow).toMatchObject({
      timeSeconds: null,
      anchorHeading: 'State Variables',
      title: 'State Variables',
    });

    // 4) 试看文本截止点绑定 TEXT 行，而不是同编号的 VIDEO 行
    const trial = await prisma.trialSetting.findFirstOrThrow({
      where: { courseId, lessonId: lesson.id },
    });
    expect(trial.textCutoffLearningPointId).toBe(textRow?.id);
    expect(trial.textCutoffLearningPointId).not.toBe(videoRow?.id);
    expect(trial.videoCutoffSeconds).toBe(60);
    expect(trial.status).toBe('READY');

    // 5) 先发布，再导出当前线上版本（PRD §16.2：不能导出草稿或指定版本）。
    await completeCourseForPublish(courseId);
    const published: SuccessResponse<{
      versionId: string;
      versionLabel: string;
    }> = await agent
      .post(`/api/backoffice/courses/${courseId}/publish`)
      .send({})
      .expect(200);
    const exportStarted: SuccessResponse<{
      jobId: string;
      versionId: string;
      versionLabel: string;
    }> = await agent
      .post(`/api/backoffice/courses/${courseId}/export`)
      .send({})
      .expect(202);
    expect(exportStarted.body.data.versionId).toBe(
      published.body.data.versionId,
    );
    expect(exportStarted.body.data.versionLabel).toBe(
      published.body.data.versionLabel,
    );
    const exportJobId = exportStarted.body.data.jobId;
    await waitForExport(exportJobId);
    const download = await agent
      .get(`/api/backoffice/courses/export/${exportJobId}/download`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    const exportedZip = await JSZip.loadAsync(download.body as Buffer);
    const manifestFile = exportedZip.file('manifest.json');
    expect(manifestFile).not.toBeNull();
    const exported = JSON.parse(await manifestFile!.async('string')) as {
      course: {
        lessons: Array<{
          localized: Record<
            string,
            {
              video: { learningPoints: Array<{ code: string }> };
              text: { learningPoints: Array<{ code: string }> };
            }
          >;
        }>;
        trial: {
          lessons: Array<{
            lessonRef: string;
            textCutoffLearningPoint: string;
          }>;
        };
      };
    };
    const exportedLoc = exported.course.lessons[0].localized['en-GB'];
    expect(exportedLoc.video.learningPoints.map((lp) => lp.code)).toEqual([
      '1.1',
    ]);
    expect(exportedLoc.text.learningPoints.map((lp) => lp.code)).toEqual([
      '1.1',
      '1.2',
    ]);
    expect(
      exported.course.trial.lessons.find((row) => row.lessonRef === 'L001')
        ?.textCutoffLearningPoint,
    ).toBe('1.1');

    // 6) 把导出的包再导入同一门课（已有课程快照应用路径），编号不变、两行仍在
    const reUploaded = await uploadPackage(download.body as Buffer, {
      courseId,
      fileName: 'roundtrip.lgcourse.zip',
    });
    expect(reUploaded.body.data.status).toBe('AWAITING_CONFIRM');
    expect(reUploaded.body.data.report.errors).toEqual([]);
    const reConfirmed = await confirmImport(
      reUploaded.body.data.jobId,
      'ABORT',
    );
    if (reConfirmed.status !== 200) {
      console.log(
        're-import confirm failed:',
        reConfirmed.status,
        JSON.stringify(reConfirmed.body),
      );
    }
    expect(reConfirmed.status).toBe(200);
    expect(reConfirmed.body.data?.status).toBe('READY');

    const rowsAfter = await prisma.learningPoint.findMany({
      where: { lessonId: lesson.id, language: 'en-GB', code: '1.1' },
    });
    expect(rowsAfter).toHaveLength(2);
    const textAfter = rowsAfter.find((row) => row.source === 'TEXT');
    const videoAfter = rowsAfter.find((row) => row.source === 'VIDEO');
    expect(videoAfter).toMatchObject({ timeSeconds: 10, anchorHeading: null });
    expect(textAfter).toMatchObject({
      timeSeconds: null,
      anchorHeading: 'State Variables',
    });
    const trialAfter = await prisma.trialSetting.findFirstOrThrow({
      where: { courseId, lessonId: lesson.id },
    });
    expect(trialAfter.textCutoffLearningPointId).toBe(textAfter?.id);
    expect(trialAfter.textCutoffLearningPointId).not.toBe(videoAfter?.id);
  }, 60_000);
});
