import { types } from 'node:util';

export interface WeimarAppointmentState {
  presidentialAppointmentPower: boolean;
  presidentialAppointmentWillingness: number;
  parliamentaryCapacity: number;
  presidentialReliance: number;
  eliteAccommodation: number;
  naziPoliticalLeverage: number;
}

export type WeimarAppointmentGateResult =
  | {
      valid: true;
      eventId: 'E15';
      ruleId: 'W14';
      outcome: 'pathway_reproduced' | 'pathway_not_reproduced';
      conditions: Record<keyof WeimarAppointmentState, boolean>;
    }
  | { valid: false; reason: 'INVALID_STATE' };

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
    keys.length === target.length &&
    keys.every((key, index) => key === target[index])
  );
}

function isOrdinal(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 4
  );
}

/** Evaluates the documented teaching-model gate without assigning historical probabilities. */
export function evaluateWeimarAppointmentGate(
  input: unknown,
): WeimarAppointmentGateResult {
  try {
    if (
      !isPlainDataRecord(input) ||
      !hasExactKeys(input, [
        'presidentialAppointmentPower',
        'presidentialAppointmentWillingness',
        'parliamentaryCapacity',
        'presidentialReliance',
        'eliteAccommodation',
        'naziPoliticalLeverage',
      ]) ||
      typeof input.presidentialAppointmentPower !== 'boolean' ||
      !isOrdinal(input.presidentialAppointmentWillingness) ||
      !isOrdinal(input.parliamentaryCapacity) ||
      !isOrdinal(input.presidentialReliance) ||
      !isOrdinal(input.eliteAccommodation) ||
      !isOrdinal(input.naziPoliticalLeverage)
    )
      return { valid: false, reason: 'INVALID_STATE' };

    const conditions: Record<keyof WeimarAppointmentState, boolean> = {
      presidentialAppointmentPower: input.presidentialAppointmentPower,
      presidentialAppointmentWillingness:
        input.presidentialAppointmentWillingness >= 3,
      parliamentaryCapacity: input.parliamentaryCapacity <= 1,
      presidentialReliance: input.presidentialReliance >= 2,
      eliteAccommodation: input.eliteAccommodation >= 1,
      naziPoliticalLeverage: input.naziPoliticalLeverage >= 1,
    };
    return {
      valid: true,
      eventId: 'E15',
      ruleId: 'W14',
      outcome: Object.values(conditions).every(Boolean)
        ? 'pathway_reproduced'
        : 'pathway_not_reproduced',
      conditions,
    };
  } catch {
    return { valid: false, reason: 'INVALID_STATE' };
  }
}
