export const VALIDATOR_ACTIONS = [
  'ACCEPT',
  'CLARIFY',
  'REDIRECT',
  'REFUSE_INT',
  'REFUSE_POL',
] as const;

export type ValidatorAction = (typeof VALIDATOR_ACTIONS)[number];

export interface ValidatorUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ValidatorResult {
  action: ValidatorAction;
  shortCircuitTutor: boolean;
  confidence: number;
  reasonCode: string;
  ruleVersion: string;
  classifierVersion: string;
  latencyMs: number;
  usage?: ValidatorUsage;
}

export interface ValidatorRule {
  reasonCode: string;
  evaluate: (text: string) => ValidatorRuleMatch | null;
}

export interface ValidatorRuleMatch {
  action: ValidatorAction;
  confidence: number;
}

type ClassifierAction =
  ValidatorAction | 'REFUSE_ACADEMIC_INTEGRITY' | 'REFUSE_POLICY_ABUSE';

interface ClassifierResult {
  action: ClassifierAction;
  confidence: number;
  reasonCode: string;
  usage?: ValidatorUsage;
}

const ACTION_MAP: Record<ClassifierAction, ValidatorAction> = {
  ACCEPT: 'ACCEPT',
  CLARIFY: 'CLARIFY',
  REDIRECT: 'REDIRECT',
  REFUSE_INT: 'REFUSE_INT',
  REFUSE_POL: 'REFUSE_POL',
  REFUSE_ACADEMIC_INTEGRITY: 'REFUSE_INT',
  REFUSE_POLICY_ABUSE: 'REFUSE_POL',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || types.isProxy(value))
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isRule(value: unknown): value is ValidatorRule {
  if (!isRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2 ||
    !keys.includes('reasonCode') ||
    !keys.includes('evaluate')
  )
    return false;
  const reasonCode = Object.getOwnPropertyDescriptor(value, 'reasonCode');
  const evaluate = Object.getOwnPropertyDescriptor(value, 'evaluate');
  return Boolean(
    reasonCode?.enumerable &&
    'value' in reasonCode &&
    typeof reasonCode.value === 'string' &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(reasonCode.value) &&
    evaluate?.enumerable &&
    'value' in evaluate &&
    typeof evaluate.value === 'function',
  );
}

function isRuleList(value: unknown): value is readonly ValidatorRule[] {
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
      !isRule(descriptor.value)
    )
      return false;
  }
  return keys.every(
    (key) =>
      key === 'length' ||
      (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key)),
  );
}

function isUsage(value: unknown): value is ValidatorUsage {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.every((key) => key === 'inputTokens' || key === 'outputTokens') &&
    keys.every(
      (key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0,
    )
  );
}

function parseClassifierResult(value: unknown): ClassifierResult | null {
  if (!isRecord(value)) return null;
  const allowedKeys = ['action', 'confidence', 'reasonCode', 'usage'];
  const keys = Object.keys(value);
  if (
    keys.some((key) => !allowedKeys.includes(key)) ||
    !keys.includes('action') ||
    !keys.includes('confidence') ||
    !keys.includes('reasonCode') ||
    typeof value.action !== 'string' ||
    !Object.hasOwn(ACTION_MAP, value.action) ||
    typeof value.confidence !== 'number' ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1 ||
    typeof value.reasonCode !== 'string' ||
    !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.reasonCode) ||
    (value.usage !== undefined && !isUsage(value.usage))
  )
    return null;
  return value as unknown as ClassifierResult;
}

function result(input: {
  action: ValidatorAction;
  confidence: number;
  reasonCode: string;
  ruleVersion: string;
  classifierVersion: string;
  startedAt: number;
  now: () => number;
  usage?: ValidatorUsage;
}): ValidatorResult {
  return {
    action: input.action,
    shortCircuitTutor: input.action !== 'ACCEPT',
    confidence: input.confidence,
    reasonCode: input.reasonCode,
    ruleVersion: input.ruleVersion,
    classifierVersion: input.classifierVersion,
    latencyMs: Math.max(0, input.now() - input.startedAt),
    ...(input.usage ? { usage: input.usage } : {}),
  };
}

/** Rules-first validator orchestration. It does not call the Tutor or perform retrieval. */
export async function validateTutorTurn(input: {
  text: string;
  rules: readonly ValidatorRule[];
  ruleVersion: string;
  classifierVersion: string;
  minimumConfidence: number;
  classify: (text: string) => Promise<unknown>;
  now?: () => number;
}): Promise<ValidatorResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const base = {
    ruleVersion: input.ruleVersion,
    classifierVersion: input.classifierVersion,
    startedAt,
    now,
  };
  const validRules = isRuleList(input.rules);
  if (
    typeof input.text !== 'string' ||
    input.text.trim().length === 0 ||
    input.text.length > 8000 ||
    !Number.isFinite(input.minimumConfidence) ||
    input.minimumConfidence < 0 ||
    input.minimumConfidence > 1 ||
    !input.ruleVersion ||
    !input.classifierVersion ||
    !validRules
  )
    return result({
      ...base,
      action: 'CLARIFY',
      confidence: 0,
      reasonCode: !validRules ? 'INVALID_RULES' : 'INVALID_VALIDATOR_INPUT',
    });

  for (const rule of input.rules) {
    let match: ValidatorRuleMatch | null;
    try {
      match = rule.evaluate(input.text);
    } catch {
      return result({
        ...base,
        action: 'CLARIFY',
        confidence: 0,
        reasonCode: 'RULE_EVALUATION_FAILED',
      });
    }
    if (!match) continue;
    if (
      !VALIDATOR_ACTIONS.includes(match.action) ||
      !Number.isFinite(match.confidence) ||
      match.confidence < 0 ||
      match.confidence > 1 ||
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(rule.reasonCode)
    )
      return result({
        ...base,
        action: 'CLARIFY',
        confidence: 0,
        reasonCode: 'INVALID_RULE_RESULT',
      });
    return result({
      ...base,
      action: match.action,
      confidence: match.confidence,
      reasonCode: rule.reasonCode,
    });
  }

  let parsed: ClassifierResult | null;
  try {
    parsed = parseClassifierResult(await input.classify(input.text));
  } catch {
    parsed = null;
  }
  if (!parsed)
    return result({
      ...base,
      action: 'CLARIFY',
      confidence: 0,
      reasonCode: 'CLASSIFIER_UNAVAILABLE_OR_INVALID',
    });
  const action = ACTION_MAP[parsed.action];
  if (parsed.confidence < input.minimumConfidence)
    return result({
      ...base,
      action: 'CLARIFY',
      confidence: parsed.confidence,
      reasonCode: 'LOW_CONFIDENCE',
      ...(parsed.usage ? { usage: parsed.usage } : {}),
    });
  return result({
    ...base,
    action,
    confidence: parsed.confidence,
    reasonCode: parsed.reasonCode,
    ...(parsed.usage ? { usage: parsed.usage } : {}),
  });
}
import { types } from 'node:util';
