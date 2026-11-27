import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { EmbeddingService } from '../ai/embedding/embedding.service';
import { PrismaService } from '../prisma/prisma.service';
import { qaGeneration, qaParts } from './professor-qa-parts';

@Injectable()
export class ProfessorQaIndexService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ProfessorQaIndexService.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly db: PrismaService,
    private readonly embedding: EmbeddingService,
  ) {}

  onModuleInit() {
    this.schedule(1000);
  }

  onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.buildNext().then(
        (worked) => this.schedule(worked ? 250 : 15000),
        () => {
          this.log.warn('教授问答索引任务暂不可用');
          this.schedule(30000);
        },
      );
    }, delay);
    this.timer.unref();
  }

  async buildNext(onlyRelease?: string): Promise<boolean> {
    const generation = qaGeneration(this.embedding.model);
    const lease = randomUUID();
    const [job] = await this.db.$queryRaw<{ releaseId: string }[]>`
      WITH candidate AS (
        SELECT j."releaseId" FROM "ProfessorQaIndex" j
        JOIN "Release" r ON r.id=j."releaseId" JOIN "Course" c ON c.id=r."courseId"
        WHERE j."activeGeneration" IS DISTINCT FROM ${generation} AND j."nextAttempt" <= now()
          AND (${onlyRelease ?? null}::text IS NULL OR r.id=${onlyRelease ?? null})
        ORDER BY CASE WHEN r.id IN (c."currentReleaseId", c."aiTestReleaseId") THEN 0 ELSE 1 END,
                 j."nextAttempt", j."releaseId"
        LIMIT 1 FOR UPDATE OF j SKIP LOCKED
      )
      UPDATE "ProfessorQaIndex" j SET lease=${lease}, "nextAttempt"=now()+interval '5 minutes'
      FROM candidate c WHERE j."releaseId"=c."releaseId" RETURNING j."releaseId"`;
    if (!job) return false;
    const { releaseId } = job;
    try {
      const release = await this.db.release.findUnique({
        where: { id: releaseId },
        select: { courseId: true, snapshotData: true },
      });
      if (!release) return true;
      const snapshot = release.snapshotData as unknown as {
        teachingPackage: { cards: Parameters<typeof qaParts>[0] };
      };
      const rows = qaParts(snapshot.teachingPackage.cards);
      for (let start = 0; start < rows.length; start += 20) {
        if (this.stopped) return true;
        const batch = rows.slice(start, start + 20);
        const hits = await this.db.$queryRaw<{ hash: string; vec: string }[]>`
          SELECT DISTINCT ON (p."contentHash") p."contentHash" AS hash, p.embedding::text AS vec
          FROM "ProfessorQaPart" p JOIN "Release" r ON r.id=p."releaseId"
          WHERE r."courseId"=${release.courseId} AND generation=${generation}
            AND p."contentHash" IN (${Prisma.join(batch.map((row) => row.hash))})`;
        const vectors = new Map(hits.map((hit) => [hit.hash, hit.vec]));
        const missing = [
          ...new Map(
            batch
              .filter((row) => !vectors.has(row.hash))
              .map((row) => [row.hash, row]),
          ).values(),
        ];
        if (missing.length) {
          const values = await this.embedding.embedTexts(
            missing.map((row) => row.text),
            releaseId,
          );
          for (const [i, row] of missing.entries()) {
            const vec = values[i];
            if (vec?.length !== 1536 || !vec.every(Number.isFinite))
              throw new Error('Invalid QA embedding');
            vectors.set(row.hash, JSON.stringify(vec));
          }
        }
        const owned = await this.db.$transaction(async (tx) => {
          const renewed =
            await tx.$executeRaw`UPDATE "ProfessorQaIndex" SET "nextAttempt"=now()+interval '5 minutes'
            WHERE "releaseId"=${releaseId} AND lease=${lease}`;
          if (!renewed) return false;
          const values = batch.map(
            (
              row,
            ) => Prisma.sql`(${releaseId}, ${generation}, ${row.cardId}, ${row.part},
            ${row.hash}, setweight(to_tsvector('simple', ${row.questionTerms}), 'A') ||
            setweight(to_tsvector('simple', ${row.answerTerms}), 'B'), ${vectors.get(row.hash)}::vector)`,
          );
          await tx.$executeRaw`INSERT INTO "ProfessorQaPart" ("releaseId", generation, "cardId", part, "contentHash", terms, embedding)
            VALUES ${Prisma.join(values)} ON CONFLICT DO NOTHING`;
          return true;
        });
        if (!owned) return true;
      }
      await this.db
        .$executeRaw`UPDATE "ProfessorQaIndex" SET "activeGeneration"=${generation},
        failures=0, lease=NULL, "nextAttempt"=now() WHERE "releaseId"=${releaseId} AND lease=${lease}`;
    } catch (error) {
      this.log.warn(
        `QA index failed release=${releaseId} error=${error instanceof Error ? error.name : 'unknown'}`,
      );
      await this.db
        .$executeRaw`UPDATE "ProfessorQaIndex" SET failures=failures+1, lease=NULL,
        "nextAttempt"=now()+interval '1 minute'*least(60, failures+1)
        WHERE "releaseId"=${releaseId} AND lease=${lease}`;
    }
    return true;
  }
}
