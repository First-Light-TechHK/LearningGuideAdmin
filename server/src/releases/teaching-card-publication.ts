import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

interface ApprovedCard {
  id: string;
  deletedAt?: Date | null;
  approved: Prisma.JsonValue;
  reviewerId: string | null;
}

export function teachingPackageBase(
  snapshotData: unknown,
): Record<string, unknown> | undefined {
  const data = snapshotData as
    | {
        teachingPackageInput?: Record<string, unknown>;
        teachingPackageBase?: Record<string, unknown> | null;
      }
    | null
    | undefined;
  return data?.teachingPackageBase === null
    ? undefined
    : (data?.teachingPackageBase ?? data?.teachingPackageInput);
}

export function mergeApprovedCards(
  base: Record<string, unknown> | undefined,
  managed: ApprovedCard[],
): Record<string, unknown> | undefined {
  if (!managed.length) return base;
  if (base && (!Array.isArray(base.cards) || !Array.isArray(base.glossary)))
    throw new BadRequestException('INVALID_TEACHING_CARD');
  const managedIds = new Set(managed.map((entry) => entry.id));
  const deletedIds = new Set(
    managed.filter((entry) => entry.deletedAt).map((entry) => entry.id),
  );
  const cards = (
    Array.isArray(base?.cards)
      ? (base.cards as Array<Record<string, unknown>>)
      : []
  ).filter((card) => !managedIds.has(String(card.cardId)));
  const glossary = new Map(
    (Array.isArray(base?.glossary)
      ? (base.glossary as Array<Record<string, unknown>>)
      : []
    ).map((entry) => [String(entry.conceptId), entry] as const),
  );
  for (const entry of managed) {
    if (entry.deletedAt || !entry.approved || !entry.reviewerId) continue;
    const approved = entry.approved as Prisma.JsonObject;
    if (typeof approved.conceptId !== 'string')
      throw new BadRequestException('INVALID_TEACHING_CARD');
    const conceptId = approved.conceptId;
    const bilingual = approved.bilingual as Prisma.JsonObject;
    if (!glossary.has(conceptId))
      glossary.set(conceptId, {
        conceptId,
        label: bilingual.conceptLabel,
        aliases: { en: [], zh: [] },
      });
    cards.push({ ...approved, cardId: entry.id, reviewerId: entry.reviewerId });
  }
  if (
    !cards.length &&
    (base?.cards as Array<Record<string, unknown>> | undefined)?.some((card) =>
      deletedIds.has(String(card.cardId)),
    )
  )
    return undefined;
  if (!cards.length) return base ? { ...base, cards } : undefined;
  return { cards, glossary: [...glossary.values()] };
}
