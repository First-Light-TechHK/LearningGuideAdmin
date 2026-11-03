import {
  buildAnchoredChunks,
  type AnchoredChunk,
  type SnapshotPage,
} from './anchored-chunks';
import { canonicalSnapshot } from './snapshot-hash';
import { types } from 'node:util';

export type ChunkVerification =
  | { valid: true; chunk: AnchoredChunk }
  | {
      valid: false;
      reason: 'INVALID_CANDIDATE' | 'CHUNK_NOT_FOUND' | 'CHUNK_MISMATCH';
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

/** 调用方须从可信仓储获取快照并验证课程及 Release 的归属。 */
export function verifyAnchoredChunk(input: {
  courseId: string;
  releaseId: string;
  snapshot: { pages: SnapshotPage[] };
  candidate: unknown;
}): ChunkVerification {
  const candidates = buildAnchoredChunks(input);
  try {
    if (
      input.candidate === null ||
      typeof input.candidate !== 'object' ||
      Array.isArray(input.candidate) ||
      !isPlainJson(input.candidate)
    )
      return { valid: false, reason: 'INVALID_CANDIDATE' };
    const candidate = input.candidate as Record<string, unknown>;
    if (typeof candidate.id !== 'string' || !candidate.id)
      return { valid: false, reason: 'INVALID_CANDIDATE' };
    const expected = candidates.find((chunk) => chunk.id === candidate.id);
    if (!expected) return { valid: false, reason: 'CHUNK_NOT_FOUND' };
    return canonicalSnapshot(candidate) === canonicalSnapshot(expected)
      ? { valid: true, chunk: expected }
      : { valid: false, reason: 'CHUNK_MISMATCH' };
  } catch {
    return { valid: false, reason: 'INVALID_CANDIDATE' };
  }
}
