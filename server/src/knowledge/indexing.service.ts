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

export type ReleaseIndexStatus = 'building' | 'ready' | 'missing' | 'failed';

/**
 * 索引服务（RAG，2026-10-26 新增）。
 * 发布 Release 时异步调用：分块 → embedding → 写入 KnowledgeChunk 表。
 * 失败保留已有索引，Release 列表显示状态。
 */
@Injectable()
export class IndexingService {
  private readonly logger = new Logger(IndexingService.name);
  private readonly running = new Map<string, Promise<void>>();
  private readonly failed = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly chunking: ChunkingService,
    private readonly embedding: EmbeddingService,
  ) {}

  /**
   * 为指定 Release 构建向量索引。
   * 幂等：先删除该 Release 的旧 chunks，再重新写入。
   */
  indexRelease(releaseId: string): Promise<void> {
    const running = this.running.get(releaseId);
    if (running) return running;
    this.failed.delete(releaseId);
    const job = this.buildIndex(releaseId).finally(() => {
      this.running.delete(releaseId);
    });
    this.running.set(releaseId, job);
    return job;
  }

  status(releaseId: string, chunkCount: number): ReleaseIndexStatus {
    if (this.running.has(releaseId)) return 'building';
    if (this.failed.has(releaseId)) return 'failed';
    return chunkCount > 0 ? 'ready' : 'missing';
  }

  private async buildIndex(releaseId: string): Promise<void> {
    const startedAt = Date.now();
    const context = `releaseId=${releaseId}`;
    let stage = 'snapshot';
    let writeBatch: number | undefined;
    try {
      const release = await this.prisma.release.findUnique({
        where: { id: releaseId },
        select: { id: true, snapshotData: true },
      });
      if (!release) {
        this.logger.warn(`索引失败 ${context} stage=${stage}：版本不存在`);
        return;
      }

      const snapshot = release.snapshotData as unknown as SnapshotData;
      const pages = snapshot?.pages ?? [];
      if (pages.length === 0) {
        this.failed.add(releaseId);
        this.logger.warn(`索引失败 ${context} stage=${stage}：版本无页面`);
        return;
      }

      // 1. 分块
      stage = 'chunking';
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
        this.failed.add(releaseId);
        this.logger.warn(`索引失败 ${context} stage=${stage}：分块结果为空`);
        return;
      }

      // 2. 批量 embedding
      stage = 'embedding';
      const texts = allChunks.map((c) => c.content);
      const embeddings = await this.embedding.embedTexts(texts, releaseId);

      // 3. 写入数据库（先删旧的，保证幂等）
      // Prisma 交互式事务默认 5s 超时；长文本课程（Modeling life 74k 字符）
      // 的分块插入会超过它并被回滚，导致检索长期为空。显式放大超时。
      stage = 'database';
      await this.prisma.$transaction(
        async (tx) => {
          // 串行化不同进程对同一版本的替换，避免空索引被同时写入两遍。
          const releaseRows = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM "Release" WHERE id = ${releaseId} FOR UPDATE
          `;
          if (!releaseRows.length) return;
          await tx.knowledgeChunk.deleteMany({ where: { releaseId } });

          // 用 $queryRaw 批量插入向量（Prisma 不支持 vector 类型参数）
          // 分批插入。单条向量 1536 维 ≈ 18KB SQL 文本，100 条一批在
          // db.t4g.micro 上会超过 5s 事务上限（2026-10-28 实测），故降为 20。
          const batchSize = 20;
          for (let i = 0; i < allChunks.length; i += batchSize) {
            writeBatch = i / batchSize + 1;
            const batch = allChunks.slice(i, i + batchSize);
            const batchEmbeddings = embeddings.slice(i, i + batchSize);

            const values = batch
              .map((c, idx) => {
                const vec = `[${batchEmbeddings[idx].join(',')}]`;
                const pageId = c.pageId
                  ? `'${c.pageId.replace(/'/g, "''")}'`
                  : 'NULL';
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
          writeBatch = undefined;
        },
        { timeout: 120_000, maxWait: 15_000 },
      );

      const elapsed = Date.now() - startedAt;
      this.logger.log(
        `Release ${releaseId} 索引完成：${allChunks.length} chunks，耗时 ${elapsed}ms`,
      );
    } catch (err) {
      this.failed.add(releaseId);
      // Prisma 的错误信息首行常为空，原先只记录 message 会得到一条空白错误。
      const detail =
        err instanceof Error ? err.stack || err.message : String(err);
      const batch = writeBatch === undefined ? '' : ` batch=${writeBatch}`;
      this.logger.error(
        `索引失败 ${context} stage=${stage}${batch} elapsedMs=${Date.now() - startedAt}：${detail.replace(/\s+/g, ' ').slice(0, 500)}`,
      );
    }
  }
}
