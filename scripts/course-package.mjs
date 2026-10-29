#!/usr/bin/env node
/**
 * 课程包 CLI（导入/导出），用于 SIT → UAT → PROD 的环境晋级与备份。
 * 见 docs/Course_Module_Import_Export_Design.md §5.8。
 *
 * 鉴权：员工会话难以在 CLI 复现，这里直接使用迁移专用令牌：
 *   - 请求头 `Authorization: Bearer <token>`，服务端需识别该 scope（P1a 暂复用员工会话/服务密钥，
 *     生产接入专用迁移令牌前，CLI 使用基本鉴权 + 反向代理或管理员会话 Cookie）。
 *
 * 用法：
 *   node scripts/course-package.mjs export --base https://admin-sit --token $T --course C001 --out a.zip
 *   node scripts/course-package.mjs import --base https://admin-uat --token $T --file a.zip --conflict CREATE_NEW_COURSE
 *   node scripts/course-package.mjs import --base ... --token $T --file a.zip --dry-run
 */

import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: 'string' },
    token: { type: 'string' },
    cookie: { type: 'string' },
    course: { type: 'string' },
    file: { type: 'string' },
    out: { type: 'string' },
    version: { type: 'string', default: 'working' },
    conflict: { type: 'string', default: 'CREATE_NEW_COURSE' },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

const command = positionals[0];

function usage() {
  console.log(`course-package CLI
  export --base URL --token T --course <courseId> [--version working|live|version:N] --out file.zip [--cookie "..."]
  import --base URL --token T --file file.zip [--conflict ABORT|CREATE_NEW_COURSE|NEW_VERSION] [--dry-run] [--cookie "..."]
`);
}

function headers() {
  const h = {};
  if (values.token) h.Authorization = `Bearer ${values.token}`;
  if (values.cookie) h.Cookie = values.cookie;
  return h;
}

const base = (values.base ?? '').replace(/\/+$/, '');

async function api(path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...headers(), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function doExport() {
  if (!values.course || !values.out) throw new Error('export requires --course and --out');
  const start = await api(`/api/backoffice/courses/${values.course}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: values.version }),
  });
  if (start.status >= 300) throw new Error(`export start failed: ${start.status} ${JSON.stringify(start.json)}`);
  const jobId = start.json?.data?.jobId;
  console.log('export job:', jobId);

  for (let i = 0; i < 120; i++) {
    await sleep(2000);
    const status = await api(`/api/backoffice/courses/export/${jobId}`);
    const s = status.json?.data?.status;
    console.log('  status:', s, status.json?.data?.progress);
    if (s === 'READY') {
      const res = await fetch(`${base}/api/backoffice/courses/export/${jobId}/download`, { headers: headers() });
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(values.out, buf);
      console.log('saved', values.out, buf.length, 'bytes');
      return;
    }
    if (s === 'FAILED') throw new Error(`export failed: ${JSON.stringify(status.json)}`);
  }
  throw new Error('export timed out');
}

async function doImport() {
  if (!values.file) throw new Error('import requires --file');
  const bytes = await readFile(values.file);
  const form = new FormData();
  form.append('file', new Blob([bytes]), values.file.split(/[/\\]/).pop() ?? 'course.zip');
  const up = await fetch(`${base}/api/backoffice/courses/import`, {
    method: 'POST',
    headers: headers(),
    body: form,
  });
  const upJson = await up.json();
  if (up.status >= 300) throw new Error(`import upload failed: ${up.status} ${JSON.stringify(upJson)}`);
  const jobId = upJson?.data?.jobId;
  const status = upJson?.data?.status;
  console.log('import job:', jobId, 'status:', status);
  const report = upJson?.data?.report;
  if (report) {
    for (const e of report.errors ?? []) console.log('  ERROR', e.code, e.message);
    for (const w of report.warnings ?? []) console.log('  WARN ', w.code, w.message);
  }
  if (values['dry-run']) {
    console.log('dry-run: not confirming.');
    return;
  }
  if (status === 'FAILED') throw new Error('import validation failed');

  const confirm = await api(`/api/backoffice/courses/import/${jobId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ onConflict: values.conflict, reassignCodes: false }),
  });
  if (confirm.status >= 300) throw new Error(`confirm failed: ${confirm.status} ${JSON.stringify(confirm.json)}`);
  console.log('imported course:', confirm.json?.data?.courseId);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (values.help || !command) return usage();
  if (!base) throw new Error('--base is required');
  if (command === 'export') return doExport();
  if (command === 'import') return doImport();
  usage();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
