import { Injectable } from '@nestjs/common';
import { EmbeddingService } from '../ai/embedding/embedding.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  KnowledgeClient,
  KnowledgeCourse,
  KnowledgeRelease,
  KnowledgeReleaseMeta,
  KnowledgeReleasePage,
  RetrievedChunk,
} from './contract/knowledge-client';

/** RAG 检索参数（对齐系统设计 §9.4） */
const RETRIEVAL_TOP_K = 6;
const RETRIEVAL_SCORE_THRESHOLD = 0.35;

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly embedding: EmbeddingService,
  ) {}

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

  /**
   * RAG 向量检索：对 query 生成 embedding，在 release 的 KnowledgeChunk 中
   * 做余弦相似度检索（topK=6，阈值=0.35）。KS 侧持有向量数据，Agent 只拿结果。
   */
  async retrieveChunks(
    releaseId: string,
    query: string,
    topK: number = RETRIEVAL_TOP_K,
  ): Promise<RetrievedChunk[]> {
    if (!query?.trim()) return [];

    const queryVec = await this.embedding.embedQuery(query);
    const vecStr = `[${queryVec.join(',')}]`;

    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        pageTitle: string;
        heading: string | null;
        content: string;
        score: number;
        tokenCount: number;
      }>
    >(
      `
      SELECT "pageTitle", "heading", "content",
             1 - (embedding <=> $1::vector(1536)) AS score,
             "tokenCount"
      FROM "KnowledgeChunk"
      WHERE "releaseId" = $2
      ORDER BY embedding <=> $1::vector(1536)
      LIMIT $3
    `,
      vecStr,
      releaseId,
      topK,
    );

    return rows
      .filter((r) => r.score >= RETRIEVAL_SCORE_THRESHOLD)
      .map((r) => ({
        pageTitle: r.pageTitle,
        heading: r.heading,
        content: r.content,
        score: r.score,
        tokenCount: r.tokenCount,
      }));
  }
}
