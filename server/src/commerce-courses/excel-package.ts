import { createHash, randomUUID } from "node:crypto";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { MarkItDown } from "markitdown-ts";
import { PACKAGE_FORMAT, PACKAGE_FORMAT_VERSION } from "./contracts/manifest";
import { mp4DurationSeconds } from "./media-duration";
import type {
  ExhibitType,
  LearningMode,
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
  const key = Object.keys(wb.Sheets).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return [];
  return XLSX.utils.sheet_to_json(wb.Sheets[key], { header: 1, defval: null }) as unknown[][];
}

function hasSheet(wb: XLSX.WorkBook, name: string): boolean {
  return Object.keys(wb.Sheets).some((k) => k.toLowerCase() === name.toLowerCase());
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

/** 把 "mm:ss" / "hh:mm:ss" / Excel 时间小数（以天为单位）都换算成秒。 */
export function toSeconds(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 86400) : null;
  const text = String(value).trim();
  if (!text) return null;
  const parts = text.split(":").map((p) => Number(p));
  if (parts.length > 0 && parts.every((n) => Number.isFinite(n))) {
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 1) return Math.round(parts[0]);
  }
  return null;
}

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

function findMedia(map: Map<string, Buffer>, predicate: (name: string) => boolean): { name: string; bytes: Buffer } | null {
  for (const [name, bytes] of map) if (predicate(name)) return { name, bytes };
  return null;
}

const isImageName = (n: string) => /\.(png|jpg|jpeg|gif|webp)$/.test(n);
const isVideoName = (n: string) => /\.(mp4|mov|webm)$/.test(n);
const isModelName = (n: string) => /\.(glb|gltf|obj)$/.test(n);
const isDocxName = (n: string) => /\.docx$/.test(n);
const isZhName = (n: string) => /中文|zh|cn|chinese|中国/.test(n);

function lessonNameMatch(name: string, lessonId: string, lessonNo: number): boolean {
  const id = lessonId.toLowerCase();
  if (id && name.includes(id)) return true;
  return name.includes(`lesson ${lessonNo}`) || name.includes(`lesson${lessonNo}`) || name.includes(`lesson_${lessonNo}`) || name.includes(`l${String(lessonNo).padStart(3, "0")}`);
}

function parseStudyMode(value: string): LearningMode {
  const v = value.toLowerCase();
  if (v.includes("both") || v.includes("video & text") || v.includes("video and text") || (v.includes("video") && v.includes("text"))) return "VIDEO_AND_TEXT";
  if (v.includes("video")) return "VIDEO_ONLY";
  if (v.includes("text")) return "TEXT_ONLY";
  return "VIDEO_AND_TEXT";
}

function parseLanguages(value: string): string[] {
  const v = value.toLowerCase();
  const both = (v.includes("english") && (v.includes("chinese") || v.includes("中文"))) || v.includes("both") || v.includes("&");
  if (both) return ["en-GB", "zh-CN"];
  if (v.includes("chinese") || v.includes("中文") || v === "zh") return ["zh-CN"];
  return ["en-GB"];
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

interface RawMedia {
  media: Map<string, Buffer>;
  add: (name: string, bytes: Buffer) => void;
  checksums: string[];
  out: JSZip;
}

// 已经压缩过的媒体（视频/图片/模型/Office/PDF）再 DEFLATE 一次几乎不缩小，
// 却会在 1 vCPU 的实例上耗掉大量 CPU 与内存，使 ~150MB 素材包的转换/校验
// 超时（表现为 App Runner/CloudFront 5xx，前端显示 INTERNAL_ERROR）。
// 这些文件用 STORE 直接存储，只有 manifest/checksums 等文本仍走 DEFLATE。
const ALREADY_COMPRESSED = /\.(mp4|mov|webm|m4v|png|jpe?g|gif|webp|mp3|m4a|aac|glb|gltf|obj|pdf|zip|docx|xlsx|pptx)$/i;
function fileCompression(name: string): "STORE" | "DEFLATE" {
  return ALREADY_COMPRESSED.test(name) ? "STORE" : "DEFLATE";
}

function createPackager(): RawMedia {
  const out = new JSZip();
  const checksums: string[] = [];
  const add = (name: string, bytes: Buffer) => {
    out.file(name, bytes, { compression: fileCompression(name) });
    checksums.push(`${sha(bytes)}  ${name}`);
  };
  return { media: new Map(), add, checksums, out };
}

export async function buildPackageFromRawZip(
  source: Buffer,
  options: { courseCode?: string; slug?: string } = {},
): Promise<ExcelPackageResult> {
  const raw = await JSZip.loadAsync(source);

  // 1) 收集媒体（除 xlsx 外的全部文件）与所有 xlsx 候选。
  // 直接把媒体读进 Map，不再先重打包成 mediaZip 再读回：省掉一次
  // ~150MB 的 zip 生成/解析（约 1 份全量内存与大半转换耗时），降低
  // 小内存实例上大素材包导入 OOM/超时的概率。
  const media = new Map<string, Buffer>();
  const xlsxFiles: { base: string; entry: JSZip.JSZipObject }[] = [];
  for (const [name, file] of Object.entries(raw.files)) {
    if (file.dir || name.startsWith("__MACOSX/") || name.includes("/__MACOSX/") || name.endsWith(".DS_Store")) continue;
    const base = name.split("/").pop() ?? name;
    if (!base || base.startsWith(".")) continue;
    if (base.startsWith("~$")) continue; // Excel 临时锁文件（如 ~$xxx.xlsx），跳过
    if (/\.xlsx$/i.test(base)) { xlsxFiles.push({ base, entry: file }); continue; }
    media.set(base.toLowerCase(), await file.async("nodebuffer"));
  }
  if (!xlsxFiles.length) throw new Error("原始素材 ZIP 中找不到 Excel（.xlsx）模板文件");

  // 2) 识别模板格式：含 Checklist/Exhibits 为新双语模板，否则回退旧模板
  let chosen: { wb: XLSX.WorkBook; isNew: boolean; base: string } | null = null;
  for (const f of xlsxFiles) {
    const bytes = await f.entry.async("nodebuffer");
    const wb = XLSX.read(bytes, { type: "buffer" });
    if (hasSheet(wb, "Checklist") || hasSheet(wb, "Exhibits")) { chosen = { wb, isNew: true, base: f.base }; break; }
    if (!chosen && hasSheet(wb, "course info") && hasSheet(wb, "Lessons")) chosen = { wb, isNew: false, base: f.base };
  }
  if (!chosen) throw new Error("Excel 模板结构无法识别：缺少 Course info / Lessons 工作表");

  if (chosen.isNew) return buildNewTemplatePackage(chosen.wb, media, options);
  return buildLegacyPackage(chosen.wb, media, options);
}

// ===== 新双语模板（Course_Content_Template_*.xlsx） =====

interface NewLessonRow {
  code: string;
  textEn: string;
  textZh: string;
  videoEn: string;
  videoZh: string;
  startEn: number | null;
  startZh: number | null;
}

interface NewLesson {
  no: number;
  id: string;
  titleEn: string;
  titleZh: string;
  descEn: string;
  descZh: string;
  points: NewLessonRow[];
}

function parseNewLessons(rows: unknown[][]): NewLesson[] {
  const out: NewLesson[] = [];
  let cur: NewLesson | null = null;
  for (const row of rows) {
    if (!row) continue;
    const first = cell(row[0]);
    if (first === "Lesson" && cell(row[1])) {
      const m = /(\d+)/.exec(cell(row[1]));
      cur = { no: m ? Number(m[1]) : out.length + 1, id: "", titleEn: "", titleZh: "", descEn: "", descZh: "", points: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (first === "Lesson ID") { cur.id = cell(row[1]).toUpperCase(); continue; }
    if (/^Lesson title \(EN\)/i.test(first)) { cur.titleEn = cell(row[1]); continue; }
    if (first.includes("Lesson title") && first.includes("中文")) { cur.titleZh = cell(row[1]); continue; }
    if (/^Lesson description \(EN\)/i.test(first)) { cur.descEn = cell(row[1]); continue; }
    if (first.includes("Lesson description") && first.includes("中文")) { cur.descZh = cell(row[1]); continue; }
    // 学习点表头：["#","Text mode title – EN", ...]
    if (first === "#" && cell(row[1]).toLowerCase().includes("text mode")) continue;
    if (/^\d+(\.\d+)?$/.test(first)) {
      cur.points.push({
        code: first,
        textEn: cell(row[1]),
        textZh: cell(row[2]),
        videoEn: cell(row[3]),
        videoZh: cell(row[4]),
        startEn: toSeconds(row[5]),
        startZh: toSeconds(row[6]),
      });
    }
  }
  if (!cur) return out;
  return out.filter((l) => l.titleEn || l.titleZh || l.points.length > 0);
}

function parseTriggerTimes(value: unknown): number[] {
  if (value === null || value === undefined || value === "") return [];
  if (typeof value === "number") { const s = toSeconds(value); return s === null ? [] : [s]; }
  return String(value)
    .split(/[,，]/)
    .map((part) => toSeconds(part))
    .filter((n): n is number => n !== null && Number.isFinite(n));
}

function mapExhibitType(value: string, fileName?: string): ExhibitType {
  const v = value.toLowerCase();
  if (v.includes("3d") || v.includes("model")) return "MODEL3D";
  if (v.includes("video")) return "VIDEO";
  if (v.includes("image") || v.includes("photo") || v.includes("picture")) return "IMAGE";
  if (fileName) {
    if (isVideoName(fileName)) return "VIDEO";
    if (isModelName(fileName)) return "MODEL3D";
  }
  return "IMAGE";
}

function mapReadingType(value: string): PackageReading["type"] {
  const v = value.toLowerCase();
  if (v.includes("book")) return "BOOK";
  if (v.includes("paper")) return "PAPER";
  return "ARTICLE";
}

interface ExhibitRow {
  lessonId: string;
  code: string;
  type: string;
  titleEn: string;
  titleZh: string;
  descEn: string;
  descZh: string;
  sourceEn: string;
  triggersEn: number[];
  triggersZh: number[];
}

function parseExhibitRows(rows: unknown[][]): ExhibitRow[] {
  const out: ExhibitRow[] = [];
  for (const row of rows) {
    if (!row) continue;
    const lessonId = cell(row[0]).toUpperCase();
    if (!/^L\d+/i.test(lessonId)) continue;
    const code = cell(row[2]).toUpperCase();
    if (!code) continue;
    out.push({
      lessonId,
      code,
      type: cell(row[3]),
      titleEn: cell(row[4]),
      titleZh: cell(row[5]),
      descEn: cell(row[6]),
      descZh: cell(row[7]),
      sourceEn: cell(row[8]),
      triggersEn: parseTriggerTimes(row[10]),
      triggersZh: parseTriggerTimes(row[11]),
    });
  }
  return out;
}

async function buildNewTemplatePackage(
  wb: XLSX.WorkBook,
  media: Map<string, Buffer>,
  options: { courseCode?: string; slug?: string },
): Promise<ExcelPackageResult> {
  const warnings: string[] = [];
  const pkg = createPackager();

  // Checklist：语言 / 学习模式 / 课程 ID
  const checklist = parseCourseInfo(sheetRows(wb, "Checklist"));
  const studyModeText = checklist.get("Study mode") || "";
  const learningMode = parseStudyMode(studyModeText);
  const languages = parseLanguages(checklist.get("Learning language") || "English");
  const defaultContentLanguage = languages[0] ?? LANG;
  if (learningMode === "VIDEO_AND_TEXT" || learningMode === "VIDEO_ONLY") {
    for (const lang of languages) {
      if (![...media.keys()].some((n) => isVideoName(n) && isZhName(n) === (lang === "zh-CN"))) {
        warnings.push(`学习模式含视频，但未找到 ${lang} 视频文件`);
      }
    }
  }

  // Course info
  const courseRows = sheetRows(wb, "Course info");
  const info: Record<string, { en: string; zh: string }> = {};
  const whatEn: string[] = [];
  const whatZh: string[] = [];
  const provideRows: { preset: string; en: string; zh: string }[] = [];
  let section: "" | "learn" | "provide" = "";
  for (const row of courseRows) {
    if (!row) continue;
    const first = cell(row[0]);
    const lower = first.toLowerCase();
    if (lower === "category" || lower === "course title" || lower === "short description" || lower === "overview") {
      info[lower] = { en: cell(row[1]), zh: cell(row[2]) };
      section = "";
      continue;
    }
    if (lower === "what you'll learn" || lower === "what you’ll learn") { section = "learn"; continue; }
    if (lower === "this course provides") { section = "provide"; continue; }
    if (first === "#") continue;
    if (section === "learn" && typeof row[0] === "number") { if (cell(row[1])) whatEn.push(cell(row[1])); if (cell(row[2])) whatZh.push(cell(row[2])); continue; }
    if (section === "provide" && typeof row[0] === "number") { provideRows.push({ preset: cell(row[1]), en: cell(row[2]), zh: cell(row[3]) }); continue; }
  }

  const titleEn = info["course title"]?.en || checklist.get("Course title") || "Imported Course";
  const titleZh = info["course title"]?.zh;
  const category = info["category"]?.en || "Uncategorised";
  const courseCode = (options.courseCode || checklist.get("Course ID") || "C001").trim().toUpperCase();
  const slug = (options.slug || slugify(titleEn)).trim().toLowerCase();

  // 封面
  const cover = findMedia(media, (n) => isImageName(n) && /课程封面|cover/.test(n));
  const coverPath = cover ? "media/cover" + extOf(cover.name) : undefined;
  if (cover) pkg.add(coverPath!, cover.bytes); else warnings.push("未找到课程封面图片");

  const buildProvides = (lang: string) => provideRows.map((p) => {
    const en = p.en || p.preset;
    const zh = p.zh;
    if (p.en || p.zh) return { type: "custom" as const, title: lang === "zh-CN" ? zh || en : en, titleZh: zh || undefined };
    return { type: "preset" as const, title: p.preset, titleZh: p.zh || undefined };
  });

  const courseLocalized: PackageCourse["localized"] = {};
  for (const lang of languages) {
    const isZh = lang === "zh-CN";
    const pick = (field: string) => (isZh ? info[field]?.zh || info[field]?.en : info[field]?.en) || undefined;
    courseLocalized[lang] = {
      title: (isZh ? titleZh || titleEn : titleEn).trim(),
      shortDescription: pick("short description"),
      overview: pick("overview"),
      whatYouLearn: isZh ? (whatZh.length ? whatZh : whatEn) : whatEn,
      provides: buildProvides(lang),
    };
    if (isZh && !titleZh) warnings.push("课程中文标题为空，已回退英文标题");
  }

  // 课时
  const lessonDefs = parseNewLessons(sheetRows(wb, "Lessons")).sort((a, b) => a.no - b.no);
  if (!lessonDefs.length) throw new Error("Lessons 工作表没有可导入的课时");
  const exhibitRows = parseExhibitRows(sheetRows(wb, "Exhibits"));
  const readingRows = sheetRows(wb, "Reading list");
  const knowledgeRows = sheetRows(wb, "Knowledge test");
  const applicationRows = sheetRows(wb, "Application test");

  const pkgLessons: PackageLesson[] = [];
  for (const def of lessonDefs) {
    const lessonId = def.id || `L${String(def.no).padStart(3, "0")}`;
    const localized: Record<string, PackageLesson["localized"][string]> = {};

    // 文本正文：优先同目录 docx
    const docx = findMedia(media, (n) => isDocxName(n) && lessonNameMatch(n, lessonId, def.no) && isZhName(n) === false);
    const html = docx ? await mdConverterDone(docx.bytes) : "";
    if (!docx) warnings.push(`Lesson ${def.no} 缺少文本课件 DOCX`);

    for (const lang of languages) {
      const isZh = lang === "zh-CN";
      const title = (isZh ? def.titleZh || def.titleEn : def.titleEn) || `Lesson ${def.no}`;
      if (isZh && !def.titleZh) warnings.push(`Lesson ${def.no} 中文标题为空，已回退英文标题`);

      const videoFile = findMedia(media, (n) => isVideoName(n) && lessonNameMatch(n, lessonId, def.no) && isZhName(n) === isZh);
      let video: PackageLesson["localized"][string]["video"] = null;
      if (videoFile) {
        const videoPath = `media/video/${lessonId}/${lang}${extOf(videoFile.name)}`;
        pkg.add(videoPath, videoFile.bytes);
        const duration = mp4DurationSeconds(videoFile.bytes);
        const videoLps: PackageVideoLearningPoint[] = defsVideoPoints(def.points, isZh)
          .map((p, i) => ({ code: `V-${p.code || i + 1}`, timeSeconds: p.start ?? 0, title: p.title }));
        video = { file: videoPath, durationSeconds: duration ? Math.round(duration) : undefined, learningPoints: videoLps, exhibitTriggers: [] };
      } else if (learningMode !== "TEXT_ONLY") {
        warnings.push(`Lesson ${def.no} 缺少 ${lang} 视频文件`);
      }

      const textLps: PackageTextLearningPoint[] = defsTextPoints(def.points, isZh)
        .map((p) => ({ code: `T-${p.code}`, heading: p.title, level: 1 }));

      localized[lang] = {
        title,
        description: (isZh ? def.descZh || def.descEn : def.descEn) || undefined,
        video,
        text: html ? { html, learningPoints: textLps } : null,
      };
    }

    // 展品
    const lessonExhibitRows = exhibitRows.filter((r) => r.lessonId === lessonId);
    const usedCodes = new Set<string>();
    const exhibits: PackageExhibit[] = [];
    for (const ex of lessonExhibitRows) {
      let code = ex.code;
      if (usedCodes.has(code)) { let n = 2; while (usedCodes.has(`${ex.code}-${n}`)) n++; code = `${ex.code}-${n}`; warnings.push(`Lesson ${def.no} 展品编号 ${ex.code} 重复，已改为 ${code}`); }
      usedCodes.add(code);
      const image = findMedia(media, (n) => (isImageName(n) || isVideoName(n) || isModelName(n)) && !/缩略图|thumb/.test(n) && baseStartsWith(n, ex.code));
      let file: string | undefined;
      if (image) { file = `media/exhibits/${code}${extOf(image.name)}`; pkg.add(file, image.bytes); }
      else warnings.push(`Lesson ${def.no} 展品「${ex.titleEn || ex.code}」缺少媒体文件`);
      const thumb = findMedia(media, (n) => isImageName(n) && /缩略图|thumb/.test(n) && baseStartsWith(n, ex.code));
      let thumbnail: string | undefined;
      if (thumb) { thumbnail = `media/exhibits/${code}.thumb${extOf(thumb.name)}`; pkg.add(thumbnail, thumb.bytes); }
      const localizedEx: PackageExhibit["localized"] = {};
      for (const lang of languages) {
        const isZh = lang === "zh-CN";
        localizedEx[lang] = { title: (isZh ? ex.titleZh || ex.titleEn : ex.titleEn) || code, description: (isZh ? ex.descZh || ex.descEn : ex.descEn) || undefined };
      }
      exhibits.push({ code, type: mapExhibitType(ex.type, image?.name), file, thumbnail, source: ex.sourceEn || undefined, localized: localizedEx });
      // 触发器按语言挂到对应 video 上
      for (const lang of languages) {
        const isZh = lang === "zh-CN";
        const times = isZh ? ex.triggersZh : ex.triggersEn;
        const loc = localized[lang];
        if (loc?.video && times.length) {
          loc.video.exhibitTriggers = loc.video.exhibitTriggers ?? [];
          for (const t of times) loc.video.exhibitTriggers.push({ timeSeconds: t, exhibitRef: code });
        }
      }
    }

    // 推荐阅读（英文）
    const readings: PackageReading[] = [];
    for (const row of readingRows) {
      if (!row) continue;
      if (cell(row[0]).toUpperCase() !== lessonId) continue;
      const title = cell(row[3]);
      if (!title) continue;
      readings.push({ type: mapReadingType(cell(row[2])), title, author: cell(row[4]) || undefined, why: cell(row[5]) || undefined });
    }

    // 知识测试 / 应用测试（数据库为单语，取英文，缺则中文）
    const questions: PackageKnowledgeQuestion[] = [];
    for (const row of knowledgeRows) {
      if (!row) continue;
      if (cell(row[0]).toUpperCase() !== lessonId) continue;
      const question = cell(row[3]) || cell(row[5]);
      if (!question) continue;
      questions.push({ code: `K-${def.no}-${questions.length + 1}`, question, referenceAnswer: cell(row[4]) || cell(row[6]) || undefined });
    }
    const appRow = applicationRows.find((row) => row && cell(row[0]).toUpperCase() === lessonId);
    const appTest = appRow
      ? { enabled: true, scenario: cell(appRow[2]) || cell(appRow[4]), referenceAnswer: cell(appRow[3]) || cell(appRow[5]) || undefined }
      : undefined;

    pkgLessons.push({
      code: lessonId,
      order: def.no,
      localized,
      exhibits,
      recommendedReading: readings.length ? { "en-GB": readings } : {},
      knowledgeTest: { enabled: questions.length > 0, questions },
      applicationTest: appTest && appTest.scenario ? appTest : undefined,
    });
  }

  const course: PackageCourse = {
    code: courseCode,
    slug,
    category,
    learningMode,
    learningLanguages: languages,
    defaultContentLanguage,
    cover: coverPath,
    localized: courseLocalized,
    lessons: pkgLessons,
    trial: { enabled: false, lessons: [] },
  };
  const manifest: PackageManifest = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    packageId: `raw-template-${randomUUID()}`,
    exportedAt: new Date().toISOString(),
    source: { environment: "EXCEL_TEMPLATE", courseCode },
    incomplete: warnings.length > 0,
    course,
  };
  pkg.out.file("manifest.json", JSON.stringify(manifest, null, 2));
  pkg.out.file("checksums.sha256", pkg.checksums.join("\n"));
  const bytes = await pkg.out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { bytes, courseCode, slug, title: titleEn, lessonCount: pkgLessons.length, mediaCount: pkg.checksums.length, warnings };
}

function defsVideoPoints(points: NewLessonRow[], isZh: boolean): { code: string; title: string; start: number | null }[] {
  const out: { code: string; title: string; start: number | null }[] = [];
  for (const p of points) {
    const title = isZh ? p.videoZh || p.videoEn : p.videoEn;
    if (!title) continue;
    out.push({ code: p.code, title, start: isZh ? p.startZh : p.startEn });
  }
  return out;
}

function defsTextPoints(points: NewLessonRow[], isZh: boolean): { code: string; title: string }[] {
  const out: { code: string; title: string }[] = [];
  for (const p of points) {
    const title = isZh ? p.textZh || p.textEn : p.textEn;
    if (!title) continue;
    out.push({ code: p.code, title });
  }
  return out;
}

function baseStartsWith(name: string, code: string): boolean {
  const base = (name.split("/").pop() ?? name).toLowerCase();
  return base.startsWith(code.toLowerCase());
}

function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? "." + m[1].toLowerCase() : ".bin";
}

function slugify(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return slug || `course-${Date.now().toString(36)}`;
}

/**
 * 旧模板（course info 表）里可选读取课程编号：兼容 "Course ID" / "课程 ID" /
 * "课程ID" / "课程编号" / "Course Code" 等写法（忽略大小写、空格、分隔符）。
 * 找不到或为空返回 undefined，交由调用方决定默认值。
 */
function readLegacyCourseId(info: Map<string, string>): string | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_\-:：/()（）]/g, "");
  const keys = new Set(["courseid", "coursecode", "课程id", "课程编号", "课程代码"]);
  for (const [k, v] of info.entries()) {
    if (!keys.has(norm(k))) continue;
    const val = String(v ?? "").trim();
    if (val) return val;
  }
  return undefined;
}

// ===== 旧模板（modeling life课程信息.xlsx，单语） =====

async function buildLegacyPackage(
  wb: XLSX.WorkBook,
  media: Map<string, Buffer>,
  options: { courseCode?: string; slug?: string },
): Promise<ExcelPackageResult> {
  const warnings: string[] = [];
  const requiredSheets = ["course info", "Lessons", "exploration-reading list", "knowledge test", "application test"];
  const missing = requiredSheets.filter((name) => !hasSheet(wb, name));
  if (missing.length) throw new Error(`Excel 缺少 Sheet：${missing.join(", ")}`);

  const pkg = createPackager();
  const info = parseCourseInfo(sheetRows(wb, "course info"));
  const title = info.get("课程标题") || "Imported Course";
  const category = info.get("课程分类") || "Uncategorised";
  const shortDescription = info.get("课程简述") || "";
  const overview = info.get("overview") || "";
  const whatYouLearn = numberedLines(info.get("what you'll learn") || "");
  const provides = numberedLines(info.get("This course provides") || "").map((s) => ({ type: "custom", title: s }));
  const lessons = parseLessons(sheetRows(wb, "Lessons"));
  if (!lessons.length) throw new Error("Lessons Sheet 中没有可导入的课时");
  const readings = parseReadings(sheetRows(wb, "exploration-reading list"));
  const knowledge = parseKnowledge(sheetRows(wb, "knowledge test"));
  const applications = parseApplications(sheetRows(wb, "application test"));
  const excelCode = readLegacyCourseId(info);
  const courseCode = (excelCode || options.courseCode || "C001").trim().toUpperCase();
  const slug = (options.slug || slugify(courseCode)).trim().toLowerCase();

  const cover = findMedia(media, (n) => n.includes("课程封面") && n.endsWith(".png"));
  const coverPath = cover ? "media/cover.png" : undefined;
  if (cover) pkg.add(coverPath!, cover.bytes); else warnings.push("未找到课程封面 PNG");

  const pkgLessons: PackageLesson[] = [];
  for (const lesson of lessons) {
    const code = `L${String(lesson.no).padStart(3, "0")}`;
    const docx = findMedia(media, (n) => n.includes(`lesson ${lesson.no}`) && n.includes("文本课件") && n.endsWith(".docx"))
      || findMedia(media, (n) => n.includes(`lesson ${lesson.no}`) && n.includes("文本") && n.endsWith(".docx"));
    const html = docx ? await mdConverterDone(docx.bytes) : "";
    if (!docx) warnings.push(`Lesson ${lesson.no} 缺少文本课件 DOCX`);
    const video = findMedia(media, (n) => n.includes(`lesson ${lesson.no}`) && n.includes("视频课件") && n.endsWith(".mp4"));
    let videoPath: string | undefined;
    let videoDuration: number | null = null;
    if (video) {
      videoPath = `media/video/${code}/en-GB.mp4`;
      pkg.add(videoPath, video.bytes);
      const d = mp4DurationSeconds(video.bytes);
      videoDuration = d ? Math.round(d) : null;
    } else warnings.push(`Lesson ${lesson.no} 缺少视频课件 MP4`);

    const exhibits: PackageExhibit[] = [];
    for (let i = 0; i < lesson.exhibits.length; i++) {
      const meta = lesson.exhibits[i];
      const no = i + 1;
      const image = findMedia(media, (n) => n.includes(`exhibit-${no}`) && n.endsWith(".png") && !n.includes("缩略图"));
      const thumb = findMedia(media, (n) => n.includes(`exhibit${no}`) && n.includes("缩略图") && n.endsWith(".png"));
      if (!image) { warnings.push(`Lesson ${lesson.no} 展品「${meta.title}」缺少图片，已跳过`); continue; }
      const exCode = `E${String(lesson.no).padStart(2, "0")}${String(no).padStart(2, "0")}`;
      const imagePath = `media/exhibits/${exCode}.png`;
      pkg.add(imagePath, image.bytes);
      let thumbnailPath: string | undefined;
      if (thumb) { thumbnailPath = `media/exhibits/${exCode}.thumb.png`; pkg.add(thumbnailPath, thumb.bytes); }
      exhibits.push({ code: exCode, type: "IMAGE", file: imagePath, thumbnail: thumbnailPath, localized: { [LANG]: { title: meta.title, description: meta.description || undefined } } });
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
    learningMode: "VIDEO_AND_TEXT",
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
    source: { environment: "EXCEL_IMPORT", courseCode },
    incomplete: warnings.length > 0,
    course,
  };
  pkg.out.file("manifest.json", JSON.stringify(manifest, null, 2));
  pkg.out.file("checksums.sha256", pkg.checksums.join("\n"));
  const bytes = await pkg.out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { bytes, courseCode, slug, title, lessonCount: pkgLessons.length, mediaCount: pkg.checksums.length, warnings };
}
