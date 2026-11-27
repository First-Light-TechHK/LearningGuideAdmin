import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { PrismaService } from '../../src/prisma/prisma.service';
import { qaGeneration } from '../../src/knowledge/professor-qa-parts';
import { searchProfessorQa } from '../../src/ks/professor-qa-search';

async function run(url: string) {
  const db = new PrismaService({ datasourceUrl: url });
  const courseId = randomUUID();
  const allowed = Array.from({ length: 200 }, (_, n) => 'qa-' + (n + 1));
  const vector = Array.from({ length: 1536 }, (_, n) => Math.sin(n + 1));
  const embed = {
    model: 'qa-bench',
    embedQuery: () => Promise.resolve(vector),
  };
  const generation = qaGeneration(embed.model);
  let target = '';
  try {
    await db.course.create({
      data: { id: courseId, title: 'Professor QA benchmark' },
    });
    for (let n = 1; n <= 20; n++) {
      const r = await db.release.create({
        data: {
          courseId,
          versionTag: String(n),
          revisionNotes: '',
          snapshotData: { teachingPackage: { cards: [] } },
        },
      });
      if (!target) target = r.id;
      await db.$transaction(
        async (tx) => {
          await tx.$executeRaw`INSERT INTO "ProfessorQaPart" ("releaseId", generation, "cardId", part, "contentHash", terms, embedding)
          SELECT ${r.id}, ${generation}, 'qa-'||i, p, 'benchmark',
                 to_tsvector('simple', 'topic '||i), ARRAY(SELECT sin(j+i+p)::real FROM generate_series(0,1535) j)::vector
          FROM generate_series(1,200) i CROSS JOIN generate_series(0,1) p`;
          await tx.$executeRaw`UPDATE "ProfessorQaIndex" SET "activeGeneration"=${generation} WHERE "releaseId"=${r.id}`;
        },
        { timeout: 30000 },
      );
      if (n !== 1 && n !== 20) continue;
      const ms: number[] = [];
      for (let i = 0; i < 55; i++) {
        const start = performance.now();
        const result = await searchProfessorQa(
          db,
          embed,
          courseId,
          target,
          'topic ' + (1 + i),
          allowed,
        );
        if (result.status !== 'ready' || !result.cardIds.length)
          throw new Error('incomplete search');
        if (i >= 5) ms.push(performance.now() - start);
      }
      ms.sort((a, b) => a - b);
      const percentile = (p: number) =>
        Number(ms[Math.ceil(p * ms.length) - 1].toFixed(2));
      console.log(
        JSON.stringify({
          releases: n,
          vectors: n * 400,
          scopedVectors: 400,
          queries: ms.length,
          p50Ms: percentile(0.5),
          p95Ms: percentile(0.95),
          p99Ms: percentile(0.99),
        }),
      );
    }
  } finally {
    try {
      await db.release.deleteMany({ where: { courseId } });
      await db.course.deleteMany({ where: { id: courseId } });
    } finally {
      await db.$disconnect();
    }
  }
}

const url = process.env.PROFESSOR_QA_TEST_DATABASE_URL;
if (!url)
  throw new Error(
    'Set PROFESSOR_QA_TEST_DATABASE_URL to a migrated isolated test database',
  );
void run(url).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'benchmark failed');
  process.exitCode = 1;
});
