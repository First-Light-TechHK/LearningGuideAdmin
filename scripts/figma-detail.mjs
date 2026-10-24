import { readFileSync } from "node:fs";

const raw = JSON.parse(
  readFileSync("D:/Program/First-Light-TechHK/LearningGuideAdmin/docs/design/674-1186.metadata.json", "utf8")
);
const canvas = raw.nodes["674:1186"].document;

const hex = (c) =>
  c ? "#" + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("") : "";
const solid = (n) => {
  const f = (n.fills ?? []).find((x) => x.type === "SOLID" && x.visible !== false);
  return f ? hex(f.color) : "";
};
const box = (n) => {
  const b = n.absoluteBoundingBox ?? {};
  return `${Math.round(b.width ?? 0)}x${Math.round(b.height ?? 0)}`;
};

function walk(node, visit, depth = 0) {
  visit(node, depth);
  for (const c of node.children ?? []) walk(c, visit, depth + 1);
}

// 1) 状态圆点：找画板里所有 ELLIPSE
console.log("=== ELLIPSE（状态点等）===");
const frames = canvas.children.filter((n) => n.type === "FRAME" && n.name.includes("Employee Account") && !n.name.includes("Edit"));
for (const f of frames) {
  walk(f, (n) => {
    if (n.type === "ELLIPSE" || /ellipse|dot/i.test(n.name)) {
      console.log(`  ${f.name.slice(0, 32)} | ${n.type} ${n.name.slice(0, 24)} ${box(n)} bg=${solid(n) || hex(n.fills?.[0]?.color)}`);
    }
  });
}

// 2) 分页器结构
console.log("\n=== 分页器 ===");
for (const f of frames) {
  walk(f, (n) => {
    if (n.name === "pagination") {
      const dump = (node, d) => {
        console.log(
          `${"  ".repeat(d)}${node.type} ${node.name.slice(0, 26)} ${box(node)} bg=${solid(node) || "—"}${
            node.cornerRadius ? " r=" + Math.round(node.cornerRadius) : ""
          }${node.characters ? " « " + node.characters + " » " + (node.style?.fontSize ?? "") + "px/" + (node.style?.fontWeight ?? "") : ""}`
        );
        for (const c of node.children ?? []) dump(c, d + 1);
      };
      dump(n, 0);
    }
  });
}

// 3) 操作列 ⋮ 按钮
console.log("\n=== 操作列（Actions） ===");
const ea = frames[0];
walk(ea, (n) => {
  if (n.name === "row-1") {
    const last = (n.children ?? [])[n.children.length - 1];
    const dump = (node, d) => {
      console.log(
        `${"  ".repeat(d)}${node.type} ${node.name.slice(0, 24)} ${box(node)} ${node.cornerRadius ? "r=" + Math.round(node.cornerRadius) : ""} bg=${solid(node) || "—"}`
      );
      for (const c of node.children ?? []) dump(c, d + 1);
    };
    dump(last, 0);
  }
});
