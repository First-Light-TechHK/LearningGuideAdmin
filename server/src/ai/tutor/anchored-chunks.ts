import {
  createSnapshotSourceAnchor,
  type SnapshotSourceAnchor,
} from './source-anchor';
import { snapshotHash } from './snapshot-hash';

const CHUNKER_VERSION = 'snapshot-window-v2';
const WINDOW = 3200;
const OVERLAP = 320;

export interface SnapshotPage {
  id: string;
  title: string;
  contentMd: string;
  sectionTags?: unknown;
}

export interface AnchoredChunk {
  id: string;
  snapshotHash: string;
  chunkerVersion: string;
  pageTitle: string;
  content: string;
  tokenCount: number;
  tokenCountMethod: 'utf16-length-divided-by-4';
  sourceCategory: 'unknown';
  anchor: SnapshotSourceAnchor;
}

export function buildReviewedExcerpt(input: {
  courseId: string;
  releaseId: string;
  snapshot: { pages: SnapshotPage[] };
  excerpt: string;
}): AnchoredChunk {
  const { courseId, releaseId, snapshot, excerpt } = input;
  if (!excerpt.trim() || excerpt.length > WINDOW)
    throw new Error('invalid reviewed excerpt length');
  const pages = snapshot.pages.filter((page) =>
    page.contentMd.includes(excerpt),
  );
  const page = pages[0];
  if (pages.length !== 1 || !page)
    throw new Error('reviewed excerpt must identify one snapshot page');
  const start = page.contentMd.indexOf(excerpt);
  if (page.contentMd.indexOf(excerpt, start + 1) !== -1)
    throw new Error('reviewed excerpt must identify one source range');
  const headingPath =
    headingPoints(page.contentMd).findLast((point) => point.offset <= start)
      ?.path ?? [];
  const anchor = createSnapshotSourceAnchor({
    courseId,
    releaseId,
    pageId: page.id,
    headingPath,
    content: page.contentMd,
    start,
    end: start + excerpt.length,
  });
  const digest = snapshotHash(snapshot);
  const chunkerVersion = 'reviewed-excerpt-v1';
  return {
    id: snapshotHash({
      snapshotHash: digest,
      chunkerVersion,
      anchorId: anchor.id,
    }),
    snapshotHash: digest,
    chunkerVersion,
    pageTitle: page.title,
    content: excerpt,
    tokenCount: Math.ceil(excerpt.length / 4),
    tokenCountMethod: 'utf16-length-divided-by-4',
    sourceCategory: 'unknown',
    anchor,
  };
}

function splitsPair(text: string, position: number): boolean {
  if (position <= 0 || position >= text.length) return false;
  const before = text.charCodeAt(position - 1);
  const after = text.charCodeAt(position);
  return (
    before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
  );
}

interface HeadingPoint {
  offset: number;
  path: string[];
}

function headingPoints(text: string): HeadingPoint[] {
  const result: HeadingPoint[] = [];
  const levels: string[] = [];
  let offset = 0;
  let fence: { char: string; length: number } | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      const char = marker[1][0];
      if (!fence) fence = { char, length: marker[1].length };
      else if (
        char === fence.char &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = undefined;
    } else if (!fence) {
      const match = /^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/.exec(line);
      if (match) {
        const title = match[2].replace(/[ \t]+#+[ \t]*$/, '').trim();
        if (title) {
          levels.length = match[1].length - 1;
          levels[match[1].length - 1] = title;
          result.push({ offset, path: levels.filter(Boolean) });
        }
      }
    }
    offset += raw.length + 1;
  }
  return result;
}

/** 不修改快照；使用可验证的原文范围而不是重组后的标题文本。 */
export function buildAnchoredChunks(input: {
  courseId: string;
  releaseId: string;
  snapshot: { pages: SnapshotPage[] };
}): AnchoredChunk[] {
  if (!input.courseId.trim() || !input.releaseId.trim())
    throw new Error('source identity must not be empty');
  if (!Array.isArray(input.snapshot.pages))
    throw new Error('snapshot pages must be an array');
  const digest = snapshotHash(input.snapshot);
  const ids = new Set<string>();
  const result: AnchoredChunk[] = [];
  for (const page of input.snapshot.pages) {
    if (
      !page ||
      typeof page.id !== 'string' ||
      !page.id.trim() ||
      ids.has(page.id) ||
      typeof page.title !== 'string' ||
      typeof page.contentMd !== 'string'
    )
      throw new Error('invalid or duplicate snapshot page');
    ids.add(page.id);
    const text = page.contentMd;
    if (!text.trim()) continue;
    const headings = headingPoints(text);
    let headingIndex = 0;
    let headingPath: string[] = [];
    let start = 0;
    while (start < text.length) {
      while (
        headingIndex < headings.length &&
        headings[headingIndex].offset <= start
      ) {
        headingPath = headings[headingIndex++].path;
      }
      let end = Math.min(start + WINDOW, text.length);
      if (end < text.length) {
        const lf = text.lastIndexOf('\n\n', end - 2);
        const crlf = text.lastIndexOf('\r\n\r\n', end - 4);
        const paragraphEnd = Math.max(
          lf < 0 ? -1 : lf + 2,
          crlf < 0 ? -1 : crlf + 4,
        );
        if (paragraphEnd >= start + WINDOW / 2) end = paragraphEnd;
      }
      if (splitsPair(text, end)) end--;
      const content = text.slice(start, end);
      const anchor = createSnapshotSourceAnchor({
        courseId: input.courseId,
        releaseId: input.releaseId,
        pageId: page.id,
        headingPath,
        content: text,
        start,
        end,
      });
      result.push({
        id: snapshotHash({
          snapshotHash: digest,
          chunkerVersion: CHUNKER_VERSION,
          anchorId: anchor.id,
        }),
        snapshotHash: digest,
        chunkerVersion: CHUNKER_VERSION,
        pageTitle: page.title,
        content,
        tokenCount: Math.ceil(content.length / 4),
        tokenCountMethod: 'utf16-length-divided-by-4',
        sourceCategory: 'unknown',
        anchor,
      });
      if (end === text.length) break;
      let next = end - OVERLAP;
      if (splitsPair(text, next)) next--;
      if (next <= start) throw new Error('chunker failed to advance');
      start = next;
    }
  }
  return result;
}
