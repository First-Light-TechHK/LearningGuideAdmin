import { HttpException } from '@nestjs/common';
import JSZip from 'jszip';
import type {
  PackageCourse,
  PackageManifest,
  PackageValidationReport,
} from './contracts/manifest';
import { validateManifestShape } from './manifest.validate';
import { validateCourseContent } from './package-validate';
import { validateMediaFile, MediaValidationError } from './media-validate';
import type { CommerceCourseConfig } from './commerce.config';
import { CourseStorageService } from './storage.service';

export interface ExtractedPackage {
  manifest: PackageManifest;
  files: Map<string, Buffer>;
}

export class PackageError extends HttpException {
  readonly code: string;
  readonly httpStatus: number;
  readonly reason: string;
  constructor(code: string, status: number, message: string) {
    super({ code, message }, status);
    this.code = code;
    this.httpStatus = status;
    this.reason = message;
  }
}

const MAX_ENTRIES = 10_000;

/**
 * 课程包解析 + 全面校验（解压、manifest、checksums、媒体、内容完整性、冲突）。
 * 纯逻辑，不落库；结果供导入作业消费。见设计文档 §5.4。
 */
export class PackageInspector {
  constructor(
    private readonly config: CommerceCourseConfig,
    private readonly storage: CourseStorageService,
  ) {}

  /** 安全解压 + 校验，返回 manifest 与文件表。 */
  async inspect(zipBytes: Buffer): Promise<{
    manifest: PackageManifest;
    files: Map<string, Buffer>;
    report: PackageValidationReport;
  }> {
    if (zipBytes.length > this.config.packageMaxBytes) {
      throw new PackageError('PACKAGE_TOO_LARGE', 413, 'Course package exceeds size limit.');
    }
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(zipBytes);
    } catch {
      throw new PackageError('PACKAGE_INVALID_ZIP', 400, 'Invalid or corrupt ZIP.');
    }

    const entries = Object.values(zip.files).filter((f) => !f.dir);
    if (entries.length > MAX_ENTRIES) {
      throw new PackageError('PACKAGE_INVALID_ZIP', 400, 'Too many files in package.');
    }

    let total = 0;
    const files = new Map<string, Buffer>();
    for (const entry of entries) {
      const name = entry.name;
      if (name.includes('..') || name.startsWith('/') || name.includes('\\')) {
        throw new PackageError('PACKAGE_INVALID_ZIP', 400, `Illegal path in package: ${name}`);
      }
      const bytes = await entry.async('nodebuffer');
      total += bytes.length;
      if (total > this.config.packageMaxBytes) {
        throw new PackageError('PACKAGE_TOO_LARGE', 413, 'Unpacked package exceeds size limit.');
      }
      files.set(name, bytes);
    }

    const manifestBytes = files.get('manifest.json');
    if (!manifestBytes) {
      // A .docx/.pptx/.xlsx is also a ZIP; give a clear message instead of "missing manifest".
      const looksLikeOfficeDoc =
        files.has('word/document.xml') ||
        files.has('[Content_Types].xml') ||
        files.has('word/') ||
        [...files.keys()].some((n) => n.startsWith('word/'));
      throw new PackageError(
        'PACKAGE_NOT_A_COURSE',
        422,
        looksLikeOfficeDoc
          ? 'This looks like a Word/Office document, not a course package. Word/PDF are lesson materials; upload a .lgcourse.zip course package instead.'
          : 'manifest.json is missing — this is not a course package. Upload a .lgcourse.zip course package.',
      );
    }
    let rawManifest: unknown;
    try {
      rawManifest = JSON.parse(manifestBytes.toString('utf8'));
    } catch {
      throw new PackageError('PACKAGE_MANIFEST_INVALID', 400, 'manifest.json is not valid JSON.');
    }
    const shape = validateManifestShape(rawManifest);
    if (!shape.manifest || shape.report.errors.length > 0) {
      throw new PackageError('PACKAGE_MANIFEST_INVALID', 400, firstError(shape.report));
    }

    // checksums 校验
    this.verifyChecksums(files);

    // 媒体校验
    const mediaWarnings: PackageValidationReport['warnings'] = [];
    for (const [, ref] of collectMediaRefs(shape.manifest.course)) {
      const bytes = files.get(ref);
      if (!bytes) {
        throw new PackageError('PACKAGE_MEDIA_INVALID', 422, `Missing media file: ${ref}`);
      }
      try {
        validateMediaFile({ name: ref.split('/').pop() ?? ref, bytes: files.get(ref)! }, this.config);
      } catch (error) {
        if (error instanceof MediaValidationError) {
          throw new PackageError('PACKAGE_MEDIA_INVALID', 422, `${ref}: ${error.message}`);
        }
        throw error;
      }
    }

    const content = validateCourseContent(shape.manifest.course, { forAction: 'import' });
    const report: PackageValidationReport = {
      errors: [...shape.report.errors, ...content.errors],
      warnings: [...shape.report.warnings, ...content.warnings, ...mediaWarnings],
      incomplete: content.incomplete,
    };
    return { manifest: shape.manifest, files, report };
  }

  private verifyChecksums(files: Map<string, Buffer>): void {
    const checksum = files.get('checksums.sha256');
    if (!checksum) return; // 可选：无 checksums 时跳过
    for (const line of checksum.toString('utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(trimmed);
      if (!match) continue;
      const [, hash, rel] = match;
      const bytes = files.get(rel.replace(/^\.?\//, ''));
      if (!bytes) {
        throw new PackageError('PACKAGE_CHECKSUM_MISMATCH', 422, `Checksum references missing file: ${rel}`);
      }
      if (CourseStorageService.sha256(bytes) !== hash.toLowerCase()) {
        throw new PackageError('PACKAGE_CHECKSUM_MISMATCH', 422, `Checksum mismatch: ${rel}`);
      }
    }
  }
}

function firstError(report: PackageValidationReport): string {
  return report.errors[0]?.message ?? 'Invalid manifest.';
}

/** 遍历 manifest，收集所有媒体相对路径（cover/video/exhibit/thumbnail）。 */
export function collectMediaRefs(course: PackageCourse): Array<[string, string]> {
  const refs: Array<[string, string]> = [];
  if (course.cover) refs.push(['cover', course.cover]);
  for (const lesson of course.lessons ?? []) {
    for (const [, loc] of Object.entries(lesson.localized ?? {})) {
      if (loc.video?.file) refs.push(['video', loc.video.file]);
    }
    for (const ex of lesson.exhibits ?? []) {
      if (ex.file) refs.push(['exhibit', ex.file]);
      if (ex.thumbnail) refs.push(['thumbnail', ex.thumbnail]);
    }
  }
  return refs;
}
