/**
 * 抓取已登录后台页面的 SSR HTML，内联 CSS，落到 docs/design/figma/preview/ 供本地比对查看。
 * 仅用于设计走查，不参与构建。
 *
 * 用法：node scripts/figma-preview.mjs /zh-CN/settings/employee-account
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = "http://localhost:3200";
const ROUTE = process.argv[2] ?? "/zh-CN/settings/employee-account";
const ROOT = "D:/Program/First-Light-TechHK/LearningGuideAdmin";
const OUT_DIR = join(ROOT, "docs", "design", "figma", "preview");

const env = {};
for (const line of readFileSync(join(ROOT, "backoffice", ".env.local"), "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const i = trimmed.indexOf("=");
  if (i > 0) env[trimmed.slice(0, i).trim()] = trimmed.slice(i + 1).trim();
}

const signIn = await fetch(`${BASE}/api/auth/sign-in`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD }),
});
if (!signIn.ok) {
  console.error("登录失败", signIn.status);
  process.exit(1);
}
const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

let html = await (
  await fetch(`${BASE}${ROUTE}`, { headers: { cookie }, signal: AbortSignal.timeout(90_000) })
).text();

// 内联样式表
const hrefs = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => m[1]);
let css = "";
for (const href of hrefs) {
  const res = await fetch(`${BASE}${href}`);
  css += (await res.text()) + "\n";
}

// 去掉脚本与预加载，保留纯静态结构
html = html
  .replace(/<script[\s\S]*?<\/script>/g, "")
  .replace(/<link[^>]+as="script"[^>]*>/g, "")
  .replace(/<\/head>/, `<style>\n${css}\n</style></head>`);

mkdirSync(OUT_DIR, { recursive: true });
const name = `${ROUTE.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "")}.html`;
writeFileSync(join(OUT_DIR, name), html, "utf8");

console.log(`已生成 docs/design/figma/preview/${name}（内联 ${hrefs.length} 个样式表，${Math.round(css.length / 1024)} KB CSS）`);
