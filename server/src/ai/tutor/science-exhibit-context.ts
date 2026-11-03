import { types } from 'node:util';
import { snapshotHash } from './snapshot-hash';

export interface ScienceExhibitSnapshot {
  stateVersion: number;
  state: unknown;
}

export interface RecomputedScienceContext {
  stateVersion: number;
  state: unknown;
  lastAction: unknown;
  displaySummary: string;
}

export interface ScienceExhibitAdapter {
  readonly exhibitId: string;
  loadCurrent(): Promise<ScienceExhibitSnapshot>;
  recompute(input: {
    current: ScienceExhibitSnapshot;
    requestedAction: unknown;
    studentFocus: string;
  }): Promise<RecomputedScienceContext | { rejected: string }>;
}

export type ScienceContextResolution =
  | {
      valid: true;
      context: {
        exhibit_id: string;
        state_version: number;
        state: unknown;
        last_action: unknown;
        display_summary: string;
        student_focus: string;
      };
    }
  | {
      valid: false;
      reason:
        | 'INVALID_REQUEST'
        | 'WRONG_EXHIBIT'
        | 'STALE_STATE_VERSION'
        | 'ACTION_REJECTED'
        | 'INVALID_RECOMPUTED_STATE'
        | 'ADAPTER_FAILED';
      detail?: string;
      currentStateVersion?: number;
    };

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

function isPlainJson(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || types.isProxy(value) || ancestors.has(value))
    return false;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes('length'))
      return false;
    ancestors.add(value);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        !descriptor?.enumerable ||
        !('value' in descriptor) ||
        !isPlainJson(descriptor.value, ancestors)
      )
        return false;
    }
    ancestors.delete(value);
    return true;
  }
  if (!isPlainDataRecord(value)) return false;
  ancestors.add(value);
  for (const child of Object.values(value)) {
    if (!isPlainJson(child, ancestors)) return false;
  }
  ancestors.delete(value);
  return true;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const keys = Object.keys(value).sort();
  const target = [...expected].sort();
  return (
    keys.length === target.length &&
    keys.every((key, index) => key === target[index])
  );
}

/** Resolve typed exhibit input using the current server state and a registered domain reducer. */
export async function resolveScienceExhibitContext(input: {
  candidate: unknown;
  adapter: ScienceExhibitAdapter;
}): Promise<ScienceContextResolution> {
  try {
    if (
      !isPlainDataRecord(input.candidate) ||
      !exactKeys(input.candidate, [
        'exhibit_id',
        'state_version',
        'last_action',
        'student_focus',
      ]) ||
      typeof input.candidate.exhibit_id !== 'string' ||
      !Number.isSafeInteger(input.candidate.state_version) ||
      (input.candidate.state_version as number) < 0 ||
      (input.candidate.last_action !== null &&
        !isPlainJson(input.candidate.last_action)) ||
      typeof input.candidate.student_focus !== 'string' ||
      input.candidate.student_focus.length > 8000
    )
      return { valid: false, reason: 'INVALID_REQUEST' };
    if (input.candidate.exhibit_id !== input.adapter.exhibitId)
      return { valid: false, reason: 'WRONG_EXHIBIT' };

    const current = await input.adapter.loadCurrent();
    if (
      !Number.isSafeInteger(current.stateVersion) ||
      current.stateVersion < 0 ||
      !isPlainJson(current.state)
    )
      return { valid: false, reason: 'ADAPTER_FAILED' };
    if (input.candidate.state_version !== current.stateVersion)
      return {
        valid: false,
        reason: 'STALE_STATE_VERSION',
        currentStateVersion: current.stateVersion,
      };

    const recomputed = await input.adapter.recompute({
      current,
      requestedAction: input.candidate.last_action,
      studentFocus: input.candidate.student_focus,
    });
    if ('rejected' in recomputed)
      return {
        valid: false,
        reason: 'ACTION_REJECTED',
        detail: recomputed.rejected,
      };
    const expectedVersion =
      input.candidate.last_action === null
        ? current.stateVersion
        : current.stateVersion + 1;
    if (
      recomputed.stateVersion !== expectedVersion ||
      (input.candidate.last_action === null &&
        (recomputed.lastAction !== null ||
          snapshotHash(recomputed.state) !== snapshotHash(current.state))) ||
      (input.candidate.last_action !== null &&
        recomputed.lastAction === null) ||
      !isPlainJson(recomputed.state) ||
      !isPlainJson(recomputed.lastAction) ||
      typeof recomputed.displaySummary !== 'string' ||
      recomputed.displaySummary.length > 2000
    )
      return { valid: false, reason: 'INVALID_RECOMPUTED_STATE' };
    return {
      valid: true,
      context: {
        exhibit_id: input.adapter.exhibitId,
        state_version: recomputed.stateVersion,
        state: JSON.parse(JSON.stringify(recomputed.state)) as unknown,
        last_action: JSON.parse(
          JSON.stringify(recomputed.lastAction),
        ) as unknown,
        display_summary: recomputed.displaySummary,
        student_focus: input.candidate.student_focus,
      },
    };
  } catch {
    return { valid: false, reason: 'ADAPTER_FAILED' };
  }
}
