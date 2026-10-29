#!/usr/bin/env node
/**
 * Modeling Life 一次性转换器：把 docs/Modeling Life Data 的原始素材转成标准课程包 (.lgcourse.zip)。
 * 见 docs/Course_Module_Import_Export_Design.md §7.5。
 *
 * 用法：
 *   cd server && node scripts/modeling-life-to-package.mjs --out ../docs/modeling-life.lgcourse.zip
 *
 * 输入（默认 ../docs/Modeling Life Data）：
 *   - modeling life课程信息.xlsx（结构主源：课程信息 / Lessons / 阅读清单 / 知识测试 / 应用测试）
 *   - Lesson N 文本课件.docx（课时文本，转 HTML，去掉内嵌大图）
 *   - Lesson N视频课件.mp4（课时视频）
 *   - lesson1-exhibit-*.png / *缩略图.png（展品）
 *   - 课程封面.png
 *
 * 说明：docx 结构不规范，文本学习点/展品编号需人工在 Admin 复核；本脚本产出「近成品」包。
 */

import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import XLSX from 'xlsx';
import mammoth from 'mammoth';
import JSZip from 'jszip';

const { values } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    out: { type: 'string' },
    'course-code': { type: 'string', default: 'C001' },
    slug: { type: 'string', default: 'modeling-life' },
  },
});

const DATA_DIR = path.resolve(values['data-dir'] ?? '../docs/Modeling Life Data');
const OUT = path.resolve(values.out ?? '../docs/modeling-life.lgcourse.zip');

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

async function findFile(prefix, ext) {
  const entries = await readdir(DATA_DIR);
  const hit = entries.find((n) => n.startsWith(prefix) && n.toLowerCase().endsWith(ext));
  return hit ? path.join(DATA_DIR, hit) : null;
}

function sheetRows(wb, name) {
  const sheet = wb.Sheets[name];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
}

/** 从 docx 转 HTML（去内嵌图片，避免 base64 撑爆包体）。 */
async function docxToHtml(filePath) {
  if (!filePath) return '';
  const result = await mammoth.convertToHtml(
    { path: filePath },
    { convertImage: mammoth.images.imgElement(() => ({ src: '' })) },
  );
  let html = result.value;
  // 去掉空 img
  html = html.replace(/<img[^>]*src=""[^>]*>/g, '');
  return html;
}

async function main() {
  console.log('Reading', DATA_DIR);
  const xlsxPath = await findFile('modeling life课程信息', '.xlsx');
  if (!xlsxPath) throw new Error('course xlsx not found');
  const wb = XLSX.readFile(xlsxPath);

  // ---- 课程信息 ----
  const infoRows = sheetRows(wb, 'course info');
  const info = new Map();
  for (const row of infoRows) {
    if (row && row[0]) info.set(String(row[0]).trim(), row[1]);
  }
  const title = String(info.get('课程标题') ?? 'Modeling Life').trim();
  const category = String(info.get('课程分类') ?? 'Science').trim();
  const shortDescription = String(info.get('课程简述') ?? '').trim();
  const overview = String(info.get('overview') ?? '').trim();
  const whatYouLearnRaw = String(info.get("what you'll learn") ?? '');
  const whatYouLearn = whatYouLearnRaw
    .split(/\r?\n/)
    .map((s) => s.replace(/^\d+\.\s*/, '').trim())
    .filter(Boolean);
  const providesRaw = String(info.get('This course provides') ?? '');
  const provides = providesRaw
    .split(/\r?\n/)
    .map((s) => s.replace(/^\d+\.\s*/, '').trim())
    .filter(Boolean)
    .map((t) => ({ type: 'custom', title: t }));

  // ---- 课时 ----
  const lessonRows = sheetRows(wb, 'Lessons');
  const lessons = [];
  let current = null;
  for (const row of lessonRows) {
    if (!row) continue;
    const first = row[0];
    if (typeof first === 'string' && /^Lesson\s+\d+/i.test(first.trim())) {
      current = { title: '', description: '', textLps: [], videoLps: [], exhibits: [] };
      lessons.push(current);
      continue;
    }
    if (!current) continue;
    const label = typeof first === 'string' ? first.trim() : '';
    if (label === '标题' && row[1]) current.title = String(row[1]).trim();
    else if (label === '简述' && row[1]) current.description = String(row[1]).trim();
    else if (label === '文本\r\nLearning point' && row[1]) current.textLps.push(String(row[1]).trim());
    else if (row[1] && current.textLps.length && first == null && row[2]) {
      current.textLps.push(String(row[2]).trim());
    }
  }
  // 视频学习点/展品触发行（表头：视频开始节点 | exhibit弹窗触发节点 | exhibit标题 | 简述 | 来源）
  // 简化：把含时间数字的行识别为视频学习点
  for (const row of lessonRows) {
    if (!row) continue;
    const maybeTime = row[2];
    if (typeof maybeTime === 'number' && current) {
      // row[1]=学习点标题, row[3]=触发节点时间, row[4]=exhibit标题, row[5]=简述
      if (row[1]) current.videoLps.push(String(row[1]).trim());
    }
  }

  // ---- 阅读清单 ----
  const readingRows = sheetRows(wb, 'exploration-reading list');
  const readingsByLesson = new Map();
  for (const row of readingRows) {
    if (!row || !row[0]) continue;
    const header = String(row[0]);
    const m = /Lesson\s+(\d+)/i.exec(header);
    if (m && /Reading list/i.test(header)) continue;
    if (typeof row[0] === 'string' && row[0].trim()) {
      const entry = { type: 'BOOK', title: String(row[0]).trim() };
      const arr = readingsByLesson.get(readingsByLesson.size ? 'last' : 'x') ?? [];
      void arr;
      readingsByLesson.set(header || `r${readingsByLesson.size}`, [entry]);
    }
  }

  // ---- 知识测试 ----
  const ktRows = sheetRows(wb, 'knowledge test');
  const ktByLesson = new Map();
  for (const row of ktRows.slice(1)) {
    if (!row || !row[0]) continue;
    const m = /Lesson\s+(\d+)/i.exec(String(row[0]));
    if (!m) continue;
    const idx = Number(m[1]);
    const list = ktByLesson.get(idx) ?? [];
    list.push({ code: `K-${String(idx).padStart(2, '0')}${String(row[1] ?? list.length + 1).padStart(2, '0')}`, question: String(row[2] ?? '').trim(), referenceAnswer: String(row[3] ?? '').trim() });
    ktByLesson.set(idx, list);
  }

  // ---- 应用测试 ----
  const atRows = sheetRows(wb, 'application test');
  const atByLesson = new Map();
  for (const row of atRows.slice(1)) {
    if (!row || !row[0]) continue;
    const m = /Lesson\s+(\d+)/i.exec(String(row[0]));
    if (!m) continue;
    atByLesson.set(Number(m[1]), { scenario: String(row[1] ?? '').trim(), referenceAnswer: String(row[2] ?? '').trim() });
  }

  // ---- 媒体 ----
  const coverPath = await findFile('课程封面', '.png');
  const coverBuf = coverPath ? await readFile(coverPath) : null;

  // 课时视频 / docx
  const zip = new JSZip();
  const checksums = [];
  const addFile = (relPath, buf) => {
    zip.file(relPath, buf);
    checksums.push(`${sha(buf)}  ${relPath}`);
  };

  let coverRel;
  if (coverBuf) {
    coverRel = 'media/cover.png';
    addFile(coverRel, coverBuf);
  }

  const packageLessons = [];
  for (let i = 0; i < lessons.length; i++) {
    const l = lessons[i];
    const lessonNo = i + 1;
    const code = `L${String(lessonNo).padStart(3, '0')}`;
    const docx = await findFile(`Lesson ${lessonNo} 文本课件`, '.docx');
    const video = await findFile(`Lesson ${lessonNo}视频课件`, '.mp4');
    const textHtml = await docxToHtml(docx);

    let videoRel;
    if (video) {
      const buf = await readFile(video);
      videoRel = `media/video/${code}/en-GB.mp4`;
      addFile(videoRel, buf);
    }

    // 展品（lesson1 才有示例图）
    const exhibits = [];
    if (lessonNo === 1) {
      const ex1 = await findFile('lesson1-exhibit-1', '.png');
      const ex2 = await findFile('lesson1-exhibit-2', '.png');
      const th1 = await findFile('lesson1-exhibit1', '.png');
      const th2 = await findFile('lesson1-exhibit2', '.png');
      const addEx = async (code2, file, thumb) => {
        if (!file) return;
        const buf = await readFile(file);
        addFile(`media/exhibits/${code2}.png`, buf);
        let thumbRel;
        if (thumb) {
          const tb = await readFile(thumb);
          thumbRel = `media/exhibits/${code2}.thumb.png`;
          addFile(thumbRel, tb);
        }
        exhibits.push({
          code: code2,
          type: 'IMAGE',
          file: `media/exhibits/${code2}.png`,
          thumbnail: thumbRel,
          localized: { 'en-GB': { title: `Exhibit ${code2.replace('E', '')}` } },
        });
      };
      await addEx('E001', ex1, th1);
      await addEx('E002', ex2, th2);
    }

    const textLps = l.textLps.map((t, idx) => ({ code: `1.${idx + 1}`, heading: t, level: 1 }));
    const videoLps = l.videoLps.map((t, idx) => ({ code: `1.${idx + 1}`, timeSeconds: idx * 60, title: t }));

    packageLessons.push({
      code,
      order: lessonNo,
      localized: {
        'en-GB': {
          title: l.title || `Lesson ${lessonNo}`,
          description: l.description || undefined,
          video: videoRel
            ? { file: videoRel, learningPoints: videoLps, exhibitTriggers: [] }
            : null,
          text: textHtml ? { html: textHtml, learningPoints: textLps } : null,
        },
      },
      exhibits,
      recommendedReading: {},
      knowledgeTest: ktByLesson.get(lessonNo)
        ? { enabled: true, questions: ktByLesson.get(lessonNo) }
        : { enabled: false, questions: [] },
      applicationTest: atByLesson.get(lessonNo)
        ? { enabled: true, ...atByLesson.get(lessonNo) }
        : undefined,
    });
  }

  const manifest = {
    format: 'lg-course-package',
    formatVersion: 1,
    packageId: `pkg_modeling_life_${Date.now().toString(36)}`,
    exportedAt: new Date().toISOString(),
    source: { environment: 'DOCS', courseCode: values['course-code'], sourceVersion: 'working' },
    incomplete: true, // 中文材料/部分学习点待人工补齐
    course: {
      code: values['course-code'],
      slug: values.slug,
      category,
      learningMode: 'VIDEO_AND_TEXT',
      learningLanguages: ['en-GB'],
      defaultContentLanguage: 'en-GB',
      cover: coverRel,
      localized: {
        'en-GB': { title, shortDescription, overview, whatYouLearn, provides },
      },
      lessons: packageLessons,
      trial: { enabled: false, lessons: [] },
    },
  };

  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('checksums.sha256', checksums.join('\n'));

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await writeFile(OUT, buf);
  const sizeMB = (buf.length / (1024 * 1024)).toFixed(1);
  console.log(`Wrote ${OUT} (${sizeMB} MB), lessons=${packageLessons.length}, media files=${checksums.length}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
