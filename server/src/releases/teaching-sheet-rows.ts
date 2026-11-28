import type { Prisma } from '@prisma/client';
import {
  teachingReferenceCatalogue,
  wikiTeachingReferenceIds,
} from '../ks/contract/teaching-references';
import type { SheetKind } from './teaching-import-files';
import { createHash } from 'node:crypto';
import type { LectureReference } from '../ks/contract/teaching-references';

export type SheetRow = {
  row: number;
  values: string[];
  errors: number[];
  sourceOmitted?: boolean;
  dependencies?: ReadonlyMap<string, string>;
};
export const cellKey = (value: string) =>
  value.trim().normalize('NFKC').replace(/\s+/g, ' ').toLowerCase();

function record(value: Prisma.JsonValue | undefined): Prisma.JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}
function text(value: Prisma.JsonValue | undefined) {
  return typeof value === 'string' ? value : '';
}

export function teachingCells(kind: SheetKind, value: Prisma.JsonValue) {
  const card = record(value);
  if (card.type !== kind) return null;
  const payload = record(card.approvedPayload);
  const bilingual = record(card.bilingual);
  const labels = record(bilingual.conceptLabel);
  const summaries = record(bilingual.summary);
  const triggers = record(bilingual.triggers);
  if (kind === 'concept') {
    return [
      text(payload.definitionName) || text(labels.en) || text(labels.zh),
      Array.isArray(card.evidence) ? text(card.evidence[0]) : '',
      text(payload.answerMd) ||
        text(card.canonicalPoint) ||
        text(summaries.en) ||
        text(summaries.zh),
    ];
  }
  return [
    text(payload.question) ||
      (Array.isArray(triggers.zh) && text(triggers.zh[0])) ||
      (Array.isArray(triggers.en) && text(triggers.en[0])) ||
      text(labels.en) ||
      text(labels.zh),
    text(payload.answerMd),
  ];
}

export function sheetReferences(authored: Record<string, unknown> | undefined) {
  const ids = teachingReferenceCatalogue(authored);
  const codes = new Map<string, Set<string>>();
  function add(code: string, id: string) {
    const key = cellKey(code);
    const matches = codes.get(key) ?? new Set<string>();
    matches.add(id);
    codes.set(key, matches);
  }
  for (const ref of ids.values()) if (ref.code) add(ref.code, ref.id);
  for (const raw of Array.isArray(authored?.cards)
    ? (authored.cards as Prisma.JsonValue[])
    : []) {
    const card = record(raw);
    const aliases = record(card.approvedPayload).aliases;
    if (
      card.type !== 'ref_obj' ||
      typeof card.cardId !== 'string' ||
      !ids.has(card.cardId) ||
      !Array.isArray(aliases)
    )
      continue;
    for (const alias of aliases)
      if (typeof alias === 'string') add(alias, card.cardId);
  }
  return { ids, codes };
}

type Page = { id: string; title: string; contentMd: string };
type References = ReturnType<typeof sheetReferences>;
export type RefFingerprints = ReadonlyMap<string, string>;
export const transferHash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
export async function fingerprintReference(
  ref: LectureReference,
  getImage: (name: string) => Promise<Buffer | undefined>,
) {
  const value = ref.kind === 'latex' ? ref.value : await getImage(ref.value);
  return value === undefined ? undefined : transferHash(value);
}

function inProse(value: string, replace: (line: string) => string) {
  let fence = '';
  return value
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
      return line
        .split(/(`+[^\x60]*`+)/)
        .map((part, i) => (i % 2 ? part : replace(part)))
        .join('');
    })
    .join('\n');
}
export function prepareSheetRow(
  kind: SheetKind,
  row: SheetRow,
  pages: Page[],
  refs: References,
  previous?: Prisma.JsonValue,
  fingerprints?: RefFingerprints,
) {
  const definition = kind === 'concept';
  const [name, excerptOrAnswer, definitionBody] = row.values.map((value) =>
    value.trim(),
  );
  const body = definition ? definitionBody : excerptOrAnswer;
  const last = definition ? 2 : 1;
  const limits = definition ? [100, 3200, 12000] : [400, 12000];
  const issues: { column: number; code: string; detail?: string }[] =
    row.errors.map((column) => ({ column, code: 'textOnly' }));
  for (const [column, limit] of limits.entries()) {
    if (issues.some((issue) => issue.column === column)) continue;
    const value = row.values[column]?.trim();
    if (definition && column === 1 && !value) continue;
    if (!value) issues.push({ column, code: 'required' });
    else if (value.length > limit || value.includes('\0'))
      issues.push({ column, code: 'length' });
  }
  const bindings = new Map<string, LectureReference>();
  const checkRef = (id: string | undefined, column: number, code: string) => {
    const ref = id ? refs.ids.get(id) : undefined;
    if (!ref) {
      issues.push({ column, code: 'missingReference', detail: code });
      return undefined;
    }
    const expected = row.dependencies?.get(cellKey(code));
    if (expected && fingerprints?.get(ref.id) !== expected)
      issues.push({ column, code: 'referenceChanged', detail: code });
    bindings.set(ref.id, ref);
    return ref;
  };
  const resolve = (value: string, column: number) =>
    inProse(value, (part) =>
      part.replace(
        /\[([^\]\n]+)\]\(refcode:([^\s)]+)\)|\{\{(?:ref|引用)\s*:\s*([^{}\r\n]+)\}\}/gi,
        (
          original: string,
          label: string | undefined,
          encoded: string | undefined,
          shorthand: string | undefined,
        ) => {
          let code: string;
          try {
            code = encoded ? decodeURIComponent(encoded) : (shorthand ?? '');
          } catch {
            issues.push({ column, code: 'missingReference', detail: encoded });
            return original;
          }
          const ids = refs.codes.get(cellKey(code));
          if (ids && ids.size > 1) {
            issues.push({ column, code: 'ambiguousReference', detail: code });
            return original;
          }
          const ref = checkRef(ids?.values().next().value, column, code);
          return ref
            ? '[' + (label ?? ref.label) + '](refobj:' + ref.id + ')'
            : original;
        },
      ),
    );
  const answerMd = resolve(body ?? '', last);
  const excerpt = definition ? resolve(excerptOrAnswer ?? '', 1) : '';
  for (const [column, value] of [
    [last, answerMd],
    [1, excerpt],
  ] as const)
    for (const id of wikiTeachingReferenceIds(value))
      if (!bindings.has(id)) checkRef(id, column, refs.ids.get(id)?.code ?? id);

  let bound: Page | undefined;
  if (excerpt && !issues.some((issue) => issue.column === 1)) {
    const matches = pages.filter((page) => page.contentMd.includes(excerpt));
    const page = matches[0];
    if (
      !page ||
      matches.length !== 1 ||
      page.contentMd.indexOf(excerpt) !== page.contentMd.lastIndexOf(excerpt)
    )
      issues.push({
        column: 1,
        code: page ? 'ambiguousPassage' : 'missingPassage',
      });
    else bound = page;
  }
  if (
    definition &&
    body &&
    !/\p{L}/u.test(
      answerMd.replace(
        /!?\[[^\]]*\]\([^)]*\)|\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g,
        '',
      ),
    )
  )
    issues.push({ column: last, code: 'definitionProse' });
  if (!definition && /!\[[^\]]*\]\((?!refobj:)|<img\b/i.test(answerMd))
    issues.push({ column: last, code: 'useReference' });
  if (answerMd.length > 12000 && body && body.length <= 12000)
    issues.push({ column: last, code: 'length' });

  const prior = record(previous);
  const priorEvidence = Array.isArray(prior.evidence) ? prior.evidence : [];
  const priorPayload = record(prior.approvedPayload);
  const evidence = row.sourceOmitted
    ? priorEvidence
    : excerpt
      ? [
          excerpt,
          ...priorEvidence.slice(1).filter((value) => value !== excerpt),
        ]
      : [];
  const draft = {
    ...prior,
    type: kind,
    ...(definition ? { evidence } : {}),
    approvedPayload: {
      ...priorPayload,
      ...(definition
        ? {
            definitionName: name,
            sourcePageId: row.sourceOmitted
              ? priorPayload.sourcePageId
              : bound?.id,
          }
        : { question: name }),
      answerMd,
    },
  };
  return {
    draft,
    issues,
    sourcePage: bound?.title ?? null,
    cells: definition ? [name, text(evidence[0]), answerMd] : [name, answerMd],
    references: [...bindings.values()],
    binding: transferHash(
      JSON.stringify([
        bound?.id,
        ...[...bindings.values()].map((ref) => [
          ref.id,
          ref.value,
          fingerprints?.get(ref.id),
        ]),
      ]),
    ),
  };
}

export function portableTeachingCells(
  kind: SheetKind,
  draft: Prisma.JsonValue,
  refs: References,
  referenced?: Set<string>,
) {
  const row = teachingCells(kind, draft);
  if (!row) return null;
  const last = row.length - 1;
  for (const column of kind === 'concept' ? [1, last] : [last])
    row[column] = inProse(row[column], (part) =>
      part.replace(
        /\[([^\]\n]+)\]\(refobj:([a-z0-9-]+)\)/g,
        (original: string, label: string, id: string) => {
          const ref = refs.ids.get(id);
          if (!ref?.code || refs.codes.get(cellKey(ref.code))?.size !== 1)
            return original;
          referenced?.add(ref.id);
          if (
            column === last &&
            ref.label === label &&
            !/[{}\r\n]/.test(ref.code)
          )
            return '{{ref:' + ref.code + '}}';
          return (
            '[' +
            label +
            '](refcode:' +
            encodeURIComponent(ref.code).replace(/[()]/g, (char) =>
              char === '(' ? '%28' : '%29',
            ) +
            ')'
          );
        },
      ),
    );
  return row;
}
