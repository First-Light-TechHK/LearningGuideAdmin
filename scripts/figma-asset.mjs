/** 下载登录页背景图（Figma 图片填充），用法：node scripts/figma-asset.mjs "<节点名>" */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = "D:/Program/First-Light-TechHK/LearningGuideAdmin";
const FILE_KEY = "sxro3x6YXENJvjhGExmlQ7";
const target = process.argv[2] ?? "Background Image";
const outPath = process.argv[3] ?? `${ROOT}/backoffice/public/portal/auth-library.jpg`;

function token() {
  if (process.env.FIGMA_TOKEN) return process.env.FIGMA_TOKEN.trim();
  const file = `${ROOT}/.figma-token`;
  if (existsSync(file)) {
    return readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#"));
  }
  throw new Error("缺少令牌");
}

const raw = JSON.parse(readFileSync(`${ROOT}/docs/design/674-1186.metadata.json`, "utf8"));
const canvas = raw.nodes["674:1186"].document;

let hit = null;
(function walk(node) {
  if (hit) return;
  if (node.name?.startsWith(target) && (node.fills ?? []).some((f) => f.type === "IMAGE")) hit = node;
  for (const c of node.children ?? []) walk(c);
})(canvas);

if (!hit) {
  console.error(`没找到含图片填充的节点：${target}`);
  process.exit(1);
}
const fill = hit.fills.find((f) => f.type === "IMAGE");
console.log(`节点 ${hit.id} «${hit.name}» imageRef=${fill.imageRef} scaleMode=${fill.scaleMode}`);

const res = await fetch(`https://api.figma.com/v1/files/${FILE_KEY}/images`, {
  headers: { "X-Figma-Token": token() },
});
if (!res.ok) {
  console.error("获取图片清单失败", res.status, (await res.text()).slice(0, 300));
  process.exit(1);
}
const { meta } = await res.json();
const url = meta?.images?.[fill.imageRef];
if (!url) {
  console.error("清单里没有该 imageRef");
  process.exit(1);
}

const bin = Buffer.from(await (await fetch(url)).arrayBuffer());
writeFileSync(outPath, bin);
console.log(`已保存 ${outPath}  ${Math.round(bin.length / 1024)} KB`);
