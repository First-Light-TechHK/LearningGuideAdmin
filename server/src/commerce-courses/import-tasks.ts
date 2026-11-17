import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CommerceCourseConfig } from './commerce.config';
import { buildPackageFromRawZip } from './excel-package';
import { PackageInspector } from './package-inspector';

/**
 * 导入阶段的两项 CPU 重活：原始素材转换（raw）与课程包解压校验（inspect）。
 * 放在没有副作用的模块里：生产环境由 import-worker.ts 在 worker 线程里调用，
 * 没有编译产物时（ts-jest / ts-node）heavy-tasks.ts 直接在本进程调用同一函数。
 */
export type ImportTaskName = 'raw' | 'inspect';

export async function runRaw(payload: Record<string, unknown>) {
  const rawPath = String(payload.rawPath);
  const outPath = String(payload.outPath);
  const buf = await fs.readFile(rawPath);
  const courseCode =
    typeof payload.courseCode === 'string' ? payload.courseCode : undefined;
  const slug = typeof payload.slug === 'string' ? payload.slug : undefined;
  const built = await buildPackageFromRawZip(buf, { courseCode, slug });
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

export async function runInspect(payload: Record<string, unknown>) {
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

export function runImportTask(
  task: ImportTaskName,
  payload: Record<string, unknown>,
) {
  return task === 'raw' ? runRaw(payload) : runInspect(payload);
}
