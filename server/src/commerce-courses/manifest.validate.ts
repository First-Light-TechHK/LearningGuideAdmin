import {
  PACKAGE_FORMAT,
  PACKAGE_FORMAT_VERSION,
  type PackageManifest,
  type PackageValidationIssue,
  type PackageValidationReport,
} from './contracts/manifest';

/**
 * manifest 结构校验（tolerant：未知字段忽略；关键字段缺失报 error）。
 * 内容完整性（多语言、学习点、测试）在 package-validate.ts 里结合媒体校验。
 */
export function validateManifestShape(raw: unknown): {
  manifest?: PackageManifest;
  report: PackageValidationReport;
} {
  const errors: PackageValidationIssue[] = [];
  const warnings: PackageValidationIssue[] = [];
  const push = (
    level: 'error' | 'warning',
    code: string,
    message: string,
    path?: string,
  ) => (level === 'error' ? errors : warnings).push({ level, code, path, message });

  const obj = raw as Record<string, unknown>;
  if (!obj || typeof obj !== 'object') {
    push('error', 'PACKAGE_MANIFEST_INVALID', 'manifest.json is not an object');
    return { report: { errors, warnings, incomplete: true } };
  }
  if (obj.format !== PACKAGE_FORMAT) {
    push('error', 'PACKAGE_MANIFEST_INVALID', `format must be "${PACKAGE_FORMAT}"`, 'format');
  }
  if (typeof obj.formatVersion !== 'number' || obj.formatVersion > PACKAGE_FORMAT_VERSION) {
    push(
      'error',
      'PACKAGE_FORMAT_UNSUPPORTED',
      `unsupported formatVersion (max ${PACKAGE_FORMAT_VERSION})`,
      'formatVersion',
    );
  }
  const course = obj.course as Record<string, unknown> | undefined;
  if (!course || typeof course !== 'object') {
    push('error', 'PACKAGE_MANIFEST_INVALID', 'course is required', 'course');
    return { report: { errors, warnings, incomplete: true } };
  }
  const str = (v: unknown, p: string, required = true): void => {
    if (required ? typeof v !== 'string' || !v : v != null && typeof v !== 'string') {
      push('error', 'PACKAGE_MANIFEST_INVALID', `${p} is required`, p);
    }
  };
  str(course.code, 'course.code');
  str(course.slug, 'course.slug');
  str(course.category, 'course.category');
  str(course.learningMode, 'course.learningMode');
  if (!Array.isArray(course.learningLanguages) || course.learningLanguages.length === 0) {
    push('error', 'PACKAGE_MANIFEST_INVALID', 'course.learningLanguages is required', 'course.learningLanguages');
  }
  str(course.defaultContentLanguage, 'course.defaultContentLanguage');
  const localized = course.localized as Record<string, unknown> | undefined;
  if (!localized || typeof localized !== 'object') {
    push('error', 'PACKAGE_MANIFEST_INVALID', 'course.localized is required', 'course.localized');
  }
  const lessons = course.lessons;
  if (!Array.isArray(lessons) || lessons.length === 0) {
    warnings.push({
      level: 'warning',
      code: 'COURSE_NO_LESSONS',
      path: 'course.lessons',
      message: 'course has no lessons',
    });
  }

  if (errors.length > 0) {
    return { report: { errors, warnings, incomplete: true } };
  }
  return {
    manifest: raw as PackageManifest,
    report: { errors, warnings, incomplete: false },
  };
}
