import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from '../ai/embedding/embedding.service';
import { ChunkingService } from './chunking.service';

/** Release 快照中的 Page 结构 */
interface SnapshotPage {
  id: string;
  title: string;
  contentMd?: string;
}

interface SnapshotData {
  pages?: SnapshotPage[];
}

/**
 * 索引服务（RAG，2026-10-26 新增）。
 * 发布 Release 时异步调用：分块 → embedding → 写入 KnowledgeChunk 表。
 * 失败仅记录日志，不影响 Release 创建。
 */
@Injectable()
export class IndexingService {
  private readonly logger = new Logger(IndexingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chunking: ChunkingService,
    private readonly embedding: EmbeddingService,
  ) {}

  /**
   * 为指定 Release 构建向量索引。
   * 幂等：先删除该 Release 的旧 chunks，再重新写入。
   */
  async indexRelease(releaseId: string): Promise<void> {
    const startedAt = Date.now();
    try {
      const release = await this.prisma.release.findUnique({
        where: { id: releaseId },
        select: { id: true, snapshotData: true },
      });
      if (!release) {
        this.logger.warn(`索引失败：Release ${releaseId} 不存在`);
        return;
      }

      const snapshot = release.snapshotData as unknown as SnapshotData;
      const pages = snapshot?.pages ?? [];
      if (pages.length === 0) {
        this.logger.warn(`Release ${releaseId} 无页面，跳过索引`);
        return;
      }

      // 1. 分块
      const allChunks: Array<{
        pageId: string;
        pageTitle: string;
        heading: string | null;
        content: string;
        sortOrder: number;
        tokenCount: number;
      }> = [];

      let order = 0;
      for (const page of pages) {
        const content = page.contentMd?.trim();
        if (!content) continue;
        const chunks = this.chunking.chunkPage(page.title, content, order);
        for (const c of chunks) {
          allChunks.push({
            pageId: page.id,
            pageTitle: c.pageTitle,
            heading: c.heading,
            content: c.content,
            sortOrder: c.sortOrder,
            tokenCount: c.tokenCount,
          });
        }
        order += chunks.length;
      }

      if (allChunks.length === 0) {
        this.logger.warn(`Release ${releaseId} 分块结果为空，跳过索引`);
        return;
      }

      // 2. 批量 embedding
      const texts = allChunks.map((c) => c.content);
      const embeddings = await this.embedding.embedTexts(texts);

      // 3. 写入数据库（先删旧的，保证幂等）
      await this.prisma.$transaction(async (tx) => {
        await tx.knowledgeChunk.deleteMany({ where: { releaseId } });

        // 用 $queryRaw 批量插入向量（Prisma 不支持 vector 类型参数）
        // 分批插入，每批 100 条
        const batchSize = 100;
        for (let i = 0; i < allChunks.length; i += batchSize) {
          const batch = allChunks.slice(i, i + batchSize);
          const batchEmbeddings = embeddings.slice(i, i + batchSize);

          const values = batch
            .map((c, idx) => {
              const vec = `[${batchEmbeddings[idx].join(',')}]`;
              const pageId = c.pageId ? `'${c.pageId.replace(/'/g, "''")}'` : 'NULL';
              const heading = c.heading
                ? `'${c.heading.replace(/'/g, "''")}'`
                : 'NULL';
              return `(gen_random_uuid(), '${releaseId}', ${pageId}, '${c.pageTitle.replace(/'/g, "''")}', ${heading}, '${c.content.replace(/'/g, "''")}', '${vec}'::vector(1536), ${c.sortOrder}, ${c.tokenCount}, now())`;
            })
            .join(',');

          await tx.$executeRawUnsafe(`
            INSERT INTO "KnowledgeChunk"
            ("id", "releaseId", "pageId", "pageTitle", "heading", "content", "embedding", "sortOrder", "tokenCount", "createdAt")
            VALUES ${values}
          `);
        }
      });

      const elapsed = Date.now() - startedAt;
      this.logger.log(
        `Release ${releaseId} 索引完成：${allChunks.length} chunks，耗时 ${elapsed}ms`,
      );
    } catch (err) {
      this.logger.error(
        `Release ${releaseId} 索引失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
