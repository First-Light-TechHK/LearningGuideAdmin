import JSZip from 'jszip';
import type { PrismaService } from '../prisma/prisma.service';
import { CourseStorageService } from './storage.service';
import { buildCourseSnapshot, type CourseAggregate } from './snapshot';
import {
  PACKAGE_FORMAT,
  PACKAGE_FORMAT_VERSION,
  type PackageManifest,
} from './contracts/manifest';

/**
 * 从课程聚合生成 .lgcourse.zip（导出）。见设计文档 §4/§5.6。
 * 返回 zip 字节；调用方负责存储与下载令牌。
 */
export async function buildCoursePackage(
  prisma: PrismaService,
  storage: CourseStorageService,
  courseId: string,
  sourceVersion: string,
): Promise<Buffer> {
  const agg = (await prisma.commerceCourse.findUnique({
    where: { id: courseId },
    include: {
      category: true,
      cover: true,
      localizations: true,
      trialRows: true,
      lessons: {
        orderBy: { sortOrder: 'asc' },
        include: {
          localizations: { include: { video: true } },
          exhibits: { include: { media: true, thumbnail: true } },
          readings: { orderBy: { sortOrder: 'asc' } },
          questions: { orderBy: { sortOrder: 'asc' } },
          applicationTest: true,
          learningPoints: { orderBy: { sortOrder: 'asc' } },
          triggers: true,
        },
      },
    },
  })) as unknown as CourseAggregate | null;
  if (!agg) throw new Error('Course not found');

  const { course, media } = buildCourseSnapshot(agg);
  const zip = new JSZip();
  const checksums: string[] = [];

  for (const ref of media) {
    if (!ref.storageKey) continue;
    try {
      const bytes = await storage.getMedia(ref.storageKey);
      zip.file(ref.path, bytes);
      checksums.push(`${CourseStorageService.sha256(bytes)}  ${ref.path}`);
    } catch {
      // 媒体缺失时导出失败（不允许坏包），这里抛错由上层处理
      throw new Error(`Export failed: media missing for ${ref.path}`);
    }
  }

  const manifest: PackageManifest = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    packageId: `pkg_${courseId}_${Date.now().toString(36)}`,
    exportedAt: new Date().toISOString(),
    source: { courseCode: course.code, sourceVersion },
    incomplete: false,
    course,
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  if (checksums.length) zip.file('checksums.sha256', checksums.join('\n'));

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
