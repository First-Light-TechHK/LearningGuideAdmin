import { createHash } from 'crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  captureVersionSnapshot,
  type SnapshotLesson,
  type VersionSnapshot,
} from './version-snapshot';

/**
 * 课程内容指纹（技术方案补充 §1、§追踪）。
 *
 * contentHash = sha256(规范化 JSON(内容视图))，相当于 git 的 tree：
 * - 只看内容：去掉 capturedAt、Lesson 行 ID 这类每次都会变或因环境而异的字段；
 * - 媒体按文件 sha256 引用（没有 checksum 的旧资产退回用资产 ID），
 *   这样同一份内容在 Sandbox 和 Production 的指纹相同；
 * - 数组按内容排序，数据库返回顺序不同不影响指纹；对象键按 RFC 8785 排序。
 *
 * 用途：草稿与线上 Release 指纹相同即 No draft（PRD §15.1）；
 * Restore 回旧内容时，新版本与旧版本指纹相同。
 */

type AssetKey = (assetId: string | null) => string | null;

/** RFC 8785（JCS）规范化：对象键按 UTF-16 码元排序，数字与字符串按 ES 序列化。 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonicalJson: non-finite number');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
}

function compareBy<T>(...keys: Array<(item: T) => string | number | null>) {
  return (a: T, b: T): number => {
    for (const key of keys) {
      const left = key(a) ?? '';
      const right = key(b) ?? '';
      if (left < right) return -1;
      if (left > right) return 1;
    }
    return 0;
  };
}

function sorted<T>(
  items: readonly T[],
  ...keys: Array<(item: T) => string | number | null>
): T[] {
  return [...items].sort(compareBy(...keys));
}

function lessonView(lesson: SnapshotLesson, asset: AssetKey) {
  return {
    code: lesson.code,
    sortOrder: lesson.sortOrder,
    localizations: sorted(lesson.localizations, (l) => l.language).map(
      (loc) => ({ ...loc, videoAssetId: asset(loc.videoAssetId) }),
    ),
    exhibits: sorted(lesson.exhibits, (e) => e.code).map((exhibit) => ({
      ...exhibit,
      mediaAssetId: asset(exhibit.mediaAssetId),
      thumbnailAssetId: asset(exhibit.thumbnailAssetId),
    })),
    learningPoints: sorted(
      lesson.learningPoints,
      (lp) => lp.language,
      (lp) => lp.sortOrder,
      (lp) => lp.code,
    ),
    triggers: sorted(
      lesson.triggers,
      (t) => t.exhibitCode,
      (t) => t.language,
      (t) => t.timeSeconds,
    ),
    readings: sorted(
      lesson.readings,
      (r) => r.language,
      (r) => r.sortOrder,
      (r) => r.title,
    ),
    questions: sorted(
      lesson.questions,
      (q) => q.sortOrder,
      (q) => q.code,
    ),
    applicationTest: lesson.applicationTest,
  };
}

/** 参与指纹的内容视图。 */
export function contentView(snapshot: VersionSnapshot, asset: AssetKey) {
  const { course } = snapshot;
  return {
    formatVersion: snapshot.formatVersion,
    course: {
      code: course.code,
      slug: course.slug,
      categoryId: course.categoryId,
      cover: asset(course.coverAssetId),
      learningMode: course.learningMode,
      defaultContentLanguage: course.defaultContentLanguage,
      learningLanguages: course.learningLanguages,
      localizations: sorted(course.localizations, (l) => l.language),
      lessons: sorted(
        course.lessons,
        (l) => l.sortOrder,
        (l) => l.code,
      ).map((lesson) => lessonView(lesson, asset)),
    },
  };
}

export function contentHash(snapshot: VersionSnapshot, asset: AssetKey) {
  return createHash('sha256')
    .update(canonicalJson(contentView(snapshot, asset)))
    .digest('hex');
}

/** 快照里引用到的全部资产 ID。 */
export function snapshotAssetIds(snapshot: VersionSnapshot): string[] {
  const ids = new Set<string>();
  const add = (id: string | null) => {
    if (id) ids.add(id);
  };
  add(snapshot.course.coverAssetId);
  for (const lesson of snapshot.course.lessons) {
    for (const loc of lesson.localizations) add(loc.videoAssetId);
    for (const exhibit of lesson.exhibits) {
      add(exhibit.mediaAssetId);
      add(exhibit.thumbnailAssetId);
    }
  }
  return [...ids];
}

type Db = PrismaService | Prisma.TransactionClient;

/** 资产 ID → 指纹里使用的键：有 checksum 用 `sha256:<hex>`，否则 `asset:<id>`。 */
export async function assetKeyFor(
  db: Db,
  snapshot: VersionSnapshot,
): Promise<AssetKey> {
  const ids = snapshotAssetIds(snapshot);
  const rows = ids.length
    ? await db.courseMediaAsset.findMany({
        where: { id: { in: ids } },
        select: { id: true, checksum: true },
      })
    : [];
  const checksumById = new Map(rows.map((row) => [row.id, row.checksum]));
  return (id) => {
    if (!id) return null;
    const checksum = checksumById.get(id);
    return checksum ? `sha256:${checksum}` : `asset:${id}`;
  };
}

export async function snapshotContentHash(
  db: Db,
  snapshot: VersionSnapshot,
): Promise<string> {
  return contentHash(snapshot, await assetKeyFor(db, snapshot));
}

/** 当前草稿（工作区）的指纹。 */
export async function draftContentHash(
  db: Db,
  courseId: string,
): Promise<string> {
  return snapshotContentHash(db, await captureVersionSnapshot(db, courseId));
}

/** 版本的指纹：已存则直接用；旧版本没存时按快照现算（版本不可变，结果稳定）。 */
export async function versionContentHash(
  db: Db,
  versionId: string,
): Promise<string | null> {
  const version = await db.courseVersion.findUnique({
    where: { id: versionId },
    select: { contentHash: true, snapshotData: true },
  });
  if (!version) return null;
  if (version.contentHash) return version.contentHash;
  return snapshotContentHash(
    db,
    version.snapshotData as unknown as VersionSnapshot,
  );
}
