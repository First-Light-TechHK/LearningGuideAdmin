import JSZip from 'jszip';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { CommerceCourseConfig } from './commerce.config';
import { runImportWorker } from './heavy-tasks';
import { CourseStorageService } from './storage.service';

function testConfig(): CommerceCourseConfig {
  return {
    environmentLabel: 'test',
    publicSiteUrl: 'http://localhost',
    versionNumberingMode: 'sandbox',
    mediaRoot: '/tmp/lg-media',
    packageStagingRoot: '/tmp/lg-staging',
    maxImageBytes: 20 * 1024 * 1024,
    maxVideoBytes: 500 * 1024 * 1024,
    maxAudioBytes: 100 * 1024 * 1024,
    maxPdfBytes: 100 * 1024 * 1024,
    maxModelBytes: 25 * 1024 * 1024,
    packageMaxBytes: 8 * 1024 * 1024 * 1024,
    packageDirectUploadBytes: 200 * 1024 * 1024,
    packageExportTtlHours: 24,
    jobConcurrency: 2,
    jobPollMs: 2000,
    jobHeartbeatMs: 10000,
    jobStaleMs: 600000,
    jobMaxAttempts: 3,
  };
}

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
);

const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypisom', 'ascii'),
  Buffer.alloc(16),
]);

function manifest() {
  return {
    format: 'lg-course-package',
    formatVersion: 1,
    packageId: 'pkg_worker_test',
    exportedAt: new Date().toISOString(),
    source: {},
    incomplete: false,
    course: {
      code: 'C900',
      slug: 'worker-test',
      category: 'Science',
      learningMode: 'VIDEO_AND_TEXT',
      learningLanguages: ['en-GB'],
      defaultContentLanguage: 'en-GB',
      cover: 'media/cover.png',
      localized: {
        'en-GB': {
          title: 'Test',
          shortDescription: 'desc',
          overview: 'ov',
          whatYouLearn: ['a'],
        },
      },
      lessons: [
        {
          code: 'L001',
          order: 1,
          localized: {
            'en-GB': {
              title: 'Lesson 1',
              video: { file: 'media/video/L001/en-GB.mp4', learningPoints: [] },
              text: {
                html: '<h1>Hello</h1>',
                learningPoints: [{ code: '1.1', heading: 'Hello' }],
              },
            },
          },
          exhibits: [],
        },
      ],
      trial: { enabled: false, lessons: [] },
    },
  };
}

async function minimalPackage(): Promise<Buffer> {
  const files: Record<string, Buffer | string> = {
    'manifest.json': JSON.stringify(manifest()),
    'media/cover.png': PNG,
    'media/video/L001/en-GB.mp4': MP4,
  };
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  const lines = Object.entries(files)
    .filter(([name]) => name !== 'manifest.json')
    .map(
      ([name, content]) =>
        `${CourseStorageService.sha256(Buffer.isBuffer(content) ? content : Buffer.from(content))}  ${name}`,
    );
  zip.file('checksums.sha256', lines.join('\n'));
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('runImportWorker under ts-jest', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'lg-heavy-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('inspects a minimal valid package although no compiled worker file exists', async () => {
    const packagePath = path.join(dir, 'course.zip');
    const outDir = path.join(dir, 'out');
    await writeFile(packagePath, await minimalPackage());

    const result = await runImportWorker<{
      manifest: { course: { code: string } };
      report: { errors: unknown[] };
      files: string[];
    }>('inspect', { packagePath, outDir, config: testConfig() });

    expect(result.manifest.course.code).toBe('C900');
    expect(result.report.errors).toHaveLength(0);
    expect(result.files).toEqual(
      expect.arrayContaining(['media/cover.png', 'media/video/L001/en-GB.mp4']),
    );
    await expect(
      readFile(path.join(outDir, 'media/cover.png')),
    ).resolves.toEqual(PNG);
  });

  it('keeps the error code of a refused package when it runs in process', async () => {
    const packagePath = path.join(dir, 'broken.zip');
    await writeFile(packagePath, Buffer.from('not a zip'));
    await expect(
      runImportWorker('inspect', {
        packagePath,
        outDir: path.join(dir, 'out'),
        config: testConfig(),
      }),
    ).rejects.toMatchObject({ code: 'PACKAGE_INVALID_ZIP' });
  });
});
