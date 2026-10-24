import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  KnowledgeClient,
  KnowledgeCourse,
  KnowledgeRelease,
  KnowledgeReleaseMeta,
  KnowledgeReleasePage,
} from './contract/knowledge-client';

const COURSE_FIELDS = {
  id: true,
  title: true,
  externalId: true,
  currentReleaseId: true,
  aiTestReleaseId: true,
  aiTutorOnline: true,
} as const;

/**
 * KnowledgeClient 的 KS 侧实现：直接读 KS 的表。
 * 同进程时注入给 Agent；独立部署时由 KsInternalController 对外提供同样的数据。
 */
@Injectable()
export class PrismaKnowledgeClient implements KnowledgeClient {
  constructor(private readonly prisma: PrismaService) {}

  getCourse(courseId: string): Promise<KnowledgeCourse | null> {
    return this.prisma.course.findUnique({
      where: { id: courseId },
      select: COURSE_FIELDS,
    });
  }

  getCourseByExternalId(externalId: string): Promise<KnowledgeCourse | null> {
    return this.prisma.course.findFirst({
      where: { externalId },
      select: COURSE_FIELDS,
    });
  }

  listCourses(
    options: { mappedOnly?: boolean } = {},
  ): Promise<KnowledgeCourse[]> {
    return this.prisma.course.findMany({
      where: options.mappedOnly ? { externalId: { not: null } } : undefined,
      select: COURSE_FIELDS,
      orderBy: { title: 'asc' },
    });
  }

  getReleaseMeta(releaseId: string): Promise<KnowledgeReleaseMeta | null> {
    return this.prisma.release.findUnique({
      where: { id: releaseId },
      select: { id: true, courseId: true, versionTag: true },
    });
  }

  async getRelease(releaseId: string): Promise<KnowledgeRelease | null> {
    const release = await this.prisma.release.findUnique({
      where: { id: releaseId },
      select: {
        id: true,
        courseId: true,
        versionTag: true,
        snapshotData: true,
      },
    });
    if (!release) return null;
    const snapshot = release.snapshotData as {
      pages?: KnowledgeReleasePage[];
    } | null;
    return {
      id: release.id,
      courseId: release.courseId,
      versionTag: release.versionTag,
      pages: snapshot?.pages ?? [],
    };
  }

  setTestRelease(
    courseId: string,
    releaseId: string,
  ): Promise<KnowledgeCourse> {
    return this.prisma.course.update({
      where: { id: courseId },
      data: { aiTestReleaseId: releaseId },
      select: COURSE_FIELDS,
    });
  }

  setTutorOnline(courseId: string, online: boolean): Promise<KnowledgeCourse> {
    return this.prisma.course.update({
      where: { id: courseId },
      data: { aiTutorOnline: online },
      select: COURSE_FIELDS,
    });
  }
}
