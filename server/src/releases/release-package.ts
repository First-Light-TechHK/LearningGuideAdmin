import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import JSZip from 'jszip';
import { Readable } from 'node:stream';
import { MAX_IMAGE_UPLOAD_BYTES } from '../files/knowledge-image';
import {
  wikiTeachingReferenceIds,
  teachingReferenceCatalogue,
} from '../ks/contract/teaching-references';
import {
  mergeApprovedCards,
  teachingPackageBase,
} from './teaching-card-publication';
import type { TeachingPackageCompiler } from '../ks/contract/teaching-package-compiler';

export const PACKAGE_BYTES = 64 * 1024 * 1024;
const JSON_BYTES = 12 * 1024 * 1024;
const imageName = /^[a-f0-9-]{36}\.(png|jpg|gif|webp)$/i;
const key = /^[a-zA-Z0-9_-]{1,150}$/;
export const sha256 = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');
export function invalid(message: string): never {
  throw new BadRequestException(message);
}
function object(value: unknown): Prisma.JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('版本包缺少有效的对象');
  return value;
}
function list(value: unknown): Prisma.JsonValue[] {
  if (!Array.isArray(value)) invalid('版本包缺少有效的列表');
  return value as Prisma.JsonValue[];
}
function string(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0'))
    invalid('版本包文本字段无效');
  return value;
}
function id(value: unknown) {
  const s = string(value);
  if (!key.test(s)) invalid('版本包标识无效');
  return s;
}
function integer(value: unknown) {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < -2147483648 ||
    value > 2147483647
  )
    invalid('版本包整数无效');
  return value;
}
function date(value: unknown) {
  if (value === null) return null;
  const s = string(value);
  if (!Number.isFinite(Date.parse(s))) invalid('版本包日期无效');
  return s;
}
function unique(keys: string[], label: string) {
  if (new Set(keys).size !== keys.length) invalid('版本包包含重复的' + label);
}
export function contentOf(value: unknown) {
  const s = object(value);
  if (!s.editor || object(s.editor).version !== 1)
    invalid('此版本缺少可迁移的编辑快照');
  const editor = object(s.editor);
  const pages = list(editor.pages).map((raw) => {
    const p = object(raw);
    if (p.syncState !== 'SYNCED' && p.syncState !== 'STALE')
      invalid('页面同步状态无效');
    return {
      id: id(p.id),
      title: string(p.title),
      contentMd: string(p.contentMd),
      externalId: p.externalId == null ? null : string(p.externalId),
      sortOrder: integer(p.sortOrder),
      syncState: p.syncState,
      sectionTags: p.sectionTags ?? null,
    };
  });
  const cards = list(editor.cards).map((raw) => {
    const c = object(raw);
    return {
      id: id(c.id),
      draft: object(c.draft),
      approved: c.approved == null ? null : object(c.approved),
      revision: integer(c.revision),
      approvedRevision:
        c.approvedRevision == null ? null : integer(c.approvedRevision),
      reviewerId: c.reviewerId == null ? null : string(c.reviewerId),
      deletedAt: date(c.deletedAt),
      createdAt: date(c.createdAt),
      additionPosition: integer(c.additionPosition),
    };
  });
  unique(
    pages.map((p) => p.id),
    '页面',
  );
  unique(
    cards.map((c) => c.id),
    '条目',
  );
  unique(
    pages.flatMap((p) => (p.externalId === null ? [] : [p.externalId])),
    '课节绑定',
  );
  return {
    editor: { version: 1, pages, cards },
    teachingPackageBase: teachingPackageBase(s) ?? null,
    teachingPackageInput:
      s.teachingPackageInput == null ? null : object(s.teachingPackageInput),
  };
}
export type Content = ReturnType<typeof contentOf>;
type IdMaps = {
  pages: Record<string, string>;
  cards: Record<string, string>;
  images: Record<string, string>;
};
export interface Origin {
  courseId: string;
  releaseId: string;
  externalId: string | null;
  commerceCode: string | null;
}
export interface Transfer {
  origin: Origin;
  mapping: IdMaps;
}
export function makeMapping(
  content: Content,
  origin: Origin,
  target: string,
): IdMaps {
  function mapped(kind: string, value: string) {
    if (origin.courseId === target) return value;
    const hash = sha256(JSON.stringify([origin.courseId, target, kind, value]));
    return [
      hash.slice(0, 8),
      hash.slice(8, 12),
      '5' + hash.slice(13, 16),
      'a' + hash.slice(17, 20),
      hash.slice(20, 32),
    ].join('-');
  }
  return {
    pages: Object.fromEntries(
      content.editor.pages.map((p) => [p.id, mapped('page', p.id)]),
    ),
    cards: Object.fromEntries(
      content.editor.cards.map((c) => [c.id, mapped('card', c.id)]),
    ),
    images: {},
  };
}
export function reverseMapping(m: IdMaps): IdMaps {
  const reverse = (values: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(values).map(([a, b]) => [b, a]),
    ) as Record<string, string>;
  return {
    pages: reverse(m.pages),
    cards: reverse(m.cards),
    images: reverse(m.images),
  };
}
const lookup = (map: Record<string, string>, k: string) =>
  Object.hasOwn(map, k) ? map[k] : k;
export function translate(
  content: Content,
  source: string,
  target: string,
  m: IdMaps,
  assets: Set<string>,
) {
  const image = (name: string) => {
    if (!imageName.test(name)) invalid('课程图片文件名无效：' + name);
    assets.add(name);
    return lookup(m.images, name);
  };
  function prose(text: string) {
    let fence = '';
    return text
      .split('\n')
      .map((line) => {
        const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line);
        if (fence) {
          if (
            marker &&
            marker[1][0] === fence[0] &&
            marker[1].length >= fence.length &&
            !marker[2].trim()
          )
            fence = '';
          return line;
        }
        if (marker) {
          fence = marker[1];
          return line;
        }
        if (/^(?: {4}|\t)/.test(line)) return line;
        return line.replace(
          /(`+)(.*?)\1|([^\x60]+)/g,
          (part: string, ticks: string | undefined) =>
            ticks
              ? part
              : part
                  .replace(
                    /(\]\(refobj:)([a-z0-9-]+)(?=\))/g,
                    (_, prefix: string, k: string) =>
                      prefix + lookup(m.cards, k),
                  )
                  .replace(
                    /((?:\]\(\s*<?|src=["']|^\s*\[[^\]\n]+\]:\s*<?))(?:https?:\/\/[^/\s)]+)?\/api\/files\/images\/([^/\s)]+)\/([^)\s<>"']+)/gim,
                    (_, prefix: string, owner: string, name: string) => {
                      if (owner !== source)
                        invalid('版本中存在跨课程图片：' + owner + '/' + name);
                      return (
                        prefix +
                        '/api/files/images/' +
                        target +
                        '/' +
                        image(name)
                      );
                    },
                  ),
        );
      })
      .join('\n');
  }
  function walk(v: unknown, field = ''): unknown {
    if (typeof v === 'string') {
      if (field === 'sourcePageId') return lookup(m.pages, v);
      if (['cardId', 'conceptId', 'links', 'requires'].includes(field))
        return lookup(m.cards, v);
      return prose(v);
    }
    if (Array.isArray(v)) return (v as unknown[]).map((x) => walk(x, field));
    if (v === null || typeof v !== 'object') return v;
    const obj = object(v);
    return Object.fromEntries(
      Object.entries(obj).map(([k, x]) => {
        if (
          k === 'id' &&
          typeof x === 'string' &&
          (obj.kind === 'image' || obj.kind === 'latex')
        )
          return [k, lookup(m.cards, x)];
        if (k === 'value' && obj.kind === 'image') return [k, image(string(x))];
        return [k, walk(x, k)];
      }),
    );
  }
  const pages = content.editor.pages.map((p) => ({
    ...p,
    id: lookup(m.pages, p.id),
    contentMd: prose(p.contentMd),
  }));
  const cards = content.editor.cards.map((c) => ({
    ...c,
    id: lookup(m.cards, c.id),
    draft: object(walk(c.draft)),
    approved: c.approved && object(walk(c.approved)),
  }));
  return {
    ...content,
    editor: { version: 1, pages, cards },
    teachingPackageBase:
      content.teachingPackageBase && object(walk(content.teachingPackageBase)),
    teachingPackageInput:
      content.teachingPackageInput &&
      object(walk(content.teachingPackageInput)),
  };
}
export function published(content: Content) {
  return content.editor.pages
    .filter((p) => p.syncState === 'SYNCED')
    .map(({ id, title, contentMd, sectionTags }) => ({
      id,
      title,
      contentMd,
      sectionTags,
    }));
}
export function rebuild(
  content: Content,
  courseId: string,
  releaseId: string,
  compile: TeachingPackageCompiler,
) {
  const pages = published(content);
  try {
    const authored = content.teachingPackageInput;
    const refs = teachingReferenceCatalogue(authored ?? undefined);
    const editorRefs = new Set(refs.keys());
    const activeCards = content.editor.cards.filter((card) => !card.deletedAt);
    for (const card of activeCards) {
      const payload = card.draft.approvedPayload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        continue;
      if (Array.isArray(payload.refObjects))
        for (const item of payload.refObjects) {
          if (
            item &&
            typeof item === 'object' &&
            !Array.isArray(item) &&
            typeof item.id === 'string'
          )
            editorRefs.add(item.id);
        }
    }
    const verifyLinks = (
      label: string,
      text: string,
      available: Pick<ReadonlySet<string>, 'has'>,
    ) => {
      for (const ref of wikiTeachingReferenceIds(text)) {
        if (!available.has(ref))
          invalid('页面「' + label + '」引用不存在：' + ref);
      }
    };
    for (const page of content.editor.pages)
      verifyLinks(
        page.title,
        page.contentMd,
        page.syncState === 'SYNCED' ? refs : editorRefs,
      );
    for (const card of activeCards) {
      const payload = card.draft.approvedPayload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        continue;
      if (typeof payload.answerMd === 'string')
        verifyLinks(card.id, payload.answerMd, editorRefs);
      if (
        typeof payload.sourcePageId === 'string' &&
        payload.sourcePageId &&
        !content.editor.pages.some((p) => p.id === payload.sourcePageId)
      )
        invalid('定义的来源页不存在：' + card.id);
    }
    // 草稿与审批分别保留。发布态使用同一版本的审批修订和基础包。
    const inferred = mergeApprovedCards(
      content.teachingPackageBase ?? undefined,
      content.editor.cards.map((c) => ({
        ...c,
        deletedAt: c.deletedAt ? new Date(c.deletedAt) : null,
      })),
    );
    if (canonical(inferred ?? null) !== canonical(authored))
      invalid('编辑快照与该版本的教学包输入不一致');
    const pkg = authored
      ? compile({ courseId, releaseId, snapshot: { pages }, authored })
          .teachingPackage
      : null;
    const revisions = content.editor.cards
      .filter((c) => !c.deletedAt && c.approved && c.approvedRevision !== null)
      .map((c) => ({
        id: c.id,
        reviewerId: c.reviewerId,
        revision: c.approvedRevision,
      }));
    return {
      pages,
      editor: content.editor,
      ...(content.teachingPackageBase
        ? { teachingPackageBase: content.teachingPackageBase }
        : {}),
      ...(pkg
        ? {
            teachingPackage: pkg,
            teachingPackageBase: content.teachingPackageBase,
            teachingPackageInput: authored,
            teachingCardRevisions: revisions,
          }
        : {}),
    };
  } catch (e) {
    invalid('版本校验失败：' + (e instanceof Error ? e.message : '教学包无效'));
  }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value))
    return '[' + (value as unknown[]).map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(object(value))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export const fileSummary = (assets: Map<string, Buffer>) =>
  Object.fromEntries(
    [...assets].map(([name, b]) => [name, sha256(b)]),
  ) as Record<string, string>;
export interface Manifest {
  format: 'knowledge-release-v1';
  origin: Origin;
  versionTag: string;
  revisionNotes: string;
  content: Content;
  images: Record<string, string>;
}
export async function pack(manifest: Manifest, images: Map<string, Buffer>) {
  const zip = new JSZip();
  const json = canonical(manifest);
  if (Buffer.byteLength(json) > JSON_BYTES)
    throw new PayloadTooLargeException();
  zip.file('manifest.json', json);
  zip.file('manifest.sha256', sha256(json));
  for (const [k, b] of images)
    zip.file('images/' + k, b, { createFolders: false });
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'STORE',
  });
  if (buffer.length > PACKAGE_BYTES) throw new PayloadTooLargeException();
  return buffer;
}
async function bounded(entry: JSZip.JSZipObject, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of new Readable().wrap(entry.nodeStream())) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > limit) throw new PayloadTooLargeException();
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}
export async function unpack(buffer: Buffer) {
  if (!buffer?.length || buffer.length > PACKAGE_BYTES)
    invalid('请选择有效的知识版本 ZIP');
  try {
    const zip = await JSZip.loadAsync(buffer);
    const entries = Object.values(zip.files);
    if (
      entries.length > 4096 ||
      entries.some((e) => e.dir || e.unsafeOriginalName !== e.name)
    )
      invalid('版本包文件路径无效');
    const mf = zip.file('manifest.json'),
      checksum = zip.file('manifest.sha256');
    if (!mf || !checksum) invalid('缺少版本包清单。请选择可迁移版本 ZIP。');
    const bytes = await bounded(mf, JSON_BYTES);
    if (sha256(bytes) !== (await bounded(checksum, 64)).toString())
      invalid('版本包清单摘要不一致');
    const raw = object(JSON.parse(bytes.toString('utf8')) as unknown);
    if (raw.format !== 'knowledge-release-v1') invalid('不支持的版本包格式');
    const origin = object(raw.origin);
    const content = contentOf(raw.content);
    const images = new Map<string, Buffer>();
    let remaining = PACKAGE_BYTES - bytes.length;
    for (const [k, hash] of Object.entries(object(raw.images))) {
      const entry = zip.file('images/' + k);
      if (!imageName.test(k) || !entry) invalid('缺少或无效的图片：' + k);
      const data = await bounded(
        entry,
        Math.min(MAX_IMAGE_UPLOAD_BYTES, remaining),
      );
      if (sha256(data) !== hash) invalid('图片摘要不一致：' + k);
      remaining -= data.length;
      images.set(k, data);
    }
    if (entries.length !== images.size + 2) invalid('版本包包含未登记文件');
    const manifest: Manifest = {
      format: 'knowledge-release-v1',
      origin: {
        courseId: id(origin.courseId),
        releaseId: id(origin.releaseId),
        externalId:
          origin.externalId == null ? null : string(origin.externalId),
        commerceCode:
          origin.commerceCode == null ? null : string(origin.commerceCode),
      },
      versionTag: string(raw.versionTag),
      revisionNotes: string(raw.revisionNotes),
      content,
      images: fileSummary(images),
    };
    return { manifest, images };
  } catch (e) {
    if (
      e instanceof BadRequestException ||
      e instanceof PayloadTooLargeException
    )
      throw e;
    invalid('知识版本 ZIP 无效或已损坏');
  }
}
