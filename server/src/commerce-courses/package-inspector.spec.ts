import JSZip from 'jszip';
import { PackageInspector } from './package-inspector';
import { CourseStorageService } from './storage.service';
import type { CommerceCourseConfig } from './commerce.config';

function testConfig(): CommerceCourseConfig {
  return {
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

// Minimal valid PNG (1x1) signature + payload
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
);

function validManifest() {
  return {
    format: 'lg-course-package',
    formatVersion: 1,
    packageId: 'pkg_test',
    exportedAt: new Date().toISOString(),
    source: {},
    incomplete: false,
    course: {
      code: 'C900',
      slug: 'test-course',
      category: 'Science',
      learningMode: 'VIDEO_AND_TEXT',
      learningLanguages: ['en-GB'],
      defaultContentLanguage: 'en-GB',
      cover: 'media/cover.png',
      localized: {
        'en-GB': { title: 'Test', shortDescription: 'desc', overview: 'ov', whatYouLearn: ['a'] },
      },
      lessons: [
        {
          code: 'L001',
          order: 1,
          localized: {
            'en-GB': {
              title: 'Lesson 1',
              video: { file: 'media/video/L001/en-GB.mp4', learningPoints: [] },
              text: { html: '<h1>Hello</h1>', learningPoints: [{ code: '1.1', heading: 'Hello' }] },
            },
          },
          exhibits: [],
        },
      ],
      trial: { enabled: false, lessons: [] },
    },
  };
}

async function buildZip(files: Record<string, Buffer | string>, withChecksums = true): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  if (withChecksums) {
    const lines = Object.entries(files)
      .filter(([name]) => name !== 'manifest.json')
      .map(([name, content]) => {
        const buf = typeof content === 'string' ? Buffer.from(content) : content;
        return `${CourseStorageService.sha256(buf)}  ${name}`;
      });
    zip.file('checksums.sha256', lines.join('\n'));
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

function inspector() {
  return new PackageInspector(testConfig(), {} as CourseStorageService);
}

// A tiny fake mp4 (ftyp box) to satisfy signature check
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'ascii'), Buffer.alloc(16)]);

describe('PackageInspector', () => {
  it('accepts a valid package', async () => {
    const zip = await buildZip({
      'manifest.json': JSON.stringify(validManifest()),
      'media/cover.png': PNG,
      'media/video/L001/en-GB.mp4': MP4,
    });
    const result = await inspector().inspect(zip);
    expect(result.manifest.course.code).toBe('C900');
    expect(result.report.errors.length).toBe(0);
  });

  it('rejects checksum mismatch', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify(validManifest()));
    zip.file('media/cover.png', PNG);
    zip.file('media/video/L001/en-GB.mp4', MP4);
    zip.file('checksums.sha256', `${'a'.repeat(64)}  media/cover.png`);
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(inspector().inspect(buf)).rejects.toMatchObject({ code: 'PACKAGE_CHECKSUM_MISMATCH' });
  });

  it('rejects invalid zip', async () => {
    await expect(inspector().inspect(Buffer.from('not a zip'))).rejects.toMatchObject({
      code: 'PACKAGE_INVALID_ZIP',
    });
  });

  it('explains that a Word document is not a course package', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('word/document.xml', '<document/>');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(inspector().inspect(buf)).rejects.toMatchObject({
      code: 'PACKAGE_NOT_A_COURSE',
      status: 422,
      message: expect.stringContaining('Word/Office document'),
    });
  });

  it('rejects missing media referenced by manifest', async () => {
    const zip = await buildZip({
      'manifest.json': JSON.stringify(validManifest()),
      // cover.png intentionally omitted
      'media/video/L001/en-GB.mp4': MP4,
    });
    await expect(inspector().inspect(zip)).rejects.toMatchObject({ code: 'PACKAGE_MEDIA_INVALID' });
  });
});
