import { types } from 'node:util';
import type { ReviewedTeachingPackage } from './reviewed-package-validator';

const TURN_CATEGORIES = new Set([
  'factual_recall',
  'concept_framework',
  'interpretive_application',
  'submitted_answer',
]);

const SLICE_KEYS = [
  'turnCategory',
  'detectedFrame',
  'likelyIssue',
  'interpretiveLensId',
  'teachingMove',
  'currentTurnContract',
];

export interface TutorPlannerSlice {
  turnCategory:
    | 'factual_recall'
    | 'concept_framework'
    | 'interpretive_application'
    | 'submitted_answer';
  detectedFrame: string | null;
  likelyIssue: string | null;
  interpretiveLensId: string | null;
  teachingMove: string;
  currentTurnContract: {
    speechAct: string;
    responseLanguage: 'en-GB' | 'zh-CN';
    requiredTerms: string[];
    closeAfterResponse: boolean;
  };
}

export type PlannerSliceValidation =
  | { valid: true; value: TutorPlannerSlice }
  | {
      valid: false;
      reason:
        | 'INVALID_PLANNER_SLICE'
        | 'ACTION_CATEGORY_MISMATCH'
        | 'UNREGISTERED_KNOWLEDGE_ID'
        | 'UNREGISTERED_REQUIRED_TERM';
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    types.isProxy(value)
  )
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor?.enumerable && 'value' in descriptor);
  });
}

function isStringList(value: unknown): value is string[] {
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
    if (
      !descriptor?.enumerable ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'string' ||
      !descriptor.value.trim()
    )
      return false;
  }
  return keys.every(
    (key) =>
      key === 'length' ||
      (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key)),
  );
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function nullableId(value: unknown): value is string | null {
  return (
    value === null || (typeof value === 'string' && value.trim().length > 0)
  );
}

function normalizedTerm(value: string): string {
  return value.trim().toLocaleLowerCase('en-GB');
}

/** Validates Planner output against the action and IDs in the currently bound package. */
export function validatePlannerSlice(input: {
  candidate: unknown;
  action: 'study_question' | 'submitted_answer';
  teachingPackage: ReviewedTeachingPackage;
}): PlannerSliceValidation {
  if (input.action !== 'study_question' && input.action !== 'submitted_answer')
    return { valid: false, reason: 'INVALID_PLANNER_SLICE' };
  const value = input.candidate;
  if (
    !isRecord(value) ||
    !exactKeys(value, SLICE_KEYS) ||
    !TURN_CATEGORIES.has(String(value.turnCategory)) ||
    !nullableId(value.detectedFrame) ||
    !nullableId(value.likelyIssue) ||
    !nullableId(value.interpretiveLensId) ||
    typeof value.teachingMove !== 'string' ||
    !value.teachingMove.trim() ||
    !isRecord(value.currentTurnContract) ||
    !exactKeys(value.currentTurnContract, [
      'speechAct',
      'responseLanguage',
      'requiredTerms',
      'closeAfterResponse',
    ])
  )
    return { valid: false, reason: 'INVALID_PLANNER_SLICE' };

  const contract = value.currentTurnContract;
  if (
    typeof contract.speechAct !== 'string' ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(contract.speechAct) ||
    (contract.responseLanguage !== 'en-GB' &&
      contract.responseLanguage !== 'zh-CN') ||
    !isStringList(contract.requiredTerms) ||
    new Set(contract.requiredTerms.map(normalizedTerm)).size !==
      contract.requiredTerms.length ||
    typeof contract.closeAfterResponse !== 'boolean'
  )
    return { valid: false, reason: 'INVALID_PLANNER_SLICE' };

  const category = value.turnCategory as TutorPlannerSlice['turnCategory'];
  if (
    (input.action === 'submitted_answer') !==
    (category === 'submitted_answer')
  )
    return { valid: false, reason: 'ACTION_CATEGORY_MISMATCH' };

  const idsByType = new Map<string, Set<string>>();
  for (const card of input.teachingPackage.cards) {
    const ids = idsByType.get(card.type) ?? new Set<string>();
    ids.add(card.cardId);
    idsByType.set(card.type, ids);
  }
  const registered = (type: string, id: string | null) =>
    id === null || idsByType.get(type)?.has(id) === true;
  if (
    !registered('frame', value.detectedFrame) ||
    !registered('misreading', value.likelyIssue) ||
    !registered('lens', value.interpretiveLensId) ||
    !registered('teaching_move', value.teachingMove)
  )
    return { valid: false, reason: 'UNREGISTERED_KNOWLEDGE_ID' };

  const allowedTerms = new Set<string>();
  for (const entry of input.teachingPackage.glossary) {
    for (const term of [
      entry.label.en,
      entry.label.zh,
      ...entry.aliases.en,
      ...entry.aliases.zh,
    ])
      allowedTerms.add(normalizedTerm(term));
  }
  if (
    contract.requiredTerms.some(
      (term) => !allowedTerms.has(normalizedTerm(term)),
    )
  )
    return { valid: false, reason: 'UNREGISTERED_REQUIRED_TERM' };

  return {
    valid: true,
    value: {
      turnCategory: category,
      detectedFrame: value.detectedFrame,
      likelyIssue: value.likelyIssue,
      interpretiveLensId: value.interpretiveLensId,
      teachingMove: value.teachingMove,
      currentTurnContract: {
        speechAct: contract.speechAct,
        responseLanguage: contract.responseLanguage,
        requiredTerms: [...contract.requiredTerms],
        closeAfterResponse: contract.closeAfterResponse,
      },
    },
  };
}
