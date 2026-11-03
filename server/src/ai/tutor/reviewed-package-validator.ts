import { types } from 'node:util';
import { verifyAnchoredChunk } from './verify-anchored-chunk';
import type { AnchoredChunk, SnapshotPage } from './anchored-chunks';
import { snapshotHash } from './snapshot-hash';

const CARD_TYPES = new Set([
  'source',
  'concept',
  'distinction',
  'frame',
  'misreading',
  'lens',
  'boundary',
  'rubric',
  'teaching_move',
]);

export interface ReviewedTeachingCard {
  cardId: string;
  conceptId: string;
  type: string;
  topic: string;
  canonicalPoint: string;
  approvedPayload: unknown;
  bilingual: {
    conceptLabel: { en: string; zh: string };
    summary: { en: string; zh: string };
    triggers: { en: string[]; zh: string[] };
  };
  useWhen: string[];
  doNotUseWhen: string[];
  sourceSupport: string[];
  links: string[];
  priority: number;
  reviewerId: string;
  reviewStatus: 'approved';
  cardHash: string;
}

export interface ReviewedTeachingPackage {
  manifest: {
    courseId: string;
    releaseId: string;
    snapshotHash: string;
    packageRevision: number;
    schemaVersion: 'tutor-package-v1';
    buildVersion: string;
  };
  sources: AnchoredChunk[];
  cards: ReviewedTeachingCard[];
  glossary: Array<{
    conceptId: string;
    label: { en: string; zh: string };
    aliases: { en: string[]; zh: string[] };
  }>;
}

export type ReviewedPackageValidation =
  | { valid: true; value: ReviewedTeachingPackage; packageHash: string }
  | {
      valid: false;
      reason:
        | 'INVALID_PACKAGE'
        | 'MANIFEST_MISMATCH'
        | 'INVALID_SOURCE'
        | 'INVALID_CARD'
        | 'DUPLICATE_ID'
        | 'SOURCE_NOT_FOUND'
        | 'LINK_NOT_FOUND'
        | 'GLOSSARY_MISMATCH'
        | 'CARD_HASH_MISMATCH';
    };

function isPlainJson(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || types.isProxy(value) || ancestors.has(value))
    return false;
  const array = Array.isArray(value);
  const proto: unknown = Object.getPrototypeOf(value);
  if (
    array
      ? proto !== Array.prototype
      : proto !== Object.prototype && proto !== null
  )
    return false;
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  if (array && (keys.length !== value.length + 1 || !keys.includes('length')))
    return false;
  for (const key of keys) {
    if (typeof key !== 'string') return false;
    if (array && key === 'length') continue;
    if (
      array &&
      (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)
    )
      return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !('value' in descriptor) ||
      !isPlainJson(descriptor.value as unknown, ancestors)
    )
      return false;
  }
  ancestors.delete(value);
  return true;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]) {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function stringList(value: unknown, allowEmpty = true): value is string[] {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every(nonEmptyString)
  );
}

function isBilingual(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['conceptLabel', 'summary', 'triggers'])
  )
    return false;
  const pair = (item: unknown) =>
    isRecord(item) &&
    hasExactKeys(item, ['en', 'zh']) &&
    nonEmptyString(item.en) &&
    nonEmptyString(item.zh);
  return (
    pair(value.conceptLabel) &&
    pair(value.summary) &&
    isRecord(value.triggers) &&
    hasExactKeys(value.triggers, ['en', 'zh']) &&
    stringList(value.triggers.en) &&
    stringList(value.triggers.zh)
  );
}

function isCard(value: unknown): value is ReviewedTeachingCard {
  if (!isRecord(value)) return false;
  const fields = [
    'cardId',
    'conceptId',
    'type',
    'topic',
    'canonicalPoint',
    'approvedPayload',
    'bilingual',
    'useWhen',
    'doNotUseWhen',
    'sourceSupport',
    'links',
    'priority',
    'reviewerId',
    'reviewStatus',
    'cardHash',
  ];
  return (
    hasExactKeys(value, fields) &&
    nonEmptyString(value.cardId) &&
    nonEmptyString(value.conceptId) &&
    typeof value.type === 'string' &&
    CARD_TYPES.has(value.type) &&
    nonEmptyString(value.topic) &&
    nonEmptyString(value.canonicalPoint) &&
    isPlainJson(value.approvedPayload) &&
    isBilingual(value.bilingual) &&
    stringList(value.useWhen, false) &&
    stringList(value.doNotUseWhen) &&
    stringList(value.sourceSupport, false) &&
    stringList(value.links) &&
    Number.isFinite(value.priority) &&
    nonEmptyString(value.reviewerId) &&
    value.reviewStatus === 'approved' &&
    /^[a-f0-9]{64}$/.test(String(value.cardHash))
  );
}

function isGlossaryEntry(
  value: unknown,
): value is ReviewedTeachingPackage['glossary'][number] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['conceptId', 'label', 'aliases']) ||
    !nonEmptyString(value.conceptId) ||
    !isRecord(value.label) ||
    !hasExactKeys(value.label, ['en', 'zh']) ||
    !nonEmptyString(value.label.en) ||
    !nonEmptyString(value.label.zh) ||
    !isRecord(value.aliases) ||
    !hasExactKeys(value.aliases, ['en', 'zh']) ||
    !stringList(value.aliases.en) ||
    !stringList(value.aliases.zh)
  )
    return false;
  return true;
}

function cardDigest(card: ReviewedTeachingCard): string {
  const content: Record<string, unknown> = { ...card };
  delete content.cardHash;
  return snapshotHash(content);
}

/**
 * Validates an offline reviewed package against a snapshot supplied by a trusted repository.
 * reviewerId is an audit label; this function does not authenticate reviewers or persist data.
 */
export function validateReviewedTeachingPackage(input: {
  courseId: string;
  releaseId: string;
  snapshot: { pages: SnapshotPage[] };
  candidate: unknown;
}): ReviewedPackageValidation {
  try {
    if (
      !nonEmptyString(input.courseId) ||
      !nonEmptyString(input.releaseId) ||
      !isPlainJson(input.candidate) ||
      !isRecord(input.candidate)
    )
      return { valid: false, reason: 'INVALID_PACKAGE' };

    const candidate = input.candidate;
    if (!hasExactKeys(candidate, ['manifest', 'sources', 'cards', 'glossary']))
      return { valid: false, reason: 'INVALID_PACKAGE' };
    const manifest = candidate.manifest;
    if (
      !isRecord(manifest) ||
      !hasExactKeys(manifest, [
        'courseId',
        'releaseId',
        'snapshotHash',
        'packageRevision',
        'schemaVersion',
        'buildVersion',
      ]) ||
      manifest.courseId !== input.courseId ||
      manifest.releaseId !== input.releaseId ||
      manifest.snapshotHash !== snapshotHash(input.snapshot) ||
      !Number.isSafeInteger(manifest.packageRevision) ||
      (manifest.packageRevision as number) < 1 ||
      manifest.schemaVersion !== 'tutor-package-v1' ||
      !nonEmptyString(manifest.buildVersion)
    )
      return { valid: false, reason: 'MANIFEST_MISMATCH' };

    if (
      !Array.isArray(candidate.sources) ||
      !Array.isArray(candidate.cards) ||
      !Array.isArray(candidate.glossary) ||
      candidate.sources.length === 0 ||
      candidate.cards.length === 0 ||
      candidate.glossary.length === 0
    )
      return { valid: false, reason: 'INVALID_PACKAGE' };
    const sources = new Map<string, AnchoredChunk>();
    for (const source of candidate.sources) {
      const verification = verifyAnchoredChunk({
        courseId: input.courseId,
        releaseId: input.releaseId,
        snapshot: input.snapshot,
        candidate: source,
      });
      if (!verification.valid)
        return { valid: false, reason: 'INVALID_SOURCE' };
      const anchorId = verification.chunk.anchor.id;
      if (sources.has(anchorId))
        return { valid: false, reason: 'DUPLICATE_ID' };
      sources.set(anchorId, verification.chunk);
    }

    const cards = new Map<string, ReviewedTeachingCard>();
    for (const card of candidate.cards) {
      if (!isCard(card)) return { valid: false, reason: 'INVALID_CARD' };
      if (cards.has(card.cardId))
        return { valid: false, reason: 'DUPLICATE_ID' };
      if (card.sourceSupport.some((id) => !sources.has(id)))
        return { valid: false, reason: 'SOURCE_NOT_FOUND' };
      if (cardDigest(card) !== card.cardHash)
        return { valid: false, reason: 'CARD_HASH_MISMATCH' };
      cards.set(card.cardId, card);
    }
    const glossary = new Map<
      string,
      ReviewedTeachingPackage['glossary'][number]
    >();
    for (const entry of candidate.glossary) {
      if (!isGlossaryEntry(entry))
        return { valid: false, reason: 'GLOSSARY_MISMATCH' };
      if (glossary.has(entry.conceptId))
        return { valid: false, reason: 'DUPLICATE_ID' };
      glossary.set(entry.conceptId, entry);
    }
    for (const card of cards.values()) {
      const entry = glossary.get(card.conceptId);
      if (
        !entry ||
        entry.label.en !== card.bilingual.conceptLabel.en ||
        entry.label.zh !== card.bilingual.conceptLabel.zh
      )
        return { valid: false, reason: 'GLOSSARY_MISMATCH' };
    }
    if (
      Array.from(cards.values()).some((card) =>
        card.links.some((id) => !cards.has(id)),
      )
    )
      return { valid: false, reason: 'LINK_NOT_FOUND' };

    const value: ReviewedTeachingPackage = {
      manifest: JSON.parse(
        JSON.stringify(manifest),
      ) as ReviewedTeachingPackage['manifest'],
      sources: Array.from(sources.values()).sort((a, b) =>
        compareIds(a.anchor.id, b.anchor.id),
      ),
      cards: JSON.parse(
        JSON.stringify(
          Array.from(cards.values()).sort((a, b) =>
            compareIds(a.cardId, b.cardId),
          ),
        ),
      ) as ReviewedTeachingCard[],
      glossary: JSON.parse(
        JSON.stringify(
          Array.from(glossary.values()).sort((a, b) =>
            compareIds(a.conceptId, b.conceptId),
          ),
        ),
      ) as ReviewedTeachingPackage['glossary'],
    };
    return {
      valid: true,
      value,
      packageHash: snapshotHash(value),
    };
  } catch {
    return { valid: false, reason: 'INVALID_PACKAGE' };
  }
}
