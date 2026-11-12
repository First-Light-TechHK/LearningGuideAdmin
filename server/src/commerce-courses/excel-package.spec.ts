import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import {
  buildPackageFromRawZip,
  templateSeconds,
  toSeconds,
} from './excel-package';
import type { PackageManifest } from './contracts/manifest';

describe('Excel time values', () => {
  it('accepts scalar times without stringifying object cells', () => {
    expect(toSeconds('01:02:03')).toBe(3723);
    expect(toSeconds(0.5)).toBe(43200);
    for (const value of [
      null,
      undefined,
      {},
      [],
      { toString: () => '01:00' },
    ]) {
      expect(toSeconds(value)).toBeNull();
    }
  });
});

/**
 * 构造一个最小的「新版双语模板」工作簿（Checklist + Course info + Lessons）。
 * 只覆盖 buildPackageFromRawZip 判定新版模板所需的字段。
 */
function newTemplateWorkbook(courseId: string): Buffer {
  const wb = XLSX.utils.book_new();
  const checklist: unknown[][] = [
    ['Course title', 'Modeling life'],
    ['Course ID', courseId],
    ['Learning language', 'English'],
    ['Study mode', 'Both'],
    ['Number of lessons', 1],
  ];
  const courseInfo: unknown[][] = [
    ['Category', 'Science', '科学'],
    ['Course title', 'Modeling life', '建模人生'],
    ['Short description', 'desc', '简述'],
    ['Overview', 'overview', '概述'],
    ["What you'll learn"],
    [1, 'learn a', '学 a'],
    ['This course provides'],
    [1, 'preset', 'provide a', '提供 a'],
  ];
  const lessons: unknown[][] = [
    ['Lesson', '1'],
    ['Lesson ID', 'L001'],
    ['Lesson title (EN)', 'Lesson one'],
    ['Lesson title (中文)', '第一课'],
    ['Lesson description (EN)', 'desc'],
    [
      '#',
      'Text mode title – EN',
      'Text mode title – 中文',
      'Video mode title – EN',
      'Video mode title – 中文',
      'Video start – EN',
      'Video start – 中文',
    ],
    [1, 'text lp', '文本学习点', 'video lp', '视频学习点', '0:00', '0:00'],
  ];
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet(checklist),
    'Checklist',
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet(courseInfo),
    'Course info',
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(lessons), 'Lessons');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

async function zipWithXlsx(xlsx: Buffer): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('Course_Content_Template_modeling_life.xlsx', xlsx);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('buildPackageFromRawZip (new bilingual template)', () => {
  it('uses the Course ID from the Excel Checklist over the TEMP fallback', async () => {
    const bytes = await zipWithXlsx(newTemplateWorkbook('SCI001'));
    const built = await buildPackageFromRawZip(bytes, {
      courseCode: 'TEMP002',
    });
    // 回归：曾错误地用兜底编号 TEMP002 覆盖了 Excel 里的真实 Course ID SCI001。
    expect(built.courseCode).toBe('SCI001');
  });

  it('falls back to the provided code when the template has no Course ID', async () => {
    const bytes = await zipWithXlsx(newTemplateWorkbook(''));
    const built = await buildPackageFromRawZip(bytes, {
      courseCode: 'TEMP007',
    });
    expect(built.courseCode).toBe('TEMP007');
  });
});

describe('template mm:ss time columns', () => {
  it('reads Excel h:mm times and "hh:mm:00" text as mm:ss', () => {
    // Excel 把手输的 09:47 存成 09:47:00（一天的 0.4076）。
    expect(templateSeconds(9 / 24 + 47 / 1440)).toBe(9 * 60 + 47);
    expect(templateSeconds('09:47:00')).toBe(9 * 60 + 47);
    expect(templateSeconds('00:10:00')).toBe(10);
    expect(templateSeconds('20:04:00')).toBe(20 * 60 + 4);
  });

  it('keeps mm:ss text and real hh:mm:ss text as written', () => {
    expect(templateSeconds('06:52')).toBe(6 * 60 + 52);
    expect(templateSeconds('00:37')).toBe(37);
    expect(templateSeconds('01:02:03')).toBe(3723);
    expect(templateSeconds('')).toBeNull();
  });
});

/** 只含 mvhd 头的假 MP4：mp4DurationSeconds 只读 timescale 与 duration。 */
function fakeMp4(seconds: number): Buffer {
  const header = Buffer.alloc(20);
  header.writeUInt32BE(1000, 12);
  header.writeUInt32BE(seconds * 1000, 16);
  return Buffer.concat([Buffer.from('mvhd'), header]);
}

function timedWorkbook(
  starts: unknown[],
  trigger: unknown,
  readingType: string,
): Buffer {
  const wb = XLSX.utils.book_new();
  const sheet = (rows: unknown[][], name: string) =>
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  sheet(
    [
      ['Course ID', 'C001'],
      ['Learning language', 'English'],
      ['Study mode', 'Video'],
    ],
    'Checklist',
  );
  sheet(
    [
      ['Category', 'Science'],
      ['Course title', 'Modeling life'],
    ],
    'Course info',
  );
  sheet(
    [
      ['Lesson', 'Lesson 1'],
      ['Lesson ID', 'L001'],
      ['Lesson title (EN)', 'Lesson one'],
      ['#', 'Text mode title – EN'],
      ...starts.map((start, i) => [
        `1.${i + 1}`,
        `lp ${i + 1}`,
        '',
        `lp ${i + 1}`,
        '',
        start,
        '',
      ]),
    ],
    'Lessons',
  );
  sheet(
    [
      ['Lesson ID', 'Lesson', 'Exhibit ID'],
      [
        'L001',
        'Lesson 1',
        'E01',
        'Image',
        'Coffee',
        '',
        'd',
        '',
        '-',
        '',
        trigger,
      ],
    ],
    'Exhibits',
  );
  sheet(
    [
      ['Lesson ID', 'Lesson', 'Type', 'Title', 'Author', 'Why'],
      ['L001', 'Lesson 1', readingType, 'Lectures 9-13', 'MIT', 'intro'],
    ],
    'Reading list',
  );
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

async function readManifest(bytes: Buffer): Promise<PackageManifest> {
  const zip = await JSZip.loadAsync(bytes);
  return JSON.parse(
    await zip.file('manifest.json')!.async('string'),
  ) as PackageManifest;
}

describe('buildPackageFromRawZip video times (Modeling life)', () => {
  async function build(
    starts: unknown[],
    trigger: unknown,
    readingType = 'Other',
  ) {
    const zip = new JSZip();
    zip.file(
      'Course_Content_Template_modeling_life.xlsx',
      timedWorkbook(starts, trigger, readingType),
    );
    zip.file('Lesson 1视频课件.mp4', fakeMp4(1469));
    zip.file('lesson1-exhibit-1.png', Buffer.from('png'));
    const built = await buildPackageFromRawZip(
      await zip.generateAsync({ type: 'nodebuffer' }),
    );
    return { built, manifest: await readManifest(built.bytes) };
  }

  it('reads Excel times as mm:ss so they stay inside the 24:29 video', async () => {
    // 回归：Modeling life 的 09:47 / 02:40 被读成 9 小时 47 分 / 2 小时 40 分。
    const { built, manifest } = await build(
      ['00:10', 9 / 24 + 47 / 1440, '19:35:00'],
      2 / 24 + 40 / 1440,
    );
    const video = manifest.course.lessons[0].localized['en-GB'].video;
    expect(video?.durationSeconds).toBe(1469);
    expect(video?.learningPoints.map((lp) => lp.timeSeconds)).toEqual([
      10,
      9 * 60 + 47,
      19 * 60 + 35,
    ]);
    expect(video?.exhibitTriggers).toEqual([
      { timeSeconds: 160, exhibitRef: 'E01' },
    ]);
    expect(built.warnings.join('\n')).not.toContain('超出视频时长');
  });

  it('flags learning points and triggers beyond the video length', async () => {
    const { built, manifest } = await build(['00:10', '30:00'], '25:00');
    expect(built.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('「lp 2」时间 30:00 超出视频时长 24:29'),
        expect.stringContaining('E01 触发时间 25:00 超出视频时长 24:29'),
      ]),
    );
    expect(manifest.incomplete).toBe(true);
  });

  it('keeps reading type Other instead of turning it into Article', async () => {
    const { manifest } = await build(['00:10'], '00:37');
    const readings = manifest.course.lessons[0].recommendedReading ?? {};
    expect(readings['en-GB']?.[0]?.type).toBe('OTHER');
  });
});
