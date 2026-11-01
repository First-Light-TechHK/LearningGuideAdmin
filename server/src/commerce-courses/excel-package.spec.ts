import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { buildPackageFromRawZip } from './excel-package';

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
    ['#', 'Text mode title – EN', 'Text mode title – 中文', 'Video mode title – EN', 'Video mode title – 中文', 'Video start – EN', 'Video start – 中文'],
    [1, 'text lp', '文本学习点', 'video lp', '视频学习点', '0:00', '0:00'],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(checklist), 'Checklist');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(courseInfo), 'Course info');
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
    const built = await buildPackageFromRawZip(bytes, { courseCode: 'TEMP002' });
    // 回归：曾错误地用兜底编号 TEMP002 覆盖了 Excel 里的真实 Course ID SCI001。
    expect(built.courseCode).toBe('SCI001');
  });

  it('falls back to the provided code when the template has no Course ID', async () => {
    const bytes = await zipWithXlsx(newTemplateWorkbook(''));
    const built = await buildPackageFromRawZip(bytes, { courseCode: 'TEMP007' });
    expect(built.courseCode).toBe('TEMP007');
  });
});
