import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { lockCourseRow } from '../prisma/course-lock';
import {
  EMBEDDING_QUERY_CLIENT,
  type EmbeddingQueryClient,
} from './contract/embedding-client';
import { PrismaService } from '../prisma/prisma.service';
import { mergeRetrievedChunks, retrievalTerms } from './keyword-retrieval';
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
    @Inject(EMBEDDING_QUERY_CLIENT)
    private readonly embedding: EmbeddingQueryClient,
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

  /** 与删除 Release 共用 Course 行锁，锁内复查版本仍属于该课程（QA 2026-10-27 A7） */
  setTestRelease(
    courseId: string,
    releaseId: string,
  ): Promise<KnowledgeCourse> {
    return this.prisma.$transaction(async (tx) => {
      await lockCourseRow(tx, courseId);
      const release = await tx.release.findUnique({
        where: { id: releaseId },
        select: { courseId: true },
      });
      if (!release || release.courseId !== courseId) {
        throw new NotFoundException('发布版本不存在或不属于该课程');
      }
      return tx.course.update({
        where: { id: courseId },
        data: { aiTestReleaseId: releaseId },
        select: COURSE_FIELDS,
      });
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
   * RAG 混合检索：向量召回（topK=6，阈值=0.35）与课程关键词召回按排名融合。
   * 两路均限定当前 Release；KS 侧持有向量数据，Agent 只拿结果。
   */
  async retrieveChunks(
    releaseId: string,
    query: string,
    topK: number = RETRIEVAL_TOP_K,
  ): Promise<RetrievedChunk[]> {
    if (!query?.trim()) return [];

    const queryVec = await this.embedding.embedQuery(query);
    const vecStr = `[${queryVec.join(',')}]`;

    const terms = retrievalTerms(query);
    const [rows, lexical] = await Promise.all([
      this.prisma.$queryRawUnsafe<RetrievedChunk[]>(
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
      ),
      terms.length
        ? this.prisma.$queryRawUnsafe<RetrievedChunk[]>(
            `
        SELECT "pageTitle", "heading", "content",
               COALESCE(1 - (embedding <=> $1::vector(1536)), 0) AS score,
               "tokenCount"
        FROM "KnowledgeChunk"
        WHERE "releaseId" = $2
          AND EXISTS (
            SELECT 1 FROM unnest($3::text[]) AS term
            WHERE strpos(lower("content"), term) > 0
               OR strpos(lower(COALESCE("heading", '')), term) > 0
          )
        ORDER BY (
          SELECT SUM(
            CASE WHEN strpos(lower(COALESCE("heading", '')), term) > 0 THEN 2 ELSE 0 END
            + CASE WHEN strpos(lower("content"), term) > 0 THEN 1 ELSE 0 END
          ) FROM unnest($3::text[]) AS term
        ) DESC, "sortOrder" ASC, "id" ASC
        LIMIT $4
      `,
            vecStr,
            releaseId,
            terms,
            topK,
          )
        : Promise.resolve([] as RetrievedChunk[]),
    ]);

    return mergeRetrievedChunks(
      rows.filter((r) => r.score >= RETRIEVAL_SCORE_THRESHOLD),
      lexical,
      topK,
    );
  }
}
