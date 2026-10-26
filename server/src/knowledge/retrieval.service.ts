import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from '../ai/embedding/embedding.service';

/** 检索结果 */
export interface RetrievedChunk {
  pageTitle: string;
  heading: string | null;
  content: string;
  /** 余弦相似度分数（0-1，越高越相关） */
  score: number;
  tokenCount: number;
}

/**
 * 检索服务（RAG，2026-10-26 新增）。
 * 根据用户问题的 embedding，在指定 Release 的 KnowledgeChunk 中做余弦相似度检索。
 */
@Injectable()
export class RetrievalService {
  private readonly defaultTopK: number;
  private readonly scoreThreshold: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly embedding: EmbeddingService,
  ) {
    this.defaultTopK = 6;
    this.scoreThreshold = 0.35;
  }

  /**
   * 检索与 query 最相关的 chunks。
   * @param releaseId Release ID
   * @param query 用户问题
   * @param topK 返回数量（默认 6）
   */
  async retrieve(
    releaseId: string,
    query: string,
    topK: number = this.defaultTopK,
  ): Promise<RetrievedChunk[]> {
    if (!query?.trim()) return [];

    // 1. 生成 query embedding
    const queryVec = await this.embedding.embedQuery(query);
    const vecStr = `[${queryVec.join(',')}]`;

    // 2. 余弦相似度检索（<=> 是 pgvector 的余弦距离操作符，1 - 距离 = 相似度）
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

    // 3. 过滤低于阈值的结果
    return rows
      .filter((r) => r.score >= this.scoreThreshold)
      .map((r) => ({
        pageTitle: r.pageTitle,
        heading: r.heading,
        content: r.content,
        score: r.score,
        tokenCount: r.tokenCount,
      }));
  }
}
