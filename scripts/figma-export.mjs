/**
 * 从 Figma REST API 导出画布下所有一级画板的 PNG，供逐像素比对使用。
 *
 * 令牌来源（按优先级）：
 *   1. 环境变量 FIGMA_TOKEN
 *   2. 仓库根目录的 .figma-token 文件（已 gitignore）
 *
 * 用法：
 *   node scripts/figma-export.mjs [nodeId]
 *   node scripts/figma-export.mjs --file <fileKey> --node <nodeId> --out <dir>
 *
 * 默认导出 674:1186（BackOffice PRD 画布）到 docs/design/figma。
 * 例：课程管理设计稿
 *   node scripts/figma-export.mjs --file Z6GJpeiHIsRJYVPQvfsgTz --node 0:1 \
 *     --out docs/design/figma/course-management
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FILE_KEY = "sxro3x6YXENJvjhGExmlQ7";
const DEFAULT_CANVAS_ID = "674:1186";

function parseArgs(argv) {
  const options = { fileKey: DEFAULT_FILE_KEY, nodeId: DEFAULT_CANVAS_ID, outDir: null };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") options.fileKey = argv[++i];
    else if (arg === "--node") options.nodeId = argv[++i];
    else if (arg === "--out") options.outDir = argv[++i];
    else rest.push(arg);
  }
  if (!options.outDir && rest.length > 0) options.nodeId = rest[0];
  return options;
}

const options = parseArgs(process.argv.slice(2));
const FILE_KEY = options.fileKey;
const CANVAS_ID = options.nodeId;
const OUT_DIR = options.outDir
  ? (isAbsolute(options.outDir) ? options.outDir : resolve(ROOT, options.outDir))
  : join(ROOT, "docs", "design", "figma");

function token() {
  if (process.env.FIGMA_TOKEN) return process.env.FIGMA_TOKEN.trim();
  const file = join(ROOT, ".figma-token");
  if (existsSync(file)) {
    // 允许文件里写注释行；取第一条非注释、非空行作为令牌
    const value = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "" && !line.startsWith("#"));
    if (value) return value;
  }
  console.error("缺少 Figma 令牌：请设置 FIGMA_TOKEN 或写入 .figma-token");
  process.exit(1);
}

const TOKEN = token();

async function api(path) {
  const response = await fetch(`https://api.figma.com${path}`, {
    headers: { "X-Figma-Token": TOKEN },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    console.error(`Figma API ${path} -> HTTP ${response.status}`);
    console.error((await response.text()).slice(0, 400));
    process.exit(1);
  }
  return response.json();
}

function slug(name, id) {
  const ascii = name
    .replace(/[^\w\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
  return `${ascii || "frame"}-${id.replace(":", "-")}`;
}

mkdirSync(OUT_DIR, { recursive: true });

// 1) 刷新节点树（同时用于取画板 id）
const nodesPayload = await api(`/v1/files/${FILE_KEY}/nodes?ids=${encodeURIComponent(CANVAS_ID)}`);
const node = nodesPayload.nodes?.[CANVAS_ID];
if (!node?.document) {
  console.error(`找不到节点 ${CANVAS_ID}`);
  process.exit(1);
}
const canvas = node.document;
const frames = (canvas.children ?? []).filter((child) => child.type === "FRAME");

const metadata = { fileKey: FILE_KEY, version: nodesPayload.version, nodes: nodesPayload.nodes };
if (OUT_DIR === join(ROOT, "docs", "design", "figma")) {
  writeFileSync(
    join(ROOT, "docs", "design", `${CANVAS_ID.replace(":", "-")}.metadata.json`),
    JSON.stringify(metadata),
    "utf8"
  );
} else {
  writeFileSync(join(OUT_DIR, `${CANVAS_ID.replace(":", "-")}.metadata.json`), JSON.stringify(metadata), "utf8");
}

console.log(`画布 ${canvas.name}：${frames.length} 个画板`);

// 2) 批量导出 PNG（scale=1 即设计稿原始尺寸），分批避免单次请求过大
const BATCH_SIZE = 20;
const imageUrls = {};
for (let i = 0; i < frames.length; i += BATCH_SIZE) {
  const batch = frames.slice(i, i + BATCH_SIZE);
  const ids = batch.map((frame) => frame.id).join(",");
  const images = await api(`/v1/images/${FILE_KEY}?ids=${encodeURIComponent(ids)}&format=png&scale=1`);
  if (images.err) console.error("部分画板导出失败:", images.err);
  Object.assign(imageUrls, images.images ?? {});
}

// 3) 下载落盘
const rows = [];
const manifest = [];
for (const frame of frames) {
  const url = imageUrls[frame.id];
  const box = frame.absoluteBoundingBox ?? {};
  if (!url) {
    rows.push([frame.name, frame.id, "无导出链接", "-"]);
    manifest.push({ name: frame.name, nodeId: frame.id, file: null, width: box.width, height: box.height });
    continue;
  }
  const png = Buffer.from(await (await fetch(url)).arrayBuffer());
  const name = `${slug(frame.name, frame.id)}.png`;
  writeFileSync(join(OUT_DIR, name), png);
  rows.push([frame.name, frame.id, name, `${Math.round(png.length / 1024)} KB`]);
  manifest.push({
    name: frame.name,
    nodeId: frame.id,
    file: name,
    width: box.width,
    height: box.height,
    bytes: png.length,
  });
}

writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

console.log("\n画板 | nodeId | 文件 | 大小");
for (const row of rows) console.log(row.join(" | "));
console.log(`\n输出目录：${OUT_DIR}`);
