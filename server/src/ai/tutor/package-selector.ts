import { types } from 'node:util';
import type { AnchoredChunk } from './anchored-chunks';
import type { TutorPlannerSlice } from './planner-slice';
import type {
  ReviewedTeachingCard,
  ReviewedTeachingPackage,
} from './reviewed-package-validator';

const TYPE_ORDER = [
  'lens',
  'frame',
  'misreading',
  'distinction',
  'concept',
  'source',
  'boundary',
  'rubric',
  'teaching_move',
];

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 4);
}

function isDenseArray(value: unknown): value is unknown[] {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length'))
    return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) return false;
  }
  return keys.every(
    (key) =>
      key === 'length' ||
      (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key)),
  );
}

function isScoreCandidate(
  value: unknown,
): value is { cardId: string; score: number } {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    types.isProxy(value)
  )
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes('cardId') || !keys.includes('score'))
    return false;
  const cardId = Object.getOwnPropertyDescriptor(value, 'cardId');
  const score = Object.getOwnPropertyDescriptor(value, 'score');
  return Boolean(
    cardId?.enumerable &&
    'value' in cardId &&
    typeof cardId.value === 'string' &&
    score?.enumerable &&
    'value' in score &&
    typeof score.value === 'number',
  );
}

function plannerRequiredIds(planner: TutorPlannerSlice): string[] {
  return [
    planner.detectedFrame,
    planner.likelyIssue,
    planner.interpretiveLensId,
    planner.teachingMove,
  ].filter((id): id is string => id !== null);
}

export type PackageSelection =
  | {
      valid: true;
      selectedCardIds: string[];
      selectedCards: ReviewedTeachingCard[];
      selectedSources: AnchoredChunk[];
      knowledgeText: string;
      citationAllowlist: Array<{ reference: string; title: string }>;
      excluded: Array<{
        cardId: string;
        reason: 'NOT_SELECTED' | 'TOKEN_BUDGET' | 'CARD_LIMIT';
      }>;
      tokenEstimate: number;
      tokenEstimateMethod: 'utf8-bytes-divided-by-4';
      requiredReferencesSatisfied: true;
    }
  | {
      valid: false;
      reason:
        | 'INVALID_CANDIDATES'
        | 'UNKNOWN_CANDIDATE'
        | 'REQUIRED_CARD_MISSING'
        | 'REQUIRED_CLOSURE_EXCEEDS_LIMIT'
        | 'REQUIRED_CLOSURE_EXCEEDS_BUDGET'
        | 'INSUFFICIENT_CARDS';
    };

/** Deterministic selector for candidate IDs returned by one bounded recall operation. */
export function selectPackageContext(input: {
  teachingPackage: ReviewedTeachingPackage;
  planner: TutorPlannerSlice;
  candidateScores: Array<{ cardId: string; score: number }>;
  minCards?: number;
  maxCards?: number;
  maxTokens?: number;
}): PackageSelection {
  const minCards = input.minCards ?? 2;
  const maxCards = input.maxCards ?? 5;
  const maxTokens = input.maxTokens ?? 1100;
  if (
    !Number.isSafeInteger(minCards) ||
    !Number.isSafeInteger(maxCards) ||
    minCards < 1 ||
    maxCards < minCards ||
    maxCards > 5 ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 1 ||
    !isDenseArray(input.candidateScores)
  )
    return { valid: false, reason: 'INVALID_CANDIDATES' };

  const cardsById = new Map(
    input.teachingPackage.cards.map((card) => [card.cardId, card]),
  );
  const sourcesById = new Map(
    input.teachingPackage.sources.map((source) => [source.anchor.id, source]),
  );
  const scoresById = new Map<string, number>();
  for (const candidate of input.candidateScores) {
    if (
      !isScoreCandidate(candidate) ||
      !candidate.cardId ||
      !Number.isFinite(candidate.score) ||
      candidate.score < 0 ||
      candidate.score > 1 ||
      scoresById.has(candidate.cardId)
    )
      return { valid: false, reason: 'INVALID_CANDIDATES' };
    if (!cardsById.has(candidate.cardId))
      return { valid: false, reason: 'UNKNOWN_CANDIDATE' };
    scoresById.set(candidate.cardId, candidate.score);
  }

  const selected = new Map<string, ReviewedTeachingCard>();
  const selectedSourceIds = new Set<string>();
  const closureFor = (
    rootId: string,
  ): Map<string, ReviewedTeachingCard> | null => {
    const pending = new Map<string, ReviewedTeachingCard>();
    const visit = (cardId: string): boolean => {
      if (selected.has(cardId) || pending.has(cardId)) return true;
      const card = cardsById.get(cardId);
      if (!card) return false;
      pending.set(cardId, card);
      for (const linkedId of card.links) if (!visit(linkedId)) return false;
      return true;
    };
    return visit(rootId) ? pending : null;
  };
  const addClosure = (
    rootId: string,
  ): 'added' | 'cards' | 'tokens' | 'missing' => {
    const closure = closureFor(rootId);
    if (!closure) return 'missing';
    const cards = Array.from(closure.values());
    const newSourceIds = new Set<string>();
    for (const card of cards) {
      for (const sourceId of card.sourceSupport) {
        if (!sourcesById.has(sourceId)) return 'missing';
        if (!selectedSourceIds.has(sourceId)) newSourceIds.add(sourceId);
      }
    }
    if (selected.size + cards.length > maxCards) return 'cards';
    const proposedCards = [...selected.values(), ...cards];
    const proposedSourceIds = new Set([...selectedSourceIds, ...newSourceIds]);
    const proposedText = renderKnowledge(
      proposedCards,
      Array.from(proposedSourceIds, (id) => sourcesById.get(id)!),
    ).knowledgeText;
    if (estimateTokens(proposedText) > maxTokens) return 'tokens';
    for (const card of cards) selected.set(card.cardId, card);
    for (const id of newSourceIds) selectedSourceIds.add(id);
    return 'added';
  };

  const requiredIds = [...new Set(plannerRequiredIds(input.planner))].sort(
    compareIds,
  );
  for (const id of requiredIds) {
    if (!cardsById.has(id))
      return { valid: false, reason: 'REQUIRED_CARD_MISSING' };
    const result = addClosure(id);
    if (result === 'missing')
      return { valid: false, reason: 'REQUIRED_CARD_MISSING' };
    if (result === 'cards')
      return { valid: false, reason: 'REQUIRED_CLOSURE_EXCEEDS_LIMIT' };
    if (result === 'tokens')
      return { valid: false, reason: 'REQUIRED_CLOSURE_EXCEEDS_BUDGET' };
  }

  const optional = Array.from(scoresById.entries())
    .filter(([id]) => !selected.has(id))
    .map(([id, score]) => ({ card: cardsById.get(id)!, score }))
    .sort(
      (a, b) =>
        a.card.priority - b.card.priority ||
        b.score - a.score ||
        compareIds(a.card.cardId, b.card.cardId),
    );
  const excludedReasons = new Map<
    string,
    'NOT_SELECTED' | 'TOKEN_BUDGET' | 'CARD_LIMIT'
  >();
  for (const { card } of optional) {
    const result = addClosure(card.cardId);
    if (result === 'tokens') excludedReasons.set(card.cardId, 'TOKEN_BUDGET');
    else if (result === 'cards') excludedReasons.set(card.cardId, 'CARD_LIMIT');
    else if (result === 'missing')
      excludedReasons.set(card.cardId, 'NOT_SELECTED');
  }
  if (selected.size < minCards)
    return { valid: false, reason: 'INSUFFICIENT_CARDS' };

  const orderedCards = Array.from(selected.values()).sort(
    (a, b) =>
      TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) ||
      a.priority - b.priority ||
      compareIds(a.cardId, b.cardId),
  );
  const orderedSources = Array.from(selectedSourceIds, (id) =>
    sourcesById.get(id)!,
  ).sort((a, b) => compareIds(a.anchor.id, b.anchor.id));
  const rendered = renderKnowledge(orderedCards, orderedSources);
  const selectedIds = new Set(selected.keys());
  return {
    valid: true,
    selectedCardIds: orderedCards.map((card) => card.cardId),
    selectedCards: orderedCards,
    selectedSources: orderedSources,
    knowledgeText: rendered.knowledgeText,
    citationAllowlist: rendered.citationAllowlist,
    excluded: Array.from(scoresById.keys())
      .filter((id) => !selectedIds.has(id))
      .map((cardId) => ({
        cardId,
        reason: excludedReasons.get(cardId) ?? 'NOT_SELECTED',
      }))
      .sort((a, b) => compareIds(a.cardId, b.cardId)),
    tokenEstimate: estimateTokens(rendered.knowledgeText),
    tokenEstimateMethod: 'utf8-bytes-divided-by-4',
    requiredReferencesSatisfied: true,
  };
}

function renderKnowledge(
  cards: ReviewedTeachingCard[],
  sources: AnchoredChunk[],
) {
  const sourceRefs = new Map<string, string>();
  const citationAllowlist = sources.map((source, index) => {
    const reference = `S${index + 1}`;
    sourceRefs.set(source.anchor.id, reference);
    return {
      reference,
      title: [source.pageTitle, ...source.anchor.headingPath]
        .filter(Boolean)
        .join(' — '),
    };
  });
  const knowledgeText = JSON.stringify({
    cards: cards.map((card) => ({
      topic: card.topic,
      canonicalPoint: card.canonicalPoint,
      summary: card.bilingual.summary,
      approvedPayload: card.approvedPayload,
      useWhen: card.useWhen,
      doNotUseWhen: card.doNotUseWhen,
      sources: card.sourceSupport.map((id) => sourceRefs.get(id)),
    })),
    evidence: sources.map((source, index) => ({
      reference: `S${index + 1}`,
      title: [source.pageTitle, ...source.anchor.headingPath]
        .filter(Boolean)
        .join(' — '),
      excerpt: source.content,
    })),
  });
  return { knowledgeText, citationAllowlist };
}
