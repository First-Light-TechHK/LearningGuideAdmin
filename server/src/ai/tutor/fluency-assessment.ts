import { types } from 'node:util';

export type PragmaticsRubric = 'phase2_pragmatics_6' | 'fluency_pragmatics_9';

export interface FluencyAssessment {
  traceId: string;
  judgeId: string;
  rubricVersion: string;
  understanding: { score: number; scaleId: string };
  pragmatics: {
    rubric: PragmaticsRubric;
    dimensions: Array<{ id: string; score: number; passed: boolean }>;
  };
  hardFailures: string[];
}

export type FluencyAssessmentResult =
  | {
      valid: true;
      status: 'scored' | 'failed';
      understanding: FluencyAssessment['understanding'];
      pragmatics: FluencyAssessment['pragmatics'];
      hardFailures: string[];
    }
  | { valid: false; status: 'unscored'; reason: 'INVALID_ASSESSMENT' };

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
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

function hasExactKeys(value: Record<string, unknown>, expected: string[]) {
  const keys = Object.keys(value).sort();
  const target = [...expected].sort();
  return (
    keys.length === target.length && keys.every((key, i) => key === target[i])
  );
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || types.isProxy(value)) return false;
  if (Object.getPrototypeOf(value) !== Array.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length'))
    return false;
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    return Boolean(descriptor?.enumerable && 'value' in descriptor);
  }).every(Boolean);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Validates trace-backed evaluation structure without treating judge scores as truth. */
export function validateFluencyAssessment(
  input: unknown,
): FluencyAssessmentResult {
  try {
    if (
      !isPlainDataRecord(input) ||
      !hasExactKeys(input, [
        'traceId',
        'judgeId',
        'rubricVersion',
        'understanding',
        'pragmatics',
        'hardFailures',
      ]) ||
      !isNonEmptyString(input.traceId) ||
      !isNonEmptyString(input.judgeId) ||
      !isNonEmptyString(input.rubricVersion) ||
      !isPlainDataRecord(input.understanding) ||
      !hasExactKeys(input.understanding, ['score', 'scaleId']) ||
      typeof input.understanding.score !== 'number' ||
      !Number.isFinite(input.understanding.score) ||
      !isNonEmptyString(input.understanding.scaleId) ||
      !isPlainDataRecord(input.pragmatics) ||
      !hasExactKeys(input.pragmatics, ['rubric', 'dimensions']) ||
      (input.pragmatics.rubric !== 'phase2_pragmatics_6' &&
        input.pragmatics.rubric !== 'fluency_pragmatics_9') ||
      !isDenseArray(input.pragmatics.dimensions) ||
      !isDenseArray(input.hardFailures) ||
      !input.hardFailures.every(isNonEmptyString)
    )
      return { valid: false, status: 'unscored', reason: 'INVALID_ASSESSMENT' };

    const requiredCount =
      input.pragmatics.rubric === 'phase2_pragmatics_6' ? 6 : 9;
    if (input.pragmatics.dimensions.length !== requiredCount)
      return { valid: false, status: 'unscored', reason: 'INVALID_ASSESSMENT' };

    const seen = new Set<string>();
    const dimensions: FluencyAssessment['pragmatics']['dimensions'] = [];
    for (const value of input.pragmatics.dimensions) {
      if (
        !isPlainDataRecord(value) ||
        !hasExactKeys(value, ['id', 'score', 'passed']) ||
        !isNonEmptyString(value.id) ||
        seen.has(value.id) ||
        typeof value.score !== 'number' ||
        !Number.isFinite(value.score) ||
        typeof value.passed !== 'boolean'
      )
        return {
          valid: false,
          status: 'unscored',
          reason: 'INVALID_ASSESSMENT',
        };
      seen.add(value.id);
      dimensions.push({
        id: value.id,
        score: value.score,
        passed: value.passed,
      });
    }

    const understanding = {
      score: input.understanding.score,
      scaleId: input.understanding.scaleId,
    };
    const rubric = input.pragmatics.rubric;
    const pragmatics: FluencyAssessment['pragmatics'] = { rubric, dimensions };
    const hardFailures = [...input.hardFailures];
    return {
      valid: true,
      status: hardFailures.length > 0 ? 'failed' : 'scored',
      understanding,
      pragmatics,
      hardFailures,
    };
  } catch {
    return { valid: false, status: 'unscored', reason: 'INVALID_ASSESSMENT' };
  }
}
