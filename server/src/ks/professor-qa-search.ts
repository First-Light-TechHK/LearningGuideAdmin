import { Prisma } from '@prisma/client';
import { qaGeneration, qaTerms } from '../knowledge/professor-qa-parts';
import type { PrismaService } from '../prisma/prisma.service';
import type { EmbeddingQueryClient } from './contract/embedding-client';
import type { ProfessorQaSearch } from './contract/knowledge-client';

type Hit = { cardId: string };

async function timedRead<T>(db: PrismaService, query: Prisma.PrismaPromise<T>) {
  const [, result] = await db.$transaction([
    db.$executeRaw`SET LOCAL statement_timeout = '900ms'`,
    query,
  ]);
  return result;
}

export function fuseQa(ranks: Hit[][]): string[] {
  const scores = new Map<string, number>();
  for (const rank of ranks) {
    [...new Set(rank.map((hit) => hit.cardId))].forEach((id, i) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (61 + i));
    });
  }
  return [...scores]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, 5)
    .map(([id]) => id);
}

export async function searchProfessorQa(
  db: PrismaService,
  embedding: EmbeddingQueryClient,
  courseId: string,
  releaseId: string,
  query: string,
  allowed: string[],
  teachingIds: string[] = [],
): Promise<ProfessorQaSearch> {
  const ids = [...new Set([...allowed, ...teachingIds])];
  if (!query.trim() || !ids.length) return { status: 'ready', cardIds: [] };
  const [index] = await timedRead(
    db,
    db.$queryRaw<{ generation: string }[]>`
    SELECT j."activeGeneration" AS generation FROM "ProfessorQaIndex" j JOIN "Release" r ON r.id=j."releaseId"
    WHERE r.id=${releaseId} AND r."courseId"=${courseId} AND j."activeGeneration" IS NOT NULL`,
  );
  if (!index) return { status: 'missing', cardIds: [] };
  const scope = Prisma.sql`"releaseId"=${releaseId} AND generation=${index.generation}`;
  const teaching = teachingIds.length
    ? Prisma.sql`"cardId" IN (${Prisma.join(teachingIds)})`
    : Prisma.sql`false`;
  const terms = qaTerms(query).slice(0, 96);
  // plainto_tsquery 对每个绑定词项做转义，|| 在 PostgreSQL 中合并 tsquery。
  const or = Prisma.join(
    terms.length
      ? terms.map((t) => Prisma.sql`plainto_tsquery('simple', ${t})`)
      : [Prisma.sql`''::tsquery`],
    ' || ',
  );
  const lexical = allowed.length
    ? timedRead(
        db,
        db.$queryRaw<
          Hit[]
        >`SELECT "cardId" FROM "ProfessorQaPart", (SELECT ${or} AS q) query
    WHERE ${scope} AND "cardId" IN (${Prisma.join(allowed)}) AND part=0 AND terms @@ q ORDER BY ts_rank_cd(terms,q) DESC, "cardId" LIMIT 20`,
      )
    : [];
  const vector = async () => {
    if (!embedding.model || index.generation !== qaGeneration(embedding.model))
      throw new Error('model mismatch');
    const values = await embedding.embedQuery(query, 1800);
    if (values.length !== 1536 || !values.every(Number.isFinite))
      throw new Error('invalid query embedding');
    const vec = JSON.stringify(values);
    return timedRead(
      db,
      db.$queryRaw<(Hit & { kind: string })[]>`WITH per_card AS (
      SELECT "cardId", CASE WHEN ${teaching} THEN 'teaching' WHEN part=0 THEN 'question' ELSE 'answer' END AS kind,
             min(embedding <=> ${vec}::vector) AS distance FROM "ProfessorQaPart"
      WHERE ${scope} AND "cardId" IN (${Prisma.join(ids)}) GROUP BY "cardId", kind
    ), ranked AS (SELECT *, row_number() OVER (PARTITION BY kind ORDER BY distance, "cardId") AS pos FROM per_card)
    SELECT "cardId",kind FROM ranked WHERE pos<=20 AND (kind <> 'teaching' OR distance <= 0.55) ORDER BY kind,pos`,
    );
  };
  const [text, semantic] = await Promise.allSettled([lexical, vector()]);
  const rows = semantic.status === 'fulfilled' ? semantic.value : [];
  return {
    generation: index.generation,
    status:
      text.status === 'fulfilled' && semantic.status === 'fulfilled'
        ? 'ready'
        : 'degraded',
    ...(teachingIds.length
      ? {
          teachingCardIds: rows
            .filter((r) => r.kind === 'teaching')
            .slice(0, 5)
            .map((r) => r.cardId),
        }
      : {}),
    cardIds: fuseQa([
      text.status === 'fulfilled' ? text.value : [],
      rows.filter((r) => r.kind === 'question'),
      rows.filter((r) => r.kind === 'answer'),
    ]),
  };
}
