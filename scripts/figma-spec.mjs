/**
 * 把 Figma 节点树压成可读的规格表：几何、填充色、圆角、自动布局、字体。
 *
 * 用法：node scripts/figma-spec.mjs <nodeId> [--all]
 *   nodeId 形如 778:620；--all 时输出全部文本节点（默认只输出去重后的字号组合）
 */

import { readFileSync } from "node:fs";

const META = "D:/Program/First-Light-TechHK/LearningGuideAdmin/docs/design/674-1186.metadata.json";
const frameId = process.argv[2] ?? "778:620";
const showAllText = process.argv.includes("--all");

const raw = JSON.parse(readFileSync(META, "utf8"));
const canvas = raw.nodes["674:1186"].document;

function find(node, id) {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, id);
    if (hit) return hit;
  }
  return null;
}

const frame = find(canvas, frameId);
if (!frame) {
  console.error(`找不到节点 ${frameId}`);
  process.exit(1);
}

const hex = (c) =>
  c ? "#" + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("") : "";
const solid = (node) => {
  const fill = (node.fills ?? []).find((f) => f.type === "SOLID" && f.visible !== false);
  return fill ? hex(fill.color) : "";
};
const box = (node) => {
  const b = node.absoluteBoundingBox ?? {};
  return `${Math.round(b.x ?? 0)},${Math.round(b.y ?? 0)} ${Math.round(b.width ?? 0)}x${Math.round(b.height ?? 0)}`;
};
const radius = (node) => {
  if (node.cornerRadius) return Math.round(node.cornerRadius);
  if (Array.isArray(node.rectangleCornerRadii)) return node.rectangleCornerRadii.join("/");
  return "";
};
const layout = (node) => {
  if (!node.layoutMode || node.layoutMode === "NONE") return "";
  const pad = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft]
    .map((v) => (v == null ? "-" : Math.round(v)))
    .join(",");
  return `${node.layoutMode} pad[${pad}] gap=${node.itemSpacing ?? 0}`;
};

console.log(`\n画板 ${frame.name}  ${box(frame)}  背景 ${solid(frame) || "透明"}`);
console.log("─".repeat(120));

const lines = [];
function walk(node, depth) {
  const indent = "  ".repeat(depth);
  if (node.type === "TEXT") {
    const style = node.style ?? {};
    lines.push(
      `${indent}[T] ${box(node)} ${node.characters?.replace(/\s+/g, " ").slice(0, 46)} | ${Math.round(
        style.fontSize ?? 0
      )}px/${style.fontWeight ?? 400} ${hex(style.fills?.[0]?.color) || solid(node)}`
    );
  } else if (node.type === "FRAME" || node.type === "RECTANGLE" || node.type === "COMPONENT") {
    const bg = solid(node);
    const r = radius(node);
    const lay = layout(node);
    const b = node.absoluteBoundingBox ?? {};
    const area = (b.width ?? 0) * (b.height ?? 0);
    if (bg || r || lay || area > 20000) {
      lines.push(
        `${indent}[${node.type[0]}] ${box(node)} ${node.name.slice(0, 30)} | bg=${bg || "—"}${
          r ? " r=" + r : ""
        }${lay ? " " + lay : ""}`
      );
    }
  }
  for (const child of node.children ?? []) walk(child, depth + 1);
}

walk(frame, 1);
console.log(lines.join("\n"));

// 字号 / 字重 / 颜色 组合去重，便于反推排版标尺
const combo = new Map();
walk(frame, () => {});
function collect(node) {
  if (node.type === "TEXT") {
    const s = node.style ?? {};
    const key = `${Math.round(s.fontSize ?? 0)}px / ${s.fontWeight ?? 400} / ${
      hex(s.fills?.[0]?.color) || solid(node)
    }`;
    combo.set(key, (combo.get(key) ?? 0) + 1);
  }
  for (const child of node.children ?? []) collect(child);
}
collect(frame);
console.log("\n字号组合（出现次数）：");
[...combo.entries()]
  .sort((a, b) => parseInt(b[0]) - parseInt(a[0]))
  .forEach(([key, count]) => console.log(`  ${key}  ×${count}`));
