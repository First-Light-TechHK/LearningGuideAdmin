import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CourseStorageService } from './storage.service';
import { COMMERCE_CONFIG, type CommerceCourseConfig } from './commerce.config';
import { PackageInspector, PackageError } from './package-inspector';
import { PackageImporter, ImportError } from './package-importer';
import type {
  PackageManifest,
  PackageValidationReport,
} from './contracts/manifest';
import { runImportWorker } from './heavy-tasks';
import { PricingService } from './pricing.service';
import { PublishingService } from './publishing.service';

export interface JobReport {
  errors: PackageValidationReport['errors'];
  warnings: PackageValidationReport['warnings'];
}

export interface JobView {
  jobId: string;
  kind: string;
  status: string;
  stage: string | null;
  progress: number;
  error: string | null;
  courseId: string | null;
  sourceVersionId: string | null;
  fileLabel: string | null;
  package: {
    packageId: string;
    courseCode: string;
    slug: string;
    lessons: number;
    mediaFiles: number;
    incomplete: boolean;
  } | null;
  conflicts: unknown;
  report: JobReport;
}

/**
 * 课程包导入/导出作业（DB 队列 + FOR UPDATE SKIP LOCKED，见设计文档 §20）。
 * 上传 → 校验 → AWAITING_CONFIRM → 确认导入；导出 → READY → 下载。
 */
@Injectable()
export class PackageJobsService {
  private readonly logger = new Logger(PackageJobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: CourseStorageService,
    private readonly inspector: PackageInspector,
    private readonly importer: PackageImporter,
    private readonly pricing: PricingService,
    private readonly publishing: PublishingService,
    @Inject(COMMERCE_CONFIG) private readonly config: CommerceCourseConfig,
  ) {}

  // ===== 导入 =====
  async createImportJob(
    file: { name: string; bytes: Buffer },
    actorEmployeeId: string | null,
    idempotencyKey?: string,
    targetCourseId?: string,
  ) {
    if (idempotencyKey) {
      const existing = await this.prisma.coursePackageJob.findUnique({
        where: { idempotencyKey },
      });
      if (existing) return this.getJob(existing.id);
    }
    if (file.bytes.length > this.config.packageDirectUploadBytes) {
      throw new PackageError(
        'PACKAGE_TOO_LARGE',
        413,
        'Package too large for direct upload; use chunked upload.',
      );
    }
    const jobId = randomUUID();
    const storageKey = this.storage.stagingKey(jobId, 'package.zip');
    await this.storage.putStaging(storageKey, file.bytes);
    await this.prisma.coursePackageJob.create({
      data: {
        id: jobId,
        kind: 'IMPORT',
        status: 'VALIDATING',
        actorEmployeeId,
        courseId: targetCourseId ?? null,
        idempotencyKey: idempotencyKey ?? null,
        sourceFileName: file.name,
        bytesTotal: file.bytes.length,
        bytesReceived: file.bytes.length,
        packageHash: CourseStorageService.sha256(file.bytes),
        storageKey,
        progress: 10,
      },
    });
    // 同步校验（P1a：包通常较小；大包改由 worker 处理）
    await this.runValidation(jobId);
    return this.getJob(jobId);
  }

  /**
   * 原始素材导入：上传含 xlsx + 媒体（docx/mp4/png）的 ZIP，
   * 先转换成标准课程包，再走常规「导入作业 → 校验 → 确认导入」流程。
   */
  async createRawImportJob(
    file: { name: string; bytes: Buffer },
    actorEmployeeId: string | null,
    idempotencyKey?: string,
  ) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-raw-'));
    try {
      const rawPath = path.join(tmp, 'raw.zip');
      const outPath = path.join(tmp, 'package.zip');
      await fs.writeFile(rawPath, file.bytes);
      let built: {
        warnings: string[];
        courseCode: string;
        slug: string;
        title: string;
        lessonCount: number;
        mediaCount: number;
      };
      try {
        // 原始素材转换是 CPU 重活，放到 worker 线程，避免阻塞事件循环
        built = await runImportWorker<typeof built>('raw', {
          rawPath,
          outPath,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : '原始素材解析失败';
        throw new PackageError('RAW_MATERIALS_INVALID', 422, message);
      }
      const pkgBytes = await fs.readFile(outPath);
      const job = await this.createImportJob(
        { name: `${built.courseCode}.lgcourse.zip`, bytes: pkgBytes },
        actorEmployeeId,
        idempotencyKey,
      );
      return {
        ...job,
        sourceFileName: file.name,
        rawWarnings: built.warnings,
        raw: {
          courseCode: built.courseCode,
          slug: built.slug,
          title: built.title,
          lessonCount: built.lessonCount,
          mediaCount: built.mediaCount,
        },
      };
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * 本地目录导入：服务端直接读取仓库内素材目录（如 docs/modeling-life），
   * 打包为原始素材 ZIP 后走原始素材导入流程。用于规避浏览器上传超大文件中断。
   */
  async createLocalRawImportJob(
    options: { dir?: string; courseCode?: string; slug?: string },
    actorEmployeeId: string | null,
  ) {
    const rel = (options.dir || 'docs/modeling-life').trim();
    const repoRoot = path.resolve(process.cwd(), '..');
    const base = path.resolve(repoRoot, rel);
    if (base !== repoRoot && !base.startsWith(repoRoot + path.sep)) {
      throw new PackageError(
        'RAW_DIR_INVALID',
        400,
        'Directory is outside the repository.',
      );
    }
    let names: string[];
    try {
      names = await fs.readdir(base);
    } catch {
      throw new PackageError(
        'RAW_DIR_NOT_FOUND',
        404,
        `Directory not found: ${rel}`,
      );
    }
    const zip = new JSZip();
    for (const name of names) {
      if (name.startsWith('.') || name.startsWith('~$')) continue;
      const full = path.join(base, name);
      const stat = await fs.stat(full);
      if (!stat.isFile()) continue;
      zip.file(name, await fs.readFile(full));
    }
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    return this.createRawImportJob(
      { name: `${path.basename(base)}.zip`, bytes },
      actorEmployeeId,
    );
  }

  private async runValidation(jobId: string): Promise<void> {
    const job = await this.prisma.coursePackageJob.findUnique({
      where: { id: jobId },
    });
    if (!job || !job.storageKey) return;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-ins-'));
    try {
      const zipBytes = await this.storage.getStaging(job.storageKey);
      const packagePath = path.join(tmp, 'package.zip');
      const outDir = path.join(tmp, 'files');
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(packagePath, zipBytes);
      // 解压 + 全面校验是 CPU 重活，放到 worker 线程，避免阻塞事件循环
      const result = await runImportWorker<{
        manifest: PackageManifest;
        report: PackageValidationReport;
        files: string[];
      }>('inspect', { packagePath, outDir, config: this.config });
      await this.prisma.coursePackageJob.update({
        where: { id: jobId },
        data: {
          status:
            result.report.errors.length > 0 ? 'FAILED' : 'AWAITING_CONFIRM',
          stage: 'VALIDATED',
          progress: 100,
          manifest: result.manifest as unknown as Prisma.InputJsonValue,
          report: {
            errors: result.report.errors,
            warnings: result.report.warnings,
          } as unknown as Prisma.InputJsonValue,
          error:
            result.report.errors.length > 0
              ? result.report.errors[0].message
              : null,
        },
      });
      // 暂存解压内容到 staging（媒体二进制 + manifest）
      await this.persistExtractedFromDir(
        jobId,
        outDir,
        result.files,
        result.manifest,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Validation failed';
      await this.prisma.coursePackageJob.update({
        where: { id: jobId },
        data: { status: 'FAILED', error: message, progress: 100 },
      });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async persistExtractedFromDir(
    jobId: string,
    outDir: string,
    names: string[],
    manifest: PackageManifest,
  ): Promise<void> {
    for (const name of names) {
      const bytes = await fs.readFile(path.join(outDir, name));
      await this.storage.putStaging(
        this.storage.stagingKey(jobId, name),
        bytes,
      );
    }
    await this.storage.putStaging(
      this.storage.stagingKey(jobId, '__manifest.json'),
      Buffer.from(JSON.stringify(manifest)),
    );
  }

  async confirmImport(
    jobId: string,
    body: {
      onConflict: 'ABORT' | 'CREATE_NEW_COURSE' | 'NEW_VERSION';
      reassignCodes?: boolean;
    },
    actorEmployeeId: string | null,
  ) {
    const job = await this.prisma.coursePackageJob.findUnique({
      where: { id: jobId },
    });
    if (!job)
      throw new PackageError('PACKAGE_JOB_NOT_FOUND', 404, 'Job not found.');
    if (job.status !== 'AWAITING_CONFIRM') {
      throw new PackageError(
        'PACKAGE_JOB_NOT_FOUND',
        409,
        `Job not awaiting confirm (status=${job.status}).`,
      );
    }
    await this.prisma.coursePackageJob.update({
      where: { id: jobId },
      data: { status: 'IMPORTING', progress: 0 },
    });
    try {
      const manifestBytes = await this.storage.getStaging(
        this.storage.stagingKey(jobId, '__manifest.json'),
      );
      const manifest = JSON.parse(
        manifestBytes.toString('utf8'),
      ) as PackageManifest;
      const files = await this.loadStagingFiles(jobId, manifest);
      const { courseId } = job.courseId
        ? await this.importer.importIntoExistingCourse(
            job.courseId,
            manifest,
            files,
            actorEmployeeId,
          )
        : await this.importer.importPackage(manifest, files, {
            onConflict: body.onConflict,
            reassignCodes: body.reassignCodes ?? false,
            actorEmployeeId,
          });
      await this.prisma.coursePackageJob.update({
        where: { id: jobId },
        data: { status: 'READY', progress: 100, courseId, stage: 'COMMITTED' },
      });
      await this.storage.clearStagingPrefix(jobId);
      // 导入完成后在目标环境重新创建 Stripe 产品/价格（失败不阻断导入）
      const plans = await this.prisma.coursePlan.findMany({
        where: { courseId, active: true },
        select: { id: true },
      });
      await Promise.all(
        plans.map((plan) =>
          this.pricing.syncPlan(courseId, plan.id).catch(() => undefined),
        ),
      );
      return { jobId, status: 'READY', courseId };
    } catch (error) {
      const code = error instanceof ImportError ? error.code : 'INTERNAL_ERROR';
      const status = error instanceof ImportError ? error.status : 500;
      const message = error instanceof Error ? error.message : 'Import failed';
      await this.prisma.coursePackageJob.update({
        where: { id: jobId },
        data: { status: 'FAILED', error: message },
      });
      throw new PackageError(code, status, message);
    }
  }

  private async loadStagingFiles(
    jobId: string,
    manifest: PackageManifest,
  ): Promise<Map<string, Buffer>> {
    const files = new Map<string, Buffer>();
    const collect = (rel: string | undefined) => {
      if (rel) files.set(rel, Buffer.alloc(0));
    };
    if (manifest.course.cover) collect(manifest.course.cover);
    for (const lesson of manifest.course.lessons ?? []) {
      for (const loc of Object.values(lesson.localized ?? {}))
        collect(loc.video?.file);
      for (const ex of lesson.exhibits ?? []) {
        collect(ex.file);
        collect(ex.thumbnail);
      }
    }
    for (const rel of [...files.keys()]) {
      try {
        const bytes = await this.storage.getStaging(
          this.storage.stagingKey(jobId, rel),
        );
        files.set(rel, bytes);
      } catch {
        // 缺失由导入阶段报 PACKAGE_MEDIA_INVALID
      }
    }
    return files;
  }

  async cancelJob(jobId: string) {
    const job = await this.prisma.coursePackageJob.findUnique({
      where: { id: jobId },
    });
    if (!job)
      throw new PackageError('PACKAGE_JOB_NOT_FOUND', 404, 'Job not found.');
    if (job.status === 'READY' || job.status === 'IMPORTING') {
      throw new PackageError(
        'PACKAGE_JOB_NOT_FOUND',
        409,
        'Job cannot be cancelled.',
      );
    }
    await this.prisma.coursePackageJob.update({
      where: { id: jobId },
      data: { status: 'CANCELLED', cancelRequested: true },
    });
    await this.storage.clearStagingPrefix(jobId);
    return { jobId, status: 'CANCELLED' };
  }

  async getJob(jobId: string): Promise<JobView> {
    const job = await this.prisma.coursePackageJob.findUnique({
      where: { id: jobId },
    });
    if (!job)
      throw new PackageError('PACKAGE_JOB_NOT_FOUND', 404, 'Job not found.');
    const manifest = job.manifest as PackageManifest | null;
    const report = job.report as JobReport | null;
    return {
      jobId: job.id,
      kind: job.kind,
      status: job.status,
      stage: job.stage,
      progress: job.progress ?? 0,
      error: job.error,
      courseId: job.courseId,
      sourceVersionId: job.sourceVersionId,
      fileLabel: job.fileLabel,
      package: manifest
        ? {
            packageId: manifest.packageId,
            courseCode: manifest.course.code,
            slug: manifest.course.slug,
            lessons: manifest.course.lessons?.length ?? 0,
            mediaFiles: this.countMedia(manifest),
            incomplete: manifest.incomplete,
          }
        : null,
      conflicts: job.conflicts,
      report: report ?? { errors: [], warnings: [] },
    };
  }

  private countMedia(manifest: PackageManifest): number {
    let n = manifest.course.cover ? 1 : 0;
    for (const lesson of manifest.course.lessons ?? []) {
      for (const loc of Object.values(lesson.localized ?? {}))
        if (loc.video?.file) n++;
      for (const ex of lesson.exhibits ?? [])
        n += (ex.file ? 1 : 0) + (ex.thumbnail ? 1 : 0);
    }
    return n;
  }

  async listJobs(actorEmployeeId: string | null) {
    return this.prisma.coursePackageJob.findMany({
      where: actorEmployeeId ? { actorEmployeeId } : {},
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        kind: true,
        status: true,
        progress: true,
        sourceFileName: true,
        courseId: true,
        error: true,
        createdAt: true,
      },
    });
  }

  // ===== 导出（只导出线上版本，PRD §16）=====
  async startExport(courseId: string, actorEmployeeId: string | null) {
    const exportable = await this.publishing.assertExportable(courseId);
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: { code: true },
    });
    const fileLabel = `${course?.code ?? 'course'}_${exportable.versionLabel}.zip`;
    const jobId = randomUUID();
    await this.prisma.coursePackageJob.create({
      data: {
        id: jobId,
        kind: 'EXPORT',
        status: 'EXPORTING',
        courseId,
        actorEmployeeId,
        sourceVersionId: exportable.versionId,
        fileLabel,
        progress: 0,
      },
    });
    return {
      jobId,
      status: 'EXPORTING',
      versionId: exportable.versionId,
      versionLabel: exportable.versionLabel,
      fileName: fileLabel,
    };
  }
}
