import { createHash } from 'node:crypto';
import { snapshotHash } from './snapshot-hash';

export interface SnapshotSourceAnchor {
  id: string;
  courseId: string;
  releaseId: string;
  pageId: string;
  headingPath: string[];
  start: number;
  end: number;
  hashEncoding: 'utf16le';
  excerptHash: string;
}

/** 位置使用 JavaScript UTF-16 code unit，与 String.slice 一致。 */
export function createSnapshotSourceAnchor(input: {
  courseId: string;
  releaseId: string;
  pageId: string;
  content: string;
  start: number;
  end: number;
  headingPath?: string[];
}): SnapshotSourceAnchor {
  const { courseId, releaseId, pageId, content, start, end } = input;
  const headingPath = [...(input.headingPath ?? [])];
  if (
    headingPath.some(
      (heading) => typeof heading !== 'string' || !heading.trim(),
    )
  )
    throw new Error('invalid heading path');
  if (![courseId, releaseId, pageId].every((id) => id.trim().length > 0))
    throw new Error('source identity must not be empty');
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > content.length
  )
    throw new Error('invalid source range');
  const splitsPair = (position: number): boolean => {
    if (position === 0 || position === content.length) return false;
    const before = content.charCodeAt(position - 1);
    const after = content.charCodeAt(position);
    return (
      before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
    );
  };
  if (splitsPair(start) || splitsPair(end))
    throw new Error('source range splits a surrogate pair');
  const excerptHash = createHash('sha256')
    .update(content.slice(start, end), 'utf16le')
    .digest('hex');
  const identity = {
    courseId,
    releaseId,
    pageId,
    headingPath,
    start,
    end,
    hashEncoding: 'utf16le' as const,
    excerptHash,
  };
  return { id: snapshotHash(identity), ...identity };
}
