import { createHash, randomUUID } from "node:crypto";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { MarkItDown } from "markitdown-ts";
import { PACKAGE_FORMAT, PACKAGE_FORMAT_VERSION } from "./contracts/manifest";
import { mp4DurationSeconds } from "./media-duration";
import type {
  PackageCourse,
  PackageExhibit,
  PackageKnowledgeQuestion,
  PackageLesson,
  PackageManifest,
  PackageReading,
  PackageTextLearningPoint,
  PackageVideoLearningPoint,
} from "./contracts/manifest";

const LANG = "en-GB";
const mdConverter = new MarkItDown();

function sha(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function sheetRows(wb: XLSX.WorkBook, name: string): unknown[][] {
  const sheet = wb.Sheets[name];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null }) as unknown[][];
}

function cell(v: unknown): string {
  return v === null || v === undefined ? "" : String(v).trim();
}

function mdToHtml(markdown: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { out.push("<p>" + esc(para.join(" ")) + "</p>"); para = []; } };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flush(); out.push("<h" + h[1].length + ">" + esc(h[2].trim()) + "</h" + h[1].length + ">"); continue; }
    para.push(line.trim());
  }
  flush();
  return out.join("\n") || "<p></p>";
}

const mdConverterDone = async (bytes: Buffer): Promise<string> => {
  try { const r = await mdConverter.convertBuffer(bytes, { file_extension: ".docx" }); return mdToHtml(r?.markdown ?? ""); }
  catch { return ""; }
};


export function numberedLines(raw: string): string[] {
  return raw.split(/\r?\n/).map((s) => s.replace(/^\s*\d+\.\s*/, "").trim()).filter(Boolean);
}
interface RawLesson {
  no: number;
  title: string;
  description: string;
  textLps: string[];
  videoLps: { title: string; timeSeconds: number }[];
  exhibits: { title: string; description: string; timeSeconds: number }[];
}

function parseLessons(rows: unknown[][]): RawLesson[] {
  const out: RawLesson[] = [];
  let current: RawLesson | null = null;
  let inVideo = false;
  for (const row of rows) {
    if (!row) continue;
    const first = cell(row[0]);
    const head = /^Lesson\s+(\d+)/i.exec(first);
    if (head) {
      current = { no: Number(head[1]), title: "", description: "", textLps: [], videoLps: [], exhibits: [] };
      out.push(current);
      inVideo = false;
      continue;
    }
    if (!current) continue;
    if (row.some((v) => cell(v) === "视频开始节点")) { inVideo = true; continue; }
    if (first === "标题" && cell(row[1])) current.title = cell(row[1]);
    else if (first === "简述" && cell(row[1])) current.description = cell(row[1]);
    else if (first.startsWith("文本") && cell(row[1])) current.textLps.push(cell(row[1]));
    else if (first === "" && cell(row[1]) && row[2] === null && !inVideo) current.textLps.push(cell(row[1]));
    else if (inVideo) {
      const lp = cell(row[1]);
      if (lp && typeof row[2] === "number") current.videoLps.push({ title: lp, timeSeconds: Math.round((row[2] as number) * 86400) });
      const ex = cell(row[4]);
      if (ex) current.exhibits.push({ title: ex, description: cell(row[5]), timeSeconds: typeof row[3] === "number" ? Math.round((row[3] as number) * 86400) : 0 });
    }
  }
  return out;
}

function parseCourseInfo(rows: unknown[][]): Map<string, string> {
  const info = new Map<string, string>();
  for (const row of rows) { const k = cell(row?.[0]); if (k) info.set(k, cell(row?.[1])); }
  return info;
}

function parseReadings(rows: unknown[][]): Map<number, PackageReading[]> {
  const map = new Map<number, PackageReading[]>();
  let current = 0;
  for (const row of rows) {
    const first = cell(row?.[0]);
    const heading = /Lesson\s+(\d+)\s+Reading list/i.exec(first);
    if (heading) { current = Number(heading[1]); map.set(current, map.get(current) ?? []); continue; }
    if (!current || !first || /^Exhibit\s/i.test(first)) continue;
    const list = map.get(current) ?? [];
    list.push({ type: "BOOK", title: first });
    map.set(current, list);
  }
  return map;
}

function parseKnowledge(rows: unknown[][]): Map<number, PackageKnowledgeQuestion[]> {
  const map = new Map<number, PackageKnowledgeQuestion[]>();
  for (const row of rows.slice(1)) {
    const m = /Lesson\s+(\d+)/i.exec(cell(row?.[0]));
    if (!m) continue;
    const n = Number(m[1]);
    const list = map.get(n) ?? [];
    list.push({ code: `K-${n}-${list.length + 1}`, question: cell(row[2]), referenceAnswer: cell(row[3]) || undefined });
    map.set(n, list);
  }
  return map;
}

function parseApplications(rows: unknown[][]): Map<number, { scenario: string; referenceAnswer?: string }> {
  const map = new Map<number, { scenario: string; referenceAnswer?: string }>();
  for (const row of rows.slice(1)) {
    const m = /Lesson\s+(\d+)/i.exec(cell(row?.[0]));
    if (m) map.set(Number(m[1]), { scenario: cell(row[1]), referenceAnswer: cell(row[2]) || undefined });
  }
  return map;
}

async function readMedia(mediaZip: Buffer | null): Promise<Map<string, Buffer>> {
  const map = new Map<string, Buffer>();
  if (!mediaZip) return map;
  const z = await JSZip.loadAsync(mediaZip);
  for (const [name, file] of Object.entries(z.files)) {
    if (file.dir || name.startsWith("__MACOSX/") || name.includes("/.DS_Store") || name.endsWith(".DS_Store")) continue;
    const base = name.split("/").pop() ?? name;
    const buf = await file.async("nodebuffer");
    map.set(base.toLowerCase(), buf);
  }
  return map;
}

function findMedia(map: Map<string, Buffer>, predicate: (name: string) => boolean): { name: string; bytes: Buffer } | null {
  for (const [name, bytes] of map) if (predicate(name)) return { name, bytes };
  return null;
}

export interface ExcelPackageResult {
  bytes: Buffer;
  courseCode: string;
  slug: string;
  title: string;
  lessonCount: number;
  mediaCount: number;
  warnings: string[];
}

export async function buildPackageFromRawZip(
  source: Buffer,
  options: { courseCode?: string; slug?: string } = {},
): Promise<ExcelPackageResult> {
  const raw = await JSZip.loadAsync(source);
  const xlsxEntry = Object.entries(raw.files).find(([name, file]) => !file.dir && /modeling life课程信息\.xlsx$/i.test(name));
  if (!xlsxEntry) throw new Error('原始素材 ZIP 中找不到 modeling life课程信息.xlsx');
  const xlsxBytes = await xlsxEntry[1].async('nodebuffer');
  const wb = XLSX.read(xlsxBytes, { type: 'buffer' });
  const requiredSheets = ['course info', 'Lessons', 'exploration-reading list', 'knowledge test', 'application test'];
  const missing = requiredSheets.filter((name) => !wb.Sheets[name]);
  if (missing.length) throw new Error(`Excel 缺少 Sheet：${missing.join(', ')}`);

  const mediaZip = new JSZip();
  for (const [name, file] of Object.entries(raw.files)) {
    if (file.dir || name.startsWith('__MACOSX/') || name.endsWith('.DS_Store') || /\.xlsx$/i.test(name)) continue;
    const bytes = await file.async('nodebuffer');
    const base = name.split('/').pop() ?? name;
    if (base.startsWith('.')) continue;
    mediaZip.file(base, bytes);
  }
  const media = await readMedia(await mediaZip.generateAsync({ type: 'nodebuffer' }));
  const warnings: string[] = [];
  const info = parseCourseInfo(sheetRows(wb, 'course info'));
  const title = info.get('课程标题') || 'Imported Course';
  const category = info.get('课程分类') || 'Uncategorised';
  const shortDescription = info.get('课程简述') || '';
  const overview = info.get('overview') || '';
  const whatYouLearn = numberedLines(info.get("what you'll learn") || '');
  const provides = numberedLines(info.get('This course provides') || '').map((s) => ({ type: 'custom', title: s }));
  const lessons = parseLessons(sheetRows(wb, 'Lessons'));
  if (!lessons.length) throw new Error('Lessons Sheet 中没有可导入的课时');
  const readings = parseReadings(sheetRows(wb, 'exploration-reading list'));
  const knowledge = parseKnowledge(sheetRows(wb, 'knowledge test'));
  const applications = parseApplications(sheetRows(wb, 'application test'));
  const courseCode = (options.courseCode || 'C001').trim().toUpperCase();
  const slug = (options.slug || 'modeling-life').trim().toLowerCase();
  const out = new JSZip();
  const checksums: string[] = [];
  const add = (name: string, bytes: Buffer) => { out.file(name, bytes); checksums.push(`${sha(bytes)}  ${name}`); };

  const cover = findMedia(media, (n) => n.includes('课程封面') && n.endsWith('.png'));
  const coverPath = cover ? 'media/cover.png' : undefined;
  if (cover) add(coverPath!, cover.bytes); else warnings.push('未找到课程封面 PNG');

  const pkgLessons: PackageLesson[] = [];
  for (const lesson of lessons) {
    const code = `L${String(lesson.no).padStart(3, '0')}`;
    const docx = findMedia(media, (n) => n.includes(`lesson ${lesson.no}`) && n.includes('文本课件') && n.endsWith('.docx'))
      || findMedia(media, (n) => n.includes(`lesson ${lesson.no}`) && n.includes('文本') && n.endsWith('.docx'));
    const html = docx ? await mdConverterDone(docx.bytes) : '';
    if (!docx) warnings.push(`Lesson ${lesson.no} 缺少文本课件 DOCX`);
    const video = findMedia(media, (n) => n.includes(`lesson ${lesson.no}`) && n.includes('视频课件') && n.endsWith('.mp4'));
    let videoPath: string | undefined;
    let videoDuration: number | null = null;
    if (video) {
      videoPath = `media/video/${code}/en-GB.mp4`;
      add(videoPath, video.bytes);
      const d = mp4DurationSeconds(video.bytes);
      videoDuration = d ? Math.round(d) : null;
    } else warnings.push(`Lesson ${lesson.no} 缺少视频课件 MP4`);

    const exhibits: PackageExhibit[] = [];
    for (let i = 0; i < lesson.exhibits.length; i++) {
      const meta = lesson.exhibits[i];
      const no = i + 1;
      const image = findMedia(media, (n) => n.includes(`exhibit-${no}`) && n.endsWith('.png') && !n.includes('缩略图'));
      const thumb = findMedia(media, (n) => n.includes(`exhibit${no}`) && n.includes('缩略图') && n.endsWith('.png'));
      if (!image) { warnings.push(`Lesson ${lesson.no} 展品「${meta.title}」缺少图片，已跳过`); continue; }
      const exCode = `E${String(lesson.no).padStart(2, '0')}${String(no).padStart(2, '0')}`;
      const imagePath = `media/exhibits/${exCode}.png`;
      add(imagePath, image.bytes);
      let thumbnailPath: string | undefined;
      if (thumb) { thumbnailPath = `media/exhibits/${exCode}.thumb.png`; add(thumbnailPath, thumb.bytes); }
      exhibits.push({ code: exCode, type: 'IMAGE', file: imagePath, thumbnail: thumbnailPath, localized: { [LANG]: { title: meta.title, description: meta.description || undefined } } });
    }

    const textLearningPoints: PackageTextLearningPoint[] = lesson.textLps.map((heading, i) => ({ code: `T-${lesson.no}.${i + 1}`, heading, level: 1 }));
    const videoLearningPoints: PackageVideoLearningPoint[] = video ? lesson.videoLps.map((lp, i) => ({ code: `V-${lesson.no}.${i + 1}`, timeSeconds: lp.timeSeconds, title: lp.title })) : [];
    const loc = {
      title: lesson.title || `Lesson ${lesson.no}`,
      description: lesson.description || undefined,
      video: videoPath ? { file: videoPath, durationSeconds: videoDuration ?? undefined, learningPoints: videoLearningPoints, exhibitTriggers: [] } : null,
      text: { html, learningPoints: textLearningPoints },
    };
    const qs: PackageKnowledgeQuestion[] = knowledge.get(lesson.no) || [];
    const appTest = applications.get(lesson.no);
    pkgLessons.push({
      code,
      order: lesson.no,
      localized: { [LANG]: loc },
      exhibits,
      recommendedReading: readings.has(lesson.no) ? { [LANG]: readings.get(lesson.no)! } : {},
      knowledgeTest: { enabled: qs.length > 0, questions: qs },
      applicationTest: appTest ? { enabled: true, scenario: appTest.scenario, referenceAnswer: appTest.referenceAnswer } : undefined,
    });
  }

  const course: PackageCourse = {
    code: courseCode,
    slug,
    category,
    learningMode: 'VIDEO_AND_TEXT',
    learningLanguages: [LANG],
    defaultContentLanguage: LANG,
    cover: coverPath,
    localized: { [LANG]: { title, shortDescription, overview, whatYouLearn, provides } },
    lessons: pkgLessons,
    trial: { enabled: false, lessons: [] },
  };
  const manifest: PackageManifest = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    packageId: `raw-excel-${randomUUID()}`,
    exportedAt: new Date().toISOString(),
    source: { environment: 'EXCEL_IMPORT', courseCode },
    incomplete: warnings.length > 0,
    course,
  };
  out.file('manifest.json', JSON.stringify(manifest, null, 2));
  out.file('checksums.sha256', checksums.join('\n'));
  const bytes = await out.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { bytes, courseCode, slug, title, lessonCount: pkgLessons.length, mediaCount: checksums.length, warnings };
}

