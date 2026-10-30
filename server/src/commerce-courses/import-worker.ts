import { parentPort, workerData } from 'node:worker_threads';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildPackageFromRawZip } from './excel-package';
import { PackageInspector } from './package-inspector';
import type { CommerceCourseConfig } from './commerce.config';

interface WorkerInput {
  task: 'raw' | 'inspect';
  payload: Record<string, unknown>;
}

async function runRaw(payload: Record<string, unknown>) {
  const rawPath = String(payload.rawPath);
  const outPath = String(payload.outPath);
  const buf = await fs.readFile(rawPath);
  const built = await buildPackageFromRawZip(buf);
  await fs.writeFile(outPath, built.bytes);
  return {
    warnings: built.warnings,
    courseCode: built.courseCode,
    slug: built.slug,
    title: built.title,
    lessonCount: built.lessonCount,
    mediaCount: built.mediaCount,
  };
}

async function runInspect(payload: Record<string, unknown>) {
  const packagePath = String(payload.packagePath);
  const outDir = String(payload.outDir);
  const config = payload.config as CommerceCourseConfig;
  const buf = await fs.readFile(packagePath);
  // inspector 仅用 config + 静态 sha256，不需要真实 storage 实例
  const inspector = new PackageInspector(config, {} as unknown as never);
  const { manifest, files, report } = await inspector.inspect(buf);
  const persisted: string[] = [];
  for (const [name, bytes] of files) {
    if (name === 'manifest.json' || name === 'checksums.sha256') continue;
    const target = path.join(outDir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    persisted.push(name);
  }
  return { manifest, report, files: persisted };
}

async function main() {
  const input = workerData as WorkerInput;
  try {
    const result =
      input.task === 'raw'
        ? await runRaw(input.payload)
        : await runInspect(input.payload);
    parentPort?.postMessage({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    parentPort?.postMessage({ ok: false, error: message });
  }
}

void main();
