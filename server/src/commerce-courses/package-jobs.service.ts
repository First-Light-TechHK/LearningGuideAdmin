import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { appEnvName } from '../backoffice/lib/env';
import { tryRecordAuditEvent } from '../backoffice/repositories/auditRepository';
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

/** Postgres INTEGER 的上限；CoursePackageJob.bytesTotal 是 Int 列。 */
const JOB_BYTE_TOTAL_MAX = 2_147_483_647;
/** 超过 Int 上限的声明体积存在 requestId（本子系统此前未使用该列），读取时还原。 */
const RAW_BYTES_TOTAL_MARKER = 'raw-bytes-total:';

/**
 * staging 存储（S3 桶 / 本地盘）不可用时给操作员看的文案。
 * 具体是桶不存在、无权限、凭证或网络问题由服务器日志里的原始错误栈定位；
 * 响应体不泄露桶名、端点或 SDK 细节。
 */
export const STORAGE_UNAVAILABLE_MESSAGE =
  '课程存储不可用，请联系运维检查课程存储桶与实例角色权限';

/** 人类可读的字节数：8 GB / 200 MB / 512 KB。 */
export function formatBytes(bytes: number): string {
  const GB = 1024 * 1024 * 1024;
  const MB = 1024 * 1024;
  const KB = 1024;
  if (bytes >= GB) return `${Number((bytes / GB).toFixed(2))} GB`;
  if (bytes >= MB) return `${Number((bytes / MB).toFixed(2))} MB`;
  if (bytes >= KB) return `${Number((bytes / KB).toFixed(2))} KB`;
  return `${bytes} B`;
}

/**
 * 把声明的总字节数写进 Int 列：≤ Int 上限直接存；更大的值把 Int 列封顶，
 * 真实值以 `raw-bytes-total:<n>` 记在 requestId（用于 4 GiB–8 GiB 的大包会话，
 * 避免 Prisma Int 溢出把用户请求变成 500）。
 */
export function encodeJobByteTotal(total: number): {
  bytesTotal: number;
  requestId: string | null;
} {
  if (total <= JOB_BYTE_TOTAL_MAX) {
    return { bytesTotal: total, requestId: null };
  }
  return {
    bytesTotal: JOB_BYTE_TOTAL_MAX,
    requestId: `${RAW_BYTES_TOTAL_MARKER}${total}`,
  };
}

function jobDeclaredBytes(job: {
  bytesTotal: number | null;
  requestId?: string | null;
}): number {
  const marker = job.requestId;
  if (typeof marker === 'string' && marker.startsWith(RAW_BYTES_TOTAL_MARKER)) {
    const parsed = Number(marker.slice(RAW_BYTES_TOTAL_MARKER.length));
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return job.bytesTotal ?? 0;
}

/**
 * 导出选择器（PRD §16.2，owner 2026-11-18 裁决以 PRD 为准）：
 * 产品导出路径只允许当前线上版本 —— 草稿、指定版本号/标签、versionId、sourceVersion
 * 等选择器一律 400 VALIDATION_ERROR，不提供任何非线上导出。
 */
export type ExportVersionSelector = { kind: 'live' };

const EXPORT_ONLY_LIVE_MESSAGE =
  'Only the current live version can be exported. Draft and specific-version selectors are not supported.';

/**
 * 导出请求体的类型校验：version / versionId / sourceVersion 只要出现就必须是字符串。
 * 否则（例如 version: 1）parseExportSelector 会把它当成未提供而默认导出 live —— 静默改变语义。
 */
export function assertExportSelectorBody(
  body:
    | { version?: unknown; versionId?: unknown; sourceVersion?: unknown }
    | null
    | undefined,
): void {
  for (const field of ['version', 'versionId', 'sourceVersion'] as const) {
    const value = body?.[field];
    if (value !== undefined && typeof value !== 'string') {
      throw new PackageError(
        'VALIDATION_ERROR',
        400,
        `${field} must be a string.`,
      );
    }
  }
}

export function parseExportSelector(
  body:
    | { version?: unknown; versionId?: unknown; sourceVersion?: unknown }
    | null
    | undefined,
): ExportVersionSelector {
  const asString = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : '';
  // 旧字段一律拒绝（含 sourceVersion: 'live'）：产品导出不接受任何显式版本选择。
  if (asString(body?.versionId) || asString(body?.sourceVersion)) {
    throw new PackageError('VALIDATION_ERROR', 400, EXPORT_ONLY_LIVE_MESSAGE);
  }
  const raw = asString(body?.version);
  if (!raw || raw.toLowerCase() === 'live') return { kind: 'live' };
  throw new PackageError('VALIDATION_ERROR', 400, EXPORT_ONLY_LIVE_MESSAGE);
}

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
  /**
   * 等待确认阶段预先判定的 Course ID 冲突（仅「从包新建」的导入作业）：
   * 便于前端在点「导入课程」之前就提示「覆盖草稿 / 已上线拒绝」。
   */
  conflict: {
    existingCourseCode: string;
    existingCourseId: string;
    live: boolean;
  } | null;
  report: JobReport;
}

/**
 * 课程包导�?导出作业（DB 队列 + FOR UPDATE SKIP LOCKED，见设计文档 §20）�?
 * 上传 �?校验 �?AWAITING_CONFIRM �?确认导入；导�?�?READY �?下载�?
 */
@Injectable()
export class PackageJobsService {
  private readonly logger = new Logger(PackageJobsService.name);
  // 分块上传单块大小：远小于边缘（CloudFront/App Runner）的单请求限制，保证每块都快速完整传�?
  private static readonly RAW_CHUNK_BYTES = 5 * 1024 * 1024;
  // 允许分块比约定略大一点点的容差（避免末端对齐误差导致误判�?
  private static readonly RAW_CHUNK_SLACK_BYTES = 1024;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: CourseStorageService,
    private readonly inspector: PackageInspector,
    private readonly importer: PackageImporter,
    private readonly pricing: PricingService,
    private readonly publishing: PublishingService,
    @Inject(COMMERCE_CONFIG) private readonly config: CommerceCourseConfig,
  ) {}

  // ===== 原始素材分块上传的公共小工具 =====

  /** 分块�?staging 中的键（�?index 块）�?*/
  private rawChunkKey(jobId: string, index: number): string {
    return this.storage.stagingKey(jobId, `rawchunk/${index}`);
  }

  /** 按总字节数推算应有的分块数量（至少 1 块）�?*/
  private chunkCountFor(bytesTotal: number): number {
    return Math.max(
      1,
      Math.ceil(bytesTotal / PackageJobsService.RAW_CHUNK_BYTES),
    );
  }

  /** 读取一个仍处于上传中的作业；不存在 �?404，状态不�?�?409�?*/
  private async requireUploadingJob(
    jobId: string,
    stage: 'UPLOADING' | 'UPLOADING_PACKAGE' = 'UPLOADING',
  ) {
    const job = await this.prisma.coursePackageJob.findUnique({
      where: { id: jobId },
    });
    if (!job)
      throw new PackageError('PACKAGE_JOB_NOT_FOUND', 404, 'Job not found.');
    if (job.stage !== stage) {
      throw new PackageError(
        'RAW_UPLOAD_NOT_ACTIVE',
        409,
        'Upload is not in progress for this job.',
      );
    }
    return job;
  }

  /** 幂等键命中则返回既有作业，否�?null�?*/
  private findJobByIdempotencyKey(idempotencyKey?: string) {
    if (!idempotencyKey) return Promise.resolve(null);
    return this.prisma.coursePackageJob.findUnique({
      where: { idempotencyKey },
    });
  }

  /** 生成未被占用的兜底课程编号：TEMP001、TEMP002…（基于现有 TEMP* 课程自增）。 */
  private async nextTempCourseCode(): Promise<string> {
    const rows = await this.prisma.commerceCourse.findMany({
      where: { code: { startsWith: 'TEMP' } },
      select: { code: true },
    });
    let max = 0;
    for (const { code } of rows) {
      const m = /^TEMP(\d+)$/i.exec(code);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `TEMP${String(max + 1).padStart(3, '0')}`;
  }

  /** 只读诊断：确认当前存储驱动（S3 或本地）。 */
  storageInfo() {
    return this.storage.describe();
  }

  /**
   * staging 存储是导入同步链路唯一的共享外部依赖。驱动/SDK 抛出的原始错误
   * 不是 HttpException，若不转换会被全局过滤器兜底成 500「服务器内部错误」。
   * 这里统一映射为 503 STORAGE_UNAVAILABLE（操作员可读），原始错误（含堆栈）
   * 只写服务器日志，供运维定位桶/角色/网络问题。
   */
  private storageUnavailable(
    error: unknown,
    operation: string,
    key: string,
  ): PackageError {
    this.logger.error(
      `Course staging storage ${operation} failed for ${key}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error instanceof Error ? error.stack : undefined,
    );
    return new PackageError(
      'STORAGE_UNAVAILABLE',
      HttpStatus.SERVICE_UNAVAILABLE,
      STORAGE_UNAVAILABLE_MESSAGE,
    );
  }

  private async writeStaging(key: string, bytes: Buffer): Promise<void> {
    try {
      await this.storage.putStaging(key, bytes);
    } catch (error) {
      throw this.storageUnavailable(error, 'put', key);
    }
  }

  private async stagingExists(key: string): Promise<boolean> {
    try {
      return await this.storage.hasStaging(key);
    } catch (error) {
      throw this.storageUnavailable(error, 'probe', key);
    }
  }

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
        'VALIDATION_ERROR',
        400,
        `Package exceeds the direct upload limit (${formatBytes(
          this.config.packageDirectUploadBytes,
        )}); use the chunked upload instead.`,
      );
    }
    const jobId = randomUUID();
    const storageKey = this.storage.stagingKey(jobId, 'package.zip');
    await this.writeStaging(storageKey, file.bytes);
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
    // 同步校验（P1a：包通常较小；大包改�?worker 处理�?
    await this.runValidation(jobId, file.bytes);
    return this.getJob(jobId);
  }

  /**
   * 原始素材导入：上传含 xlsx + 媒体（docx/mp4/png）的 ZIP�?
   * 先转换成标准课程包，再走常规「导入作�?�?校验 �?确认导入」流程�?
   *
   * 转换 + 校验是耗时�?CPU/内存重活：这里只把原始包落盘、建作业就立即返回，
   * 真正的处理放到后台线程执行，前端轮询 import/:jobId。避�?~150MB 素材�?
   * 在网关（CloudFront / App Runner）上因请求超时直�?5xx�?
   */
  async createRawImportJob(
    file: { name: string; bytes: Buffer },
    actorEmployeeId: string | null,
    idempotencyKey?: string,
  ) {
    const existing = await this.findJobByIdempotencyKey(idempotencyKey);
    if (existing) return this.getJob(existing.id);
    if (file.bytes.length > this.config.packageMaxBytes) {
      throw new PackageError(
        'VALIDATION_ERROR',
        400,
        `Raw materials archive exceeds the package size limit (${formatBytes(
          this.config.packageMaxBytes,
        )}).`,
      );
    }
    const jobId = randomUUID();
    const rawKey = this.storage.stagingKey(jobId, 'raw.zip');
    await this.writeStaging(rawKey, file.bytes);
    const encodedTotal = encodeJobByteTotal(file.bytes.length);
    await this.prisma.coursePackageJob.create({
      data: {
        id: jobId,
        kind: 'IMPORT',
        status: 'VALIDATING',
        stage: 'RAW_QUEUED',
        actorEmployeeId,
        idempotencyKey: idempotencyKey ?? null,
        sourceFileName: file.name,
        bytesTotal: encodedTotal.bytesTotal,
        requestId: encodedTotal.requestId,
        bytesReceived: Math.min(JOB_BYTE_TOTAL_MAX, file.bytes.length),
        progress: 5,
      },
    });
    // 后台转换 + 校验（不阻塞上传请求）；结果写回同一�?jobId，由前端轮询�?
    void this.processRawImport(jobId, rawKey).catch(() => undefined);
    return this.getJob(jobId);
  }

  /** 后台把原始素材包转成课程包并校验，复用同一�?jobId，供前端轮询�?*/
  private async processRawImport(jobId: string, rawKey: string): Promise<void> {
    try {
      const rawBytes = await this.storage.getStaging(rawKey);
      await this.runRawProcessing(jobId, rawBytes);
    } catch (error) {
      await this.markRawFailed(jobId, error);
    } finally {
      await this.storage.removeStaging(rawKey).catch(() => undefined);
    }
  }

  /** 把原始素�?ZIP 的字节转成课程包并校验（转换/校验都在 worker 线程里做）�?*/
  private async runRawProcessing(
    jobId: string,
    rawBytes: Buffer,
  ): Promise<void> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-raw-'));
    try {
      const rawPath = path.join(tmp, 'raw.zip');
      const outPath = path.join(tmp, 'package.zip');
      await fs.writeFile(rawPath, rawBytes);
      // 旧模板若没有 Course ID 字段，用一个不重复的 TEMP 编号兜底（TEMP001、TEMP002…）；
      // 若 Excel 里带了 Course ID，worker 会优先用它，忽略这里传入的兜底值。
      const fallbackCode = await this.nextTempCourseCode();
      const built = await runImportWorker<{
        warnings: string[];
        courseCode: string;
        slug: string;
        title: string;
        lessonCount: number;
        mediaCount: number;
      }>('raw', { rawPath, outPath, courseCode: fallbackCode });
      const pkgBytes = await fs.readFile(outPath);
      const pkgKey = this.storage.stagingKey(jobId, 'package.zip');
      await this.storage.putStaging(pkgKey, pkgBytes);
      await this.prisma.coursePackageJob.update({
        where: { id: jobId },
        data: {
          storageKey: pkgKey,
          bytesTotal: pkgBytes.length,
          // 原始分块上传结束后清掉大体积标记（真实包大小已写回 bytesTotal）
          requestId: null,
          packageHash: CourseStorageService.sha256(pkgBytes),
          sourceFileName: `${built.courseCode}.lgcourse.zip`,
          progress: 40,
          stage: 'VALIDATING',
        },
      });
      await this.runValidation(jobId, pkgBytes);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async markRawFailed(jobId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : '原始素材解析失败';
    await this.prisma.coursePackageJob
      .update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          error: message,
          progress: 100,
          stage: 'FAILED',
        },
      })
      .catch(() => undefined);
  }

  /**
   * 分块上传会话：大素材包（�?150MB+）单�?POST 会被 CloudFront/App Runner
   * 的回源限制中途切断。这里改成前端分块、逐块上传，每块都是小请求�?
   * 这里只建作业，返�?jobId 与建议块大小�?
   */
  async createRawUploadSession(
    file: { name: string; bytesTotal: number },
    actorEmployeeId: string | null,
    idempotencyKey?: string,
  ) {
    const existing = await this.findJobByIdempotencyKey(idempotencyKey);
    if (existing)
      return {
        jobId: existing.id,
        chunkSize: PackageJobsService.RAW_CHUNK_BYTES,
      };
    if (!Number.isSafeInteger(file.bytesTotal) || file.bytesTotal <= 0) {
      throw new PackageError(
        'INVALID_INPUT',
        400,
        'bytesTotal must be a positive integer for a chunked upload.',
      );
    }
    // 创建会话时就按扩展名白名单预校验，避免 raw.exe/7z 白传完到 complete 才失败。
    if (!/\.zip$/i.test((file.name ?? '').trim())) {
      throw new PackageError(
        'PACKAGE_INVALID_ZIP',
        400,
        'Raw course materials must be uploaded as a .zip archive.',
      );
    }
    if (file.bytesTotal > this.config.packageMaxBytes) {
      throw new PackageError(
        'VALIDATION_ERROR',
        400,
        `Raw materials archive exceeds the package size limit (${formatBytes(
          this.config.packageMaxBytes,
        )}).`,
      );
    }
    const jobId = randomUUID();
    const encodedTotal = encodeJobByteTotal(file.bytesTotal);
    await this.prisma.coursePackageJob.create({
      data: {
        id: jobId,
        kind: 'IMPORT',
        status: 'VALIDATING',
        stage: 'UPLOADING',
        actorEmployeeId,
        idempotencyKey: idempotencyKey ?? null,
        sourceFileName: file.name,
        bytesTotal: encodedTotal.bytesTotal,
        requestId: encodedTotal.requestId,
        bytesReceived: 0,
        progress: 0,
      },
    });
    return { jobId, chunkSize: PackageJobsService.RAW_CHUNK_BYTES };
  }

  /** 写入单个分块�?staging，更新进度。每块很小，走的是普通小请求�?*/
  async appendRawChunk(
    jobId: string,
    index: number,
    bytes: Buffer,
  ): Promise<{ jobId: string; progress: number }> {
    const job = await this.requireUploadingJob(jobId);
    if (!Number.isInteger(index) || index < 0) {
      throw new PackageError('INVALID_INPUT', 400, 'Invalid chunk index.');
    }
    if (
      bytes.length >
      PackageJobsService.RAW_CHUNK_BYTES +
        PackageJobsService.RAW_CHUNK_SLACK_BYTES
    ) {
      throw new PackageError(
        'VALIDATION_ERROR',
        400,
        `Chunk exceeds the agreed chunk size (${formatBytes(
          PackageJobsService.RAW_CHUNK_BYTES,
        )}).`,
      );
    }
    await this.writeStaging(this.rawChunkKey(jobId, index), bytes);
    const total = jobDeclaredBytes(job);
    const expected = this.chunkCountFor(total);
    const progress = Math.min(85, Math.round(((index + 1) / expected) * 85));
    await this.prisma.coursePackageJob.update({
      where: { id: jobId },
      data: {
        // Int 列封顶：4 GiB+ 的声明体积不会溢出（真实总量在 requestId 里）
        bytesReceived: Math.min(
          JOB_BYTE_TOTAL_MAX,
          Math.round((total * (index + 1)) / expected),
        ),
        progress,
      },
    });
    return { jobId, progress };
  }

  /** 全部分块到达后：合并为原始素材包，后台转�?+ 校验�?*/
  async completeRawUpload(jobId: string): Promise<JobView> {
    const job = await this.requireUploadingJob(jobId);
    const total = jobDeclaredBytes(job);
    if (!total) {
      throw new PackageError('INVALID_INPUT', 400, 'Missing upload size.');
    }
    const count = this.chunkCountFor(total);
    for (let i = 0; i < count; i++) {
      const present = await this.stagingExists(this.rawChunkKey(jobId, i));
      if (!present) {
        throw new PackageError(
          'RAW_UPLOAD_INCOMPLETE',
          400,
          `Missing chunk ${i + 1}/${count}.`,
        );
      }
    }
    await this.prisma.coursePackageJob.update({
      where: { id: jobId },
      data: { stage: 'RAW_QUEUED', progress: 88 },
    });
    void this.assembleAndProcessRaw(jobId, count).catch(() => undefined);
    return this.getJob(jobId);
  }

  private async assembleAndProcessRaw(
    jobId: string,
    count: number,
  ): Promise<void> {
    try {
      const parts: Buffer[] = [];
      for (let i = 0; i < count; i++) {
        parts.push(await this.storage.getStaging(this.rawChunkKey(jobId, i)));
      }
      const rawBytes = Buffer.concat(parts);
      await this.runRawProcessing(jobId, rawBytes);
    } catch (error) {
      await this.markRawFailed(jobId, error);
    } finally {
      for (let i = 0; i < count; i++) {
        await this.storage
          .removeStaging(this.rawChunkKey(jobId, i))
          .catch(() => undefined);
      }
    }
  }

  /**
   * 本地目录导入：服务端直接读取仓库内素材目录（�?docs/modeling-life），
   * 打包为原始素�?ZIP 后走原始素材导入流程。用于规避浏览器上传超大文件中断�?
   */
  // ===== 课程包分块上传（> 200 MB 的 .lgcourse.zip）=====
  // 与原始素材分块共用块大小与 staging 键，但 complete 后不做 Excel 转换，直接校验课程包。
  // 直传上限（PACKAGE_DIRECT_UPLOAD_BYTES，默认 200 MB）只约束单次 POST；分块通道可到 PACKAGE_MAX_BYTES。

  /** 建分块会话：只落作业与声明体积，包体随后逐块上传。 */
  async createPackageUploadSession(
    file: { name: string; bytesTotal: number },
    actorEmployeeId: string | null,
    idempotencyKey?: string,
    targetCourseId?: string,
  ) {
    const existing = await this.findJobByIdempotencyKey(idempotencyKey);
    if (existing)
      return {
        jobId: existing.id,
        chunkSize: PackageJobsService.RAW_CHUNK_BYTES,
      };
    if (!Number.isSafeInteger(file.bytesTotal) || file.bytesTotal <= 0) {
      throw new PackageError(
        'INVALID_INPUT',
        400,
        'bytesTotal must be a positive integer for a chunked upload.',
      );
    }
    const name = (file.name ?? '').trim();
    if (!/\.zip$/i.test(name)) {
      throw new PackageError(
        'PACKAGE_INVALID_ZIP',
        400,
        'Course packages must be uploaded as a .zip archive.',
      );
    }
    if (file.bytesTotal > this.config.packageMaxBytes) {
      throw new PackageError(
        'VALIDATION_ERROR',
        400,
        `Package exceeds the package size limit (${formatBytes(
          this.config.packageMaxBytes,
        )}).`,
      );
    }
    const jobId = randomUUID();
    const encodedTotal = encodeJobByteTotal(file.bytesTotal);
    await this.prisma.coursePackageJob.create({
      data: {
        id: jobId,
        kind: 'IMPORT',
        status: 'VALIDATING',
        stage: 'UPLOADING_PACKAGE',
        actorEmployeeId,
        courseId: targetCourseId ?? null,
        idempotencyKey: idempotencyKey ?? null,
        sourceFileName: name,
        bytesTotal: encodedTotal.bytesTotal,
        requestId: encodedTotal.requestId,
        bytesReceived: 0,
        progress: 0,
      },
    });
    return { jobId, chunkSize: PackageJobsService.RAW_CHUNK_BYTES };
  }

  /** 写入一个课程包分块。 */
  async appendPackageChunk(
    jobId: string,
    index: number,
    bytes: Buffer,
  ): Promise<{ jobId: string; progress: number }> {
    const job = await this.requireUploadingJob(jobId, 'UPLOADING_PACKAGE');
    if (!Number.isInteger(index) || index < 0) {
      throw new PackageError('INVALID_INPUT', 400, 'Invalid chunk index.');
    }
    if (
      bytes.length >
      PackageJobsService.RAW_CHUNK_BYTES +
        PackageJobsService.RAW_CHUNK_SLACK_BYTES
    ) {
      throw new PackageError(
        'VALIDATION_ERROR',
        400,
        `Chunk exceeds the agreed chunk size (${formatBytes(
          PackageJobsService.RAW_CHUNK_BYTES,
        )}).`,
      );
    }
    await this.writeStaging(this.rawChunkKey(jobId, index), bytes);
    const total = jobDeclaredBytes(job);
    const expected = this.chunkCountFor(total);
    const progress = Math.min(85, Math.round(((index + 1) / expected) * 85));
    await this.prisma.coursePackageJob.update({
      where: { id: jobId },
      data: {
        bytesReceived: Math.min(
          JOB_BYTE_TOTAL_MAX,
          Math.round((total * (index + 1)) / expected),
        ),
        progress,
      },
    });
    return { jobId, progress };
  }

  /** 全部分块到达后：后台按顺序拼包并校验（不把整包读进内存）。 */
  async completePackageUpload(jobId: string): Promise<JobView> {
    const job = await this.requireUploadingJob(jobId, 'UPLOADING_PACKAGE');
    const total = jobDeclaredBytes(job);
    if (!total) {
      throw new PackageError('INVALID_INPUT', 400, 'Missing upload size.');
    }
    const count = this.chunkCountFor(total);
    for (let i = 0; i < count; i++) {
      const present = await this.stagingExists(this.rawChunkKey(jobId, i));
      if (!present) {
        throw new PackageError(
          'RAW_UPLOAD_INCOMPLETE',
          400,
          `Missing chunk ${i + 1}/${count}.`,
        );
      }
    }
    await this.prisma.coursePackageJob.update({
      where: { id: jobId },
      data: { stage: 'PACKAGE_QUEUED', progress: 88 },
    });
    void this.assembleAndValidatePackage(jobId, count, total).catch(
      () => undefined,
    );
    return this.getJob(jobId);
  }

  private async assembleAndValidatePackage(
    jobId: string,
    count: number,
    total: number,
  ): Promise<void> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-pkg-'));
    const assembled = path.join(tmp, 'package.zip');
    try {
      const handle = await fs.open(assembled, 'w');
      const hash = createHash('sha256');
      try {
        for (let i = 0; i < count; i++) {
          const part = await this.storage.getStaging(
            this.rawChunkKey(jobId, i),
          );
          hash.update(part);
          await handle.write(part);
        }
      } finally {
        await handle.close();
      }
      await this.prisma.coursePackageJob.update({
        where: { id: jobId },
        data: {
          bytesTotal: Math.min(JOB_BYTE_TOTAL_MAX, total),
          requestId:
            total > JOB_BYTE_TOTAL_MAX
              ? `${RAW_BYTES_TOTAL_MARKER}${total}`
              : null,
          packageHash: hash.digest('hex'),
          stage: 'VALIDATING',
          progress: 40,
        },
      });
      await this.runValidationFromFile(jobId, assembled);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Package assembly failed';
      await this.prisma.coursePackageJob
        .update({
          where: { id: jobId },
          data: { status: 'FAILED', error: message, progress: 100 },
        })
        .catch(() => undefined);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      for (let i = 0; i < count; i++) {
        await this.storage
          .removeStaging(this.rawChunkKey(jobId, i))
          .catch(() => undefined);
      }
    }
  }

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
    // 递归收集子目录文件（flatten �?zip 根：素材/模板可能放在嵌套文件夹里�?
    const files: { name: string; full: string }[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        if (dir === base) {
          throw new PackageError(
            'RAW_DIR_NOT_FOUND',
            404,
            `Directory not found: ${rel}`,
          );
        }
        return;
      }
      for (const name of entries) {
        if (
          name.startsWith('.') ||
          name.startsWith('~$') ||
          name === '__MACOSX'
        )
          continue;
        const full = path.join(dir, name);
        const stat = await fs.stat(full);
        if (stat.isDirectory()) await walk(full);
        else if (stat.isFile()) files.push({ name, full });
      }
    };
    await walk(base);
    if (!files.length) {
      throw new PackageError(
        'RAW_DIR_EMPTY',
        400,
        `Directory has no importable files: ${rel}`,
      );
    }
    const zip = new JSZip();
    for (const file of files) {
      zip.file(file.name, await fs.readFile(file.full));
    }
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    return this.createRawImportJob(
      { name: `${path.basename(base)}.zip`, bytes },
      actorEmployeeId,
    );
  }

  private async runValidation(
    jobId: string,
    providedBytes?: Buffer,
  ): Promise<void> {
    const job = await this.prisma.coursePackageJob.findUnique({
      where: { id: jobId },
    });
    if (!job || !job.storageKey) return;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-ins-'));
    try {
      // 调用方手里已有同一份字节时直接复用，避免再从 staging 读回整包（少一份大缓冲）。
      const zipBytes =
        providedBytes ?? (await this.storage.getStaging(job.storageKey));
      const packagePath = path.join(tmp, 'package.zip');
      await fs.writeFile(packagePath, zipBytes);
      await this.inspectAndPersist(jobId, tmp, packagePath);
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

  /**
   * 分块拼好的课程包已经落在临时文件上：校验前不再整包读入内存，
   * 直接复制到本次校验目录（大包只多一次磁盘复制），之后与直传走同一套 inspect+persist。
   */
  private async runValidationFromFile(
    jobId: string,
    sourcePath: string,
  ): Promise<void> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-ins-'));
    try {
      const packagePath = path.join(tmp, 'package.zip');
      await fs.copyFile(sourcePath, packagePath);
      await this.inspectAndPersist(jobId, tmp, packagePath);
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

  private async inspectAndPersist(
    jobId: string,
    tmp: string,
    packagePath: string,
  ): Promise<void> {
    const outDir = path.join(tmp, 'files');
    await fs.mkdir(outDir, { recursive: true });
    // 解压 + 全面校验是 CPU 重活，放到 worker 线程，避免阻塞事件循环。
    const result = await runImportWorker<{
      manifest: PackageManifest;
      report: PackageValidationReport;
      files: string[];
    }>('inspect', { packagePath, outDir, config: this.config });
    await this.prisma.coursePackageJob.update({
      where: { id: jobId },
      data: {
        status: result.report.errors.length > 0 ? 'FAILED' : 'AWAITING_CONFIRM',
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
    // 暂存解压内容到 staging（媒体二进制 + manifest）。
    await this.persistExtractedFromDir(
      jobId,
      outDir,
      result.files,
      result.manifest,
    );
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

  /** Admin-only Sandbox recovery entry point for an already validated import. */
  async recoverInvalidLiveImport(jobId: string, reason: string, actorEmployeeId: string | null) {
    if (appEnvName() !== 'SANDBOX' || !this.config.sandboxResetEnabled) {
      throw new PackageError('RECOVERY_DISABLED', 403, 'Sandbox recovery is disabled.');
    }
    if (typeof reason !== 'string' || !reason.trim()) {
      throw new PackageError('RECOVERY_REASON_REQUIRED', 400, 'A recovery reason is required.');
    }
    const active = await this.prisma.sandboxResetJob.count({ where: { status: { in: ['QUEUED', 'RUNNING'] } } });
    if (active) throw new PackageError('SANDBOX_MAINTENANCE', 409, 'A sandbox reset is active.');
    const result = await this.confirmImport(jobId, { overwriteDraft: true }, actorEmployeeId, true);
    if (!('courseId' in result)) throw new PackageError('RECOVERY_NOT_APPLICABLE', 409, 'The course could not be recovered.');
    await tryRecordAuditEvent({ eventName: 'SANDBOX_LIVE_POINTER_RECOVERED', actorEmployeeId, targetEmployeeId: null,
      action: 'SANDBOX_RECOVERY', newValue: JSON.stringify({ jobId, reason: reason.trim(), courseId: result.courseId }), result: 'SUCCESS' });
    return result;
  }

  async confirmImport(
    jobId: string,
    body: {
      onConflict?: 'ABORT' | 'CREATE_NEW_COURSE' | 'NEW_VERSION';
      reassignCodes?: boolean;
      overwriteDraft?: boolean;
    },
    actorEmployeeId: string | null,
    recoverInvalidLive = false,
  ) {
    const job = await this.prisma.coursePackageJob.findUnique({
      where: { id: jobId },
    });
    if (!job)
      throw new PackageError('PACKAGE_JOB_NOT_FOUND', 404, 'Job not found.');

    const request = body ?? {};
    const onConflict = request.onConflict ?? 'ABORT';
    if (
      onConflict !== 'ABORT' &&
      onConflict !== 'CREATE_NEW_COURSE' &&
      onConflict !== 'NEW_VERSION'
    ) {
      throw new PackageError(
        'VALIDATION_ERROR',
        400,
        'onConflict must be ABORT, CREATE_NEW_COURSE or NEW_VERSION.',
      );
    }

    // 先条件认领（AWAITING_CONFIRM → IMPORTING），再读 staging manifest：
    // 双击或两人同时确认时只有一个请求能往下走；另一个明确得到 409 PACKAGE_CONFLICT，
    // 不会两个都因为"包已不在"而报错，更不会把同一个包导入两次。
    const claimed = await this.prisma.coursePackageJob.updateMany({
      where: { id: jobId, status: 'AWAITING_CONFIRM' },
      data: { status: 'IMPORTING', progress: 0 },
    });
    if (claimed.count === 0) {
      const current = await this.prisma.coursePackageJob.findUnique({
        where: { id: jobId },
        select: { status: true },
      });
      throw new PackageError(
        'PACKAGE_CONFLICT',
        409,
        `Import job is already being processed (status=${current?.status ?? job.status}).`,
      );
    }
    // 认领后在真正写库前发现"不该继续"（包丢失/冲突/已上线）时，把作业放回
    // AWAITING_CONFIRM，用户才能换冲突策略、取消或重新上传。
    let claimReleased = false;
    const releaseClaim = async (): Promise<void> => {
      if (claimReleased) return;
      claimReleased = true;
      await this.prisma.coursePackageJob
        .updateMany({
          where: { id: jobId, status: 'IMPORTING' },
          data: { status: 'AWAITING_CONFIRM', progress: job.progress ?? 100 },
        })
        .catch(() => undefined);
    };

    // 读取已校验的包清单（用于判定 Course ID 冲突）
    let manifest: PackageManifest;
    try {
      const manifestBytes = await this.storage.getStaging(
        this.storage.stagingKey(jobId, '__manifest.json'),
      );
      manifest = JSON.parse(manifestBytes.toString('utf8')) as PackageManifest;
    } catch {
      await releaseClaim();
      throw new PackageError(
        'PACKAGE_MANIFEST_MISSING',
        409,
        'Package manifest is no longer available; please re-upload the package.',
      );
    }

    // 目标课程：来自「导入到已有课程」（Versions 页）时直接写入该课草稿，始终允许。
    let targetCourseId: string | null = job.courseId;
    if (recoverInvalidLive && targetCourseId) {
      await releaseClaim();
      throw new PackageError('RECOVERY_NOT_APPLICABLE', 409, 'Recovery requires an import from a validated package with matching Course ID.');
    }

    if (!targetCourseId) {
      // 从包新建：按 Course ID（Excel 中的 Course ID 字段）判断是否已存在
      const existing = await this.prisma.commerceCourse.findFirst({
        where: { code: manifest.course.code },
        select: { id: true, code: true, liveVersionId: true },
      });
      if (existing) {
        if (existing.liveVersionId && recoverInvalidLive) {
          const valid = await this.prisma.courseVersion.findFirst({ where: { id: existing.liveVersionId, courseId: existing.id }, select: { id: true } });
          if (valid) { await releaseClaim(); throw new PackageError('RECOVERY_NOT_APPLICABLE', 409, 'The current live version is valid; recovery is refused.'); }
        } else if (existing.liveVersionId) {
          // 已上线课程：拒绝，避免影响线上内容（保持作业可取消，不置为 FAILED）
          await releaseClaim();
          return {
            jobId,
            status: job.status,
            refused: 'COURSE_ALREADY_LIVE' as const,
            existingCourseCode: existing.code,
            message: `Course ${existing.code} is already live. The import is refused: only draft courses (never published) can be overwritten, so live content is never affected.`,
          };
        }
        if (recoverInvalidLive && !existing.liveVersionId) {
          await releaseClaim();
          throw new PackageError('RECOVERY_NOT_APPLICABLE', 409, 'The course has no corrupt live pointer.');
        }
        // 用户显式确认覆盖 → 替换该草稿课程的沙盒草稿内容（保留原有覆盖行为）
        if (!request.overwriteDraft) {
          await releaseClaim();
          // 文档 §15.5：ABORT 且存在冲突 → 409 PACKAGE_CONFLICT（不再用 200 + requiresOverwrite 模糊表达）
          if (onConflict === 'ABORT') {
            throw new PackageError(
              'PACKAGE_CONFLICT',
              409,
              `Course ${existing.code} already exists. The Course ID must not already exist in this Admin, or the import is refused (onConflict=ABORT).`,
            );
          }
          // CREATE_NEW_COURSE / NEW_VERSION 尚未实现：明确 4xx，绝不静默按覆盖处理
          throw new PackageError(
            'PACKAGE_CONFLICT_STRATEGY_UNSUPPORTED',
            422,
            `onConflict=${onConflict} is not implemented yet; use ABORT (409 on conflict) or overwriteDraft=true to replace the existing draft.`,
          );
        }
        // 覆盖既有草稿
        targetCourseId = existing.id;
      } else if (recoverInvalidLive) {
        await releaseClaim();
        throw new PackageError('RECOVERY_NOT_APPLICABLE', 409, 'No matching course exists for this package.');
      } else if (onConflict === 'NEW_VERSION') {
        // NEW_VERSION 只适用于"目标已存在同 code"；没有目标时明确拒绝，不静默新建
        await releaseClaim();
        throw new PackageError(
          'PACKAGE_CONFLICT_STRATEGY_UNSUPPORTED',
          422,
          'NEW_VERSION requires an existing course with this Course ID; it is not implemented yet.',
        );
      }
    }
    try {
      const files = await this.loadStagingFiles(jobId, manifest);
      const result = targetCourseId
        ? await this.importer.importIntoExistingCourse(
            targetCourseId,
            manifest,
            files,
            actorEmployeeId,
            job.sourceFileName,
            recoverInvalidLive,
          )
        : await this.importer.importPackage(manifest, files, {
            onConflict,
            reassignCodes: request.reassignCodes ?? false,
            actorEmployeeId,
            sourceFileName: job.sourceFileName,
          });
      const courseId = result.courseId;
      // 把导入阶段产生的 warning（如视频时长探测失败）并入作业报告
      const currentReport = (job.report as JobReport | null) ?? {
        errors: [],
        warnings: [],
      };
      const warningKeys = new Set(
        (currentReport.warnings ?? []).map(
          (warning) => `${warning.code}|${warning.path ?? ''}`,
        ),
      );
      const report: JobReport = {
        errors: currentReport.errors ?? [],
        warnings: [...(currentReport.warnings ?? [])],
      };
      for (const warning of result.warnings ?? []) {
        const key = `${warning.code}|${warning.path ?? ''}`;
        if (warningKeys.has(key)) continue;
        warningKeys.add(key);
        report.warnings.push(warning);
      }
      await this.prisma.coursePackageJob.update({
        where: { id: jobId },
        data: {
          status: 'READY',
          progress: 100,
          courseId,
          stage: 'COMMITTED',
          report: report as unknown as Prisma.InputJsonValue,
        },
      });
      await this.storage.clearStagingPrefix(jobId);
      // 导入完成后在目标环境重新创建 Stripe 产品/价格（失败不阻断导入�?
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
    // 条件取消：与"确认导入"同时发生时，已开始导入的任务不会被标成已取消、删掉暂存文�?
    const cancelled = await this.prisma.coursePackageJob.updateMany({
      where: { id: jobId, status: { notIn: ['READY', 'IMPORTING'] } },
      data: { status: 'CANCELLED', cancelRequested: true },
    });
    if (cancelled.count === 0) {
      throw new PackageError(
        'PACKAGE_JOB_NOT_FOUND',
        409,
        'Job cannot be cancelled.',
      );
    }
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
      conflict: await this.detectCourseCodeConflict(job, manifest),
      report: report ?? { errors: [], warnings: [] },
    };
  }

  /**
   * 仅对「从包新建」的导入作业，在 Course ID 已存在时给出预判：
   * live=true 表示已上线（应拒绝覆盖），否则为可覆盖的草稿。
   */
  private async detectCourseCodeConflict(
    job: { courseId: string | null; kind: string },
    manifest: PackageManifest | null,
  ): Promise<{
    existingCourseCode: string;
    existingCourseId: string;
    live: boolean;
  } | null> {
    if (!manifest || job.courseId || job.kind !== 'IMPORT') return null;
    const existing = await this.prisma.commerceCourse.findFirst({
      where: { code: manifest.course.code },
      select: { id: true, code: true, liveVersionId: true },
    });
    if (!existing) return null;
    return {
      existingCourseCode: existing.code,
      existingCourseId: existing.id,
      live: Boolean(existing.liveVersionId),
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

  async listJobs(actorEmployeeId: string | null, kinds?: readonly string[]) {
    if (kinds && kinds.length === 0) return [];
    return this.prisma.coursePackageJob.findMany({
      where: {
        ...(actorEmployeeId ? { actorEmployeeId } : {}),
        ...(kinds ? { kind: { in: kinds as never[] } } : {}),
      },
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

  // ===== 导出 =====
  // PRD §16.2（owner 2026-11-18 裁决以 PRD 为准）：产品导出只允许当前线上版本；
  // 草稿 / 指定版本选择器在 parseExportSelector 里直接 400，导出前仍走 assertExportable 的 3 步门禁。
  async startExport(
    courseId: string,
    actorEmployeeId: string | null,
    body?: {
      version?: unknown;
      versionId?: unknown;
      sourceVersion?: unknown;
    } | null,
  ) {
    assertExportSelectorBody(body);
    // 选择器校验：非线上选择器 → 400 VALIDATION_ERROR，且不创建作业（先于任何查询）。
    parseExportSelector(body);
    const course = await this.prisma.commerceCourse.findUnique({
      where: { id: courseId },
      select: { code: true },
    });
    if (!course) {
      throw new PackageError('COURSE_NOT_FOUND', 404, 'Course not found.');
    }
    // 线上版本必须存在且 3 步完整（未发布/不完整时给出明确 4xx）。
    const exportable = await this.publishing.assertExportable(courseId);
    const sourceVersionId = exportable.versionId;
    const label = exportable.versionLabel;
    const fileLabel = `${course.code}_${label}.zip`;
    const jobId = randomUUID();
    await this.prisma.coursePackageJob.create({
      data: {
        id: jobId,
        kind: 'EXPORT',
        status: 'EXPORTING',
        courseId,
        actorEmployeeId,
        sourceVersionId,
        fileLabel,
        progress: 0,
      },
    });
    return {
      jobId,
      status: 'EXPORTING',
      versionId: sourceVersionId,
      versionLabel: label,
      fileName: fileLabel,
    };
  }
}
