import { createHash } from 'node:crypto';

/** Canonical JSON encoding for snapshots used as version identifiers. */
export function canonicalSnapshot(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${Array.from(value, canonicalSnapshot).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null)
      throw new Error('snapshot must contain plain JSON objects');
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalSnapshot(object[key])}`)
      .join(',')}}`;
  }
  throw new Error('snapshot must contain JSON values');
}

export function snapshotHash(snapshot: unknown): string {
  return createHash('sha256').update(canonicalSnapshot(snapshot)).digest('hex');
}
