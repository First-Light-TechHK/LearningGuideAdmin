import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { CourseStorageService } from '../src/commerce-courses/storage.service';
import type { VersionSnapshot } from '../src/commerce-courses/version-snapshot';
import { PrismaService } from '../src/prisma/prisma.service';
import { signInAs } from './helpers/employee-session';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n1EAAAAASUVORK5CYII=',
  'base64',
);

/**
 * Portal 投影契约：只暴露 ONLINE 且未归档课程的 live 快照；
 * 缺失字段、媒体端点、预览 token 都必须可被 Portal 直接消费。
 */
describe('Portal projection contract (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let storage: CourseStorageService;

  const suffix = Date.now();
  const code = `E2E-PORTAL-${suffix}`;
  const slug = `e2e-portal-${suffix}`;
  const hiddenCode = `${code}-HIDDEN`;
  const hiddenSlug = `${slug}-hidden`;

  let categoryId = '';
  let courseId = '';
  let hiddenCourseId = '';
  let coverAssetId = '';
  let videoAssetId = '';
  let exhibitAssetId = '';
  let lessonId = '';
  let planId = '';
  let versionId = '';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    storage = app.get(CourseStorageService);

    const category = await prisma.courseCatalogueEntry.create({
      data: { name: `Portal ${suffix}` },
    });
    categoryId = category.id;

    courseId = randomUUID();
    lessonId = randomUUID();
    coverAssetId = randomUUID();
    videoAssetId = randomUUID();
    exhibitAssetId = randomUUID();
    planId = randomUUID();

    await prisma.commerceCourse.create({
      data: {
        id: courseId,
        code,
        slug,
        categoryId,
        learningMode: 'VIDEO_AND_TEXT',
        defaultContentLanguage: 'en-GB',
        learningLanguages: ['en-GB', 'zh-CN'],
        liveStatus: 'ONLINE',
        lifecycleStatus: 'LIVE',
        trialEnabled: true,
        referencePrice: 3900,
        discount: 0,
      },
    });

    await createMedia(coverAssetId, 'IMAGE', 'cover.png', 'png', PNG);
    await createMedia(
      videoAssetId,
      'VIDEO',
      'lesson.mp4',
      'mp4',
      Buffer.from('e2e-video-bytes'),
    );
    await createMedia(exhibitAssetId, 'IMAGE', 'exhibit.png', 'png', PNG);
    await prisma.commerceCourse.update({
      where: { id: courseId },
      data: { coverAssetId },
    });

    await prisma.courseLocalization.create({
      data: {
        courseId,
        language: 'en-GB',
        title: 'Draft title',
        shortDescription: 'Draft short',
        overview: 'Draft overview',
        whatYouLearn: ['Draft outcome'],
        provides: [{ title: 'Draft provide' }],
      },
    });

    await prisma.lesson.create({
      data: {
        id: lessonId,
        courseId,
        code: 'L001',
        sortOrder: 1,
        localizations: {
          create: {
            language: 'en-GB',
            title: 'Draft lesson',
            description: 'Draft summary',
            videoAssetId,
            videoDurationSeconds: 125,
            textHtml: '<p>Draft text</p>',
          },
        },
        exhibits: {
          create: {
            code: 'E0101',
            type: 'IMAGE',
            mediaAssetId: exhibitAssetId,
            localized: {
              'en-GB': { title: 'Live exhibit', description: 'Exhibit desc' },
            },
          },
        },
      },
    });

    await prisma.trialSetting.create({
      data: {
        courseId,
        lessonId,
        status: 'READY',
        videoCutoffSeconds: 60,
      },
    });

    await prisma.coursePlan.create({
      data: {
        id: planId,
        courseId,
        name: '6 months',
        scope: 'COURSE',
        scopeId: courseId,
        termMonths: 6,
        device: 'WEB',
        amountMinor: 3900,
        currency: 'usd',
        stripeLookupKey: `${code}_6m`,
        active: true,
        sortOrder: 0,
        trialEligible: true,
      },
    });

    const snapshot: VersionSnapshot = {
      formatVersion: 2,
      capturedAt: new Date().toISOString(),
      course: {
        code,
        slug,
        categoryId,
        coverAssetId,
        learningMode: 'VIDEO_AND_TEXT',
        defaultContentLanguage: 'en-GB',
        learningLanguages: ['en-GB', 'zh-CN'],
        localizations: [
          {
            language: 'en-GB',
            title: 'Live title',
            shortDescription: 'Live short',
            overview: 'Live overview',
            whatYouLearn: ['Model real systems', 'Understand feedback'],
            provides: [
              { type: 'video', title: 'Video & text dual-mode learning' },
              { type: 'reading', title: 'Extended readings' },
            ],
          },
        ],
        lessons: [
          {
            id: lessonId,
            code: 'L001',
            sortOrder: 1,
            localizations: [
              {
                language: 'en-GB',
                title: 'Live lesson',
                description: 'Live summary',
                videoAssetId,
                videoDurationSeconds: 125,
                textHtml: '<p>Live text</p>',
                textLearningPoints: [],
              },
            ],
            exhibits: [
              {
                code: 'E0101',
                type: 'IMAGE',
                mediaAssetId: exhibitAssetId,
                thumbnailAssetId: null,
                sourceText: null,
                localized: {
                  'en-GB': { title: 'Live exhibit', description: 'Exhibit desc' },
                },
              },
            ],
            learningPoints: [],
            triggers: [],
            readings: [],
            questions: [],
            applicationTest: null,
          },
        ],
      },
    };

    const version = await prisma.courseVersion.create({
      data: {
        courseId,
        versionNo: 1,
        versionLabel: '1.0',
        snapshotData: snapshot as unknown as Prisma.InputJsonValue,
      },
    });
    versionId = version.id;
    await prisma.commerceCourse.update({
      where: { id: courseId },
      data: { liveVersionId: version.id },
    });

    const hidden = await prisma.commerceCourse.create({
      data: {
        code: hiddenCode,
        slug: hiddenSlug,
        categoryId,
        learningMode: 'VIDEO_AND_TEXT',
        defaultContentLanguage: 'en-GB',
        learningLanguages: ['en-GB'],
        liveStatus: 'HIDDEN',
        lifecycleStatus: 'WORKING',
      },
    });
    hiddenCourseId = hidden.id;
  });

  afterAll(async () => {
    const courses = await prisma.commerceCourse.findMany({
      where: { code: { in: [code, hiddenCode] } },
      select: { id: true },
    });
    const ids = courses.map((course) => course.id);
    if (ids.length) {
      await prisma.coursePlan.deleteMany({ where: { courseId: { in: ids } } });
      await prisma.commerceCourse.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.courseCatalogueEntry
      .delete({ where: { id: categoryId } })
      .catch(() => undefined);
    await app.close();
  });

  async function createMedia(
    id: string,
    kind: 'IMAGE' | 'VIDEO',
    originalName: string,
    extension: string,
    bytes: Buffer,
  ) {
    const storageKey = `course-media/${courseId}/${id}.${extension}`;
    await storage.putMedia(storageKey, bytes);
    await prisma.courseMediaAsset.create({
      data: {
        id,
        courseId,
        kind,
        originalName,
        mimeType: kind === 'IMAGE' ? 'image/png' : 'video/mp4',
        extension,
        size: bytes.length,
        storageKey,
      },
    });
  }

  it('lists only ONLINE, non-archived courses and uses live snapshot copy', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/portal/v1/courses?limit=100')
      .expect(200);
    expect(res.body.success).toBe(true);
    const rows: Array<Record<string, unknown>> = res.body.data;
    const row = rows.find((item) => item.code === code);
    expect(row).toBeTruthy();
    expect(row).toMatchObject({
      id: courseId,
      slug,
      code,
      title: 'Live title',
      shortDescription: 'Live short',
      description: 'Live overview',
      category: `Portal ${suffix}`,
      lessonCount: 1,
      totalDurationSeconds: 125,
      learningMode: 'VIDEO_AND_TEXT',
      learningLanguages: ['en-GB', 'zh-CN'],
    });
    expect(rows.some((item) => item.code === hiddenCode)).toBe(false);
  });

  it('returns the complete Portal detail projection from the live snapshot', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/portal/v1/courses/${courseId}`)
      .expect(200);
    const data = res.body.data;
    expect(data).toMatchObject({
      id: courseId,
      code,
      slug,
      title: 'Live title',
      shortDescription: 'Live short',
      description: 'Live overview',
      learningMode: 'VIDEO_AND_TEXT',
      learningLanguages: ['en-GB', 'zh-CN'],
      defaultContentLanguage: 'en-GB',
      totalDurationSeconds: 125,
      lessonCount: 1,
      trial: { enabled: true, lessonIds: [lessonId] },
    });
    expect(data.whatYouLearn).toEqual([
      'Model real systems',
      'Understand feedback',
    ]);
    expect(data.provides).toEqual([
      { type: 'video', title: 'Video & text dual-mode learning' },
      { type: 'reading', title: 'Extended readings' },
    ]);
    expect(data.plans).toEqual([
      {
        id: planId,
        name: '6 months',
        termMonths: 6,
        amountMinor: 3900,
        currency: 'usd',
        lookupKey: `${code}_6m`,
        trialEligible: true,
      },
    ]);
    const lesson = data.sections[0].lessons[0];
    expect(lesson).toMatchObject({
      id: lessonId,
      title: 'Live lesson',
      summary: 'Live summary',
      durationSeconds: 125,
      isPublic: true,
    });
    expect(lesson.contents[0].url).toBe(
      `/api/portal/v1/media/${courseId}/assets/${videoAssetId}`,
    );
    expect(lesson.contents[1].html).toBe('<p>Live text</p>');
    expect(data.coverUrl).toBe(`/api/portal/v1/media/${courseId}/cover`);
  });

  it('serves cover and media bytes through Portal endpoints', async () => {
    const cover = await request(app.getHttpServer())
      .get(`/api/portal/v1/media/${courseId}/cover`)
      .expect(200);
    expect(cover.headers['content-type']).toBe('image/png');
    expect(Buffer.from(cover.body).equals(PNG)).toBe(true);

    const video = await request(app.getHttpServer())
      .get(`/api/portal/v1/media/${courseId}/assets/${videoAssetId}`)
      .expect(200);
    expect(video.headers['content-type']).toBe('video/mp4');
    expect(Buffer.from(video.body).toString()).toBe('e2e-video-bytes');

    await request(app.getHttpServer())
      .get(`/api/portal/v1/media/${hiddenCourseId}/assets/${videoAssetId}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/portal/v1/media/${courseId}/assets/${randomUUID()}`)
      .expect(404);
  });

  it('hides unpublished courses from detail', async () => {
    await request(app.getHttpServer())
      .get(`/api/portal/v1/courses/${hiddenCourseId}`)
      .expect(404);
  });

  it('creates a short-lived signed preview link for the draft', async () => {
    const agent = await signInAs(app, 'ADMIN');
    const res = await agent
      .get(`/api/backoffice/courses/${courseId}/portal-preview?locale=zh-CN`)
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      source: 'draft',
      courseId,
      versionId: null,
    });
    // 预览页由 Admin 自己托管：链接指向 Back Office 的 Portal 风格预览路由。
    expect(res.body.data.url).toContain(
      `/zh-CN/portal-preview/${courseId}?token=`,
    );
    expect(res.body.data.url).not.toContain('/portal/courses/');
    const [payload, signature] = String(res.body.data.token).split('.');
    expect(payload).toBeTruthy();
    expect(signature).toBeTruthy();
    expect(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    ).toMatchObject({
      aud: 'portal-preview',
      courseId,
      versionId: null,
      slug,
      source: 'draft',
    });
  });

  it('serves the Admin preview page data behind employee session + token', async () => {
    const agent = await signInAs(app, 'ADMIN');
    const link = await agent
      .get(`/api/backoffice/courses/${courseId}/portal-preview?locale=zh-CN`)
      .expect(200);
    const token = encodeURIComponent(String(link.body.data.token));

    const draft = await agent
      .get(
        `/api/backoffice/courses/${courseId}/portal-preview/content?token=${token}`,
      )
      .expect(200);
    expect(draft.body.success).toBe(true);
    expect(draft.body.data.title).toBe('Draft title');
    expect(draft.body.data.preview).toEqual({
      source: 'draft',
      versionLabel: null,
    });

    // token 只授权它签发的那门课
    await agent
      .get(
        `/api/backoffice/courses/${hiddenCourseId}/portal-preview/content?token=${token}`,
      )
      .expect(401);

    // 无员工会话一律拒绝
    await request(app.getHttpServer())
      .get(
        `/api/backoffice/courses/${courseId}/portal-preview/content?token=${token}`,
      )
      .expect(401);
  });

  it('serves draft and version projection through a signed preview token', async () => {
    const agent = await signInAs(app, 'ADMIN');
    const draftLink = await agent
      .get(`/api/backoffice/courses/${courseId}/portal-preview?locale=zh-CN`)
      .expect(200);
    const draftRes = await request(app.getHttpServer())
      .get(
        `/api/portal/v1/preview/course?token=${encodeURIComponent(draftLink.body.data.token)}`,
      )
      .expect(200);
    expect(draftRes.body.data.title).toBe('Draft title');
    expect(draftRes.body.data.preview).toEqual({
      source: 'draft',
      versionLabel: null,
    });

    const versionLink = await agent
      .get(
        `/api/backoffice/courses/${courseId}/portal-preview?locale=zh-CN&versionId=${versionId}`,
      )
      .expect(200);
    const versionRes = await request(app.getHttpServer())
      .get(
        `/api/portal/v1/preview/course?token=${encodeURIComponent(versionLink.body.data.token)}`,
      )
      .expect(200);
    expect(versionRes.body.data.title).toBe('Live title');
    expect(versionRes.body.data.preview).toEqual({
      source: 'version',
      versionLabel: '1.0',
    });

    const token = String(draftLink.body.data.token);
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    await request(app.getHttpServer())
      .get(`/api/portal/v1/preview/course?token=${encodeURIComponent(tampered)}`)
      .expect(401);
  });
});
