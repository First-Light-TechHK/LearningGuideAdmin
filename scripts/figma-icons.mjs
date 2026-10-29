/**
 * 从 Figma REST API 抓取「course management」画布的矢量图标，重建为独立 SVG。
 *
 * 设计稿文件：Z6GJpeiHIsRJYVPQvfsgTz / 画布 Page 1（0:1）
 * 输出目录：docs/design/figma/course-management/icons/
 *
 * 原理：一次性请求 GET /v1/files/:key/nodes?ids=0:1&geometry=paths 拿到整页节点树
 * （含每个矢量节点的 fillGeometry / strokeGeometry 路径），再按「几何签名」去重、
 * 把每个图标容器的可见矢量节点按颜色 + 相对位移重建为 SVG。路径与设计稿逐字节一致。
 *
 * 令牌来源（按优先级）：环境变量 FIGMA_TOKEN → 仓库根 .figma-token。
 * 注意图 rates：images 接口限流很紧（低配额令牌），本脚本只用 nodes 接口一次请求。
 *
 * 用法：node scripts/figma-icons.mjs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE_KEY = "Z6GJpeiHIsRJYVPQvfsgTz";
const CANVAS_ID = "0:1";
const OUT_DIR = join(ROOT, "docs", "design", "figma", "course-management", "icons");
const CACHE = join(ROOT, "docs", "design", "figma", "course-management", "0-1.geometry.json");

const CONTAINER = new Set(["FRAME", "GROUP", "INSTANCE", "COMPONENT"]);
const SHAPE = new Set(["VECTOR", "BOOLEAN_OPERATION", "ELLIPSE", "STAR", "REGULAR_POLYGON", "LINE"]);
const NEUTRAL = new Set(["#000000", "#111827", "#1f2937", "#374151", "#4b5563", "#6b7280", "#9ca3af", "#d1d5db", "#c0c4cc", "#64748b", "#94a3b8"]);

function token() {
  if (process.env.FIGMA_TOKEN) return process.env.FIGMA_TOKEN.trim();
  const file = join(ROOT, ".figma-token");
  if (existsSync(file)) {
    const value = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "" && !line.startsWith("#"));
    if (value) return value;
  }
  console.error("缺少 Figma 令牌：请设置 FIGMA_TOKEN 或写入 .figma-token");
  process.exit(1);
}

async function fetchGeometry() {
  if (existsSync(CACHE)) {
    console.log(`使用缓存 ${CACHE}（删除后可重新拉取）`);
    return JSON.parse(readFileSync(CACHE, "utf8"));
  }
  const response = await fetch(
    `https://api.figma.com/v1/files/${FILE_KEY}/nodes?ids=${encodeURIComponent(CANVAS_ID)}&geometry=paths`,
    { headers: { "X-Figma-Token": token() }, signal: AbortSignal.timeout(300_000) }
  );
  if (!response.ok) {
    console.error(`Figma API -> HTTP ${response.status}`);
    console.error((await response.text()).slice(0, 300));
    process.exit(1);
  }
  const text = await response.text();
  writeFileSync(CACHE, text, "utf8");
  console.log(`已缓存节点树 ${CACHE}`);
  return JSON.parse(text);
}

const round = (value) => Math.round((value ?? 0) * 100);
const hex = (color) =>
  color ? `#${[color.r, color.g, color.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}` : null;

function markVisible(node) {
  let hasText = node.type === "TEXT";
  let hasShape = SHAPE.has(node.type);
  for (const child of node.children ?? []) {
    const result = markVisible(child);
    hasText ||= result.hasText;
    hasShape ||= result.hasShape;
  }
  node.__hasText = hasText;
  node.__hasShape = hasShape;
  return { hasText, hasShape };
}

function shapeAttributes(root, colorSet) {
  const rb = root.absoluteBoundingBox;
  const parts = [];
  function visit(node, isRoot) {
    if (!isRoot && node.visible === false) return;
    const b = node.absoluteBoundingBox;
    if (b && b.width > 0 && b.height > 0) {
      const fills = (node.fills ?? []).filter((f) => f.visible !== false && f.type === "SOLID" && f.color);
      const strokes = (node.strokes ?? []).filter((s) => s.visible !== false && s.type === "SOLID" && s.color);
      const tx = round(b.x - rb.x);
      const ty = round(b.y - rb.y);
      if (fills.length && node.fillGeometry?.length) {
        colorSet?.add(hex(fills[fills.length - 1].color));
        for (const g of node.fillGeometry) parts.push(`F|${tx},${ty}|${g.path}`);
      }
      if (strokes.length && node.strokeGeometry?.length) {
        colorSet?.add(hex(strokes[strokes.length - 1].color));
        for (const g of node.strokeGeometry) parts.push(`S|${tx},${ty}|${g.path}`);
      }
    }
    for (const child of node.children ?? []) visit(child, false);
  }
  visit(root, true);
  return parts.join("~");
}

function collectPaths(root, useCurrentColor) {
  const rb = root.absoluteBoundingBox;
  const elements = [];
  function visit(node, isRoot) {
    if (!isRoot && node.visible === false) return;
    const b = node.absoluteBoundingBox;
    if (b && b.width > 0 && b.height > 0) {
      const fills = (node.fills ?? []).filter((f) => f.visible !== false && f.type === "SOLID" && f.color);
      const strokes = (node.strokes ?? []).filter((s) => s.visible !== false && s.type === "SOLID" && s.color);
      const paint = (p) => {
        const c = hex(p.color);
        return useCurrentColor && NEUTRAL.has(c) ? "currentColor" : c;
      };
      const tx = b.x - rb.x;
      const ty = b.y - rb.y;
      if (fills.length && node.fillGeometry?.length) {
        const p = fills[fills.length - 1];
        for (const g of node.fillGeometry) elements.push({ d: g.path, color: paint(p), opacity: p.opacity ?? 1, x: tx, y: ty, winding: g.windingRule });
      }
      if (strokes.length && node.strokeGeometry?.length) {
        const p = strokes[strokes.length - 1];
        for (const g of node.strokeGeometry) elements.push({ d: g.path, color: paint(p), opacity: p.opacity ?? 1, x: tx, y: ty, winding: g.windingRule });
      }
    }
    for (const child of node.children ?? []) visit(child, false);
  }
  visit(root, true);
  return elements;
}

const geometry = await fetchGeometry();
const page = geometry.nodes[CANVAS_ID].document;
markVisible(page);

const byId = new Map();
function index(node) {
  byId.set(node.id, node);
  for (const child of node.children ?? []) index(child);
}
for (const frame of page.children ?? []) if (frame.type === "FRAME") index(frame);

// 按「忽略颜色的几何签名」去重，保留一份代表节点
const groups = new Map();
function walk(node, parent, topFrame) {
  const box = node.absoluteBoundingBox;
  const w = Math.round(node.size?.x ?? box?.width ?? 0);
  const h = Math.round(node.size?.y ?? box?.height ?? 0);
  if (
    CONTAINER.has(node.type) && w > 0 && h > 0 && w <= 72 && h <= 72 &&
    !node.__hasText && node.__hasShape && (node.name ?? "") !== "Vector"
  ) {
    const colors = new Set();
    const sig = shapeAttributes(node, colors);
    if (sig) {
      const key = `${w}x${h}|${createHash("sha1").update(sig).digest("hex").slice(0, 16)}`;
      if (!groups.has(key)) groups.set(key, { key, w, h, name: node.name, parent: parent?.name, ids: [], colors: new Set(), frames: new Set() });
      const group = groups.get(key);
      group.ids.push(node.id);
      if (topFrame?.name) group.frames.add(topFrame.name);
      for (const c of colors) if (c) group.colors.add(c);
    }
  }
  for (const child of node.children ?? []) walk(child, node, topFrame);
}
for (const frame of page.children ?? []) if (frame.type === "FRAME") walk(frame, page, frame);

// 名称表：优先复用已存在 manifest.json 中按 nodeId 记录的名称，保证重跑名称稳定
const NAME_BY_NODE = loadNameByNode();

mkdirSync(OUT_DIR, { recursive: true });
const manifest = [];
const usedNames = new Set();
for (const group of groups.values()) {
  const existing = group.ids.map((id) => NAME_BY_NODE[id]).find(Boolean);
  const baseName = existing ?? `icon-${group.ids[0].replace(/[:;]/g, "-")}`;
  let name = baseName;
  let suffix = 2;
  while (usedNames.has(name)) name = `${baseName}-${suffix++}`;
  usedNames.add(name);

  const node = byId.get(group.ids[0]);
  if (!node) continue;
  const useCurrentColor = group.colors.size === 1;
  const elements = collectPaths(node, useCurrentColor);
  if (elements.length === 0) continue;

  const paths = elements
    .map((e) => {
      const rule = (e.winding ?? "NONZERO").toUpperCase() === "EVENODD" ? "evenodd" : "nonzero";
      const opacity = e.opacity != null && e.opacity !== 1 ? ` opacity="${e.opacity}"` : "";
      return `  <path transform="translate(${e.x.toFixed(2)} ${e.y.toFixed(2)})" d="${e.d}" fill="${e.color}" fill-rule="${rule}"${opacity}/>`;
    })
    .join("\n");
  const svg = `<svg width="${group.w}" height="${group.h}" viewBox="0 0 ${group.w} ${group.h}" fill="none" xmlns="http://www.w3.org/2000/svg">\n${paths}\n</svg>\n`;
  writeFileSync(join(OUT_DIR, `${name}.svg`), svg, "utf8");

  manifest.push({
    file: `${name}.svg`,
    name,
    nodeId: group.ids[0],
    allNodeIds: group.ids,
    width: group.w,
    height: group.h,
    figmaName: group.name,
    parent: group.parent,
    colors: [...group.colors],
    themeable: useCurrentColor,
    usedIn: [...group.frames].sort(),
  });
}
manifest.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
console.log(`已导出 ${manifest.length} 个图标 -> ${OUT_DIR}`);

function loadNameByNode() {
  const manifestFile = join(OUT_DIR, "manifest.json");
  const map = {};
  if (existsSync(manifestFile)) {
    try {
      for (const entry of JSON.parse(readFileSync(manifestFile, "utf8"))) {
        for (const id of entry.allNodeIds ?? [entry.nodeId]) map[id] = entry.name;
      }
    } catch {
      /* ignore */
    }
  }
  return map;
}
