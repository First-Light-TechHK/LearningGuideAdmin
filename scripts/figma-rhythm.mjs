/** 打印某画板内某个容器的子节点垂直节奏，便于核对间距。用法：node scripts/figma-rhythm.mjs <frameId> <containerName> */
import { readFileSync } from "node:fs";

const ROOT = "D:/Program/First-Light-TechHK/LearningGuideAdmin";
const raw = JSON.parse(readFileSync(`${ROOT}/docs/design/674-1186.metadata.json`, "utf8"));
const canvas = raw.nodes["674:1186"].document;
const [frameId, containerName] = process.argv.slice(2);

function find(node, pred) {
  if (pred(node)) return node;
  for (const c of node.children ?? []) {
    const hit = find(c, pred);
    if (hit) return hit;
  }
  return null;
}

const frame = find(canvas, (n) => n.id === frameId);
if (!frame) throw new Error(`找不到画板 ${frameId}`);

const container = find(frame, (n) => n.name === containerName && n.type === "FRAME");
if (!container) throw new Error(`画板内找不到容器 ${containerName}`);

const b = container.absoluteBoundingBox;
console.log(`${containerName} @${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`);
console.log("layout:", container.layoutMode, "pad:", [container.paddingTop, container.paddingRight, container.paddingBottom, container.paddingLeft].join(","), "gap:", container.itemSpacing);

let cursorY = b.y;
for (const child of container.children ?? []) {
  const cb = child.absoluteBoundingBox;
  const gap = Math.round(cb.y - cursorY);
  cursorY = cb.y + cb.height;
  console.log(
    `  ${String(Math.round(cb.y)).padStart(6)} h=${String(Math.round(cb.height)).padStart(4)} w=${String(Math.round(cb.width)).padStart(5)} gap↑${String(gap).padStart(4)}  ${child.type[0]} ${child.name.slice(0, 28)}`
  );
}
