/**
 * 从 Figma REST API 导出 PRD 相关画板的 PNG，供逐像素比对使用。
 *
 * 令牌来源（按优先级）：
 *   1. 环境变量 FIGMA_TOKEN
 *   2. 仓库根目录的 .figma-token 文件（已 gitignore）
 *
 * 用法：node scripts/figma-export.mjs [nodeId]
 *   nodeId 默认 674:1186（BackOffice PRD 画布）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE_KEY = "sxro3x6YXENJvjhGExmlQ7";
const CANVAS_ID = process.argv[2] ?? "674:1186";
const OUT_DIR = join(ROOT, "docs", "design", "figma");

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
const canvas = nodesPayload.nodes[CANVAS_ID].document;
const frames = (canvas.children ?? []).filter((node) => node.type === "FRAME");

writeFileSync(
  join(ROOT, "docs", "design", `${CANVAS_ID.replace(":", "-")}.metadata.json`),
  JSON.stringify({ version: nodesPayload.version, nodes: nodesPayload.nodes }),
  "utf8"
);

console.log(`画布 ${canvas.name}：${frames.length} 个画板`);

// 2) 批量导出 PNG（scale=1 即设计稿原始尺寸）
const ids = frames.map((frame) => frame.id).join(",");
const images = await api(
  `/v1/images/${FILE_KEY}?ids=${encodeURIComponent(ids)}&format=png&scale=1`
);

if (images.err) console.error("部分画板导出失败:", images.err);

// 3) 下载落盘
const rows = [];
for (const frame of frames) {
  const url = images.images?.[frame.id];
  if (!url) {
    rows.push([frame.name, frame.id, "无导出链接", "-"]);
    continue;
  }
  const png = Buffer.from(await (await fetch(url)).arrayBuffer());
  const name = `${slug(frame.name, frame.id)}.png`;
  writeFileSync(join(OUT_DIR, name), png);
  rows.push([frame.name, frame.id, name, `${Math.round(png.length / 1024)} KB`]);
}

console.log("\n画板 | nodeId | 文件 | 大小");
for (const row of rows) console.log(row.join(" | "));
console.log(`\n输出目录：${OUT_DIR}`);
