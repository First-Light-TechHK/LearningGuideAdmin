import {
  buildReviewedExcerpt,
  type AnchoredChunk,
  type SnapshotPage,
} from './anchored-chunks';
import { validateReviewedTeachingPackage } from './reviewed-package-validator';
import { snapshotHash } from './snapshot-hash';
import { readLectureReferences } from './lecture-references';
import type { TeachingPackageCompiler } from '../../ks/contract/teaching-package-compiler';

export function compileTeachingPackage(input: {
  courseId: string;
  releaseId: string;
  snapshot: { pages: SnapshotPage[] };
  authored: Record<string, unknown>;
}) {
  const { authored, ...identity } = input;
  if (
    !Array.isArray(authored.cards) ||
    !authored.cards.length ||
    authored.cards.length > 200
  )
    throw new Error('cards must contain between 1 and 200 entries');
  const sourceByExcerpt = new Map<string, AnchoredChunk>();
  const cards = (authored.cards as unknown[]).map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('each card must be an object');
    const { evidence, ...fields } = value as Record<string, unknown>;
    if (
      !Array.isArray(evidence) ||
      (!evidence.length &&
        fields.type !== 'ref_obj' &&
        fields.type !== 'professor_qa') ||
      evidence.length > 8
    )
      throw new Error('each card requires 1–8 exact Markdown excerpts');
    const excerpts = (evidence as unknown[]).map((excerpt) => {
      if (typeof excerpt !== 'string') throw new Error('evidence must be text');
      let source = sourceByExcerpt.get(excerpt);
      if (!source) {
        source = buildReviewedExcerpt({ ...identity, excerpt });
        sourceByExcerpt.set(excerpt, source);
      }
      return source.anchor.id;
    });
    const payload = fields.approvedPayload as
      Record<string, unknown> | undefined;
    if (
      fields.type === 'concept' &&
      payload?.sourcePageId &&
      sourceByExcerpt.get(evidence[0] as string)?.anchor.pageId !==
        payload.sourcePageId
    )
      throw new Error('definition passage changed page');
    const card = {
      ...fields,
      sourceSupport: [...new Set(excerpts)],
      reviewStatus: 'approved',
    };
    return { ...card, cardHash: snapshotHash(card) };
  });
  const result = validateReviewedTeachingPackage({
    ...identity,
    candidate: {
      manifest: {
        courseId: identity.courseId,
        releaseId: identity.releaseId,
        snapshotHash: snapshotHash(identity.snapshot),
        packageRevision: 1,
        schemaVersion: 'tutor-package-v1',
        buildVersion: 'reviewed-excerpt-v1',
      },
      sources: [...sourceByExcerpt.values()],
      cards,
      glossary: authored.glossary,
    },
  });
  if (!result.valid) throw new Error(result.reason);
  const refs = new Map<string, string>();
  const referenced = new Set<string>();
  const numberOwners = new Map<string, string>();
  for (const card of result.value.cards) {
    const payload =
      card.approvedPayload &&
      typeof card.approvedPayload === 'object' &&
      !Array.isArray(card.approvedPayload)
        ? (card.approvedPayload as Record<string, unknown>)
        : {};
    const objects = readLectureReferences(payload);
    if (card.type === 'ref_obj') {
      const object = objects[0];
      if (
        objects.length !== 1 ||
        object.id !== card.cardId ||
        !object.code ||
        object.code !== payload.code
      )
        throw new Error('invalid standalone reference');
      const aliases = payload.aliases ?? [];
      if (!Array.isArray(aliases)) throw new Error('invalid reference aliases');
      for (const code of [object.code, ...(aliases as unknown[])]) {
        if (typeof code !== 'string' || !code.trim())
          throw new Error('invalid reference number');
        const normalized = code.trim().normalize('NFKC').toLowerCase();
        const owner = numberOwners.get(normalized);
        if (owner && owner !== object.id)
          throw new Error('duplicate course reference number: ' + code);
        numberOwners.set(normalized, object.id);
      }
    }
    if (
      card.type === 'professor_qa' &&
      (typeof payload.answerMd !== 'string' ||
        !payload.answerMd.trim() ||
        /!\[[^\]]*\]\((?!refobj:)|<img\b/i.test(payload.answerMd))
    )
      throw new Error(`invalid professor answer: ${card.cardId}`);
    const sources = result.value.sources.filter((source) =>
      card.sourceSupport.includes(source.anchor.id),
    );
    const markdown = [
      payload.answerMd,
      ...sources.map((source) => source.content),
    ];
    for (const body of markdown)
      if (typeof body === 'string')
        for (const [, id] of body.matchAll(/\]\(refobj:([a-z0-9-]+)\)/g))
          referenced.add(id);
    for (const object of objects) {
      const digest = snapshotHash(object);
      const existing = refs.get(object.id);
      if (existing && existing !== digest)
        throw new Error(`conflicting reference: ${object.id}`);
      refs.set(object.id, digest);
    }
  }
  for (const id of referenced)
    if (!refs.has(id)) throw new Error(`unresolved reference: ${id}`);
  return result.value;
}

export const compileTeachingPublication: TeachingPackageCompiler = (input) => {
  const teachingPackage = compileTeachingPackage(input);
  const imageAssets = new Set<string>();
  for (const card of teachingPackage.cards) {
    const payload = card.approvedPayload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      continue;
    for (const object of readLectureReferences(
      payload as Record<string, unknown>,
    ))
      if (object.kind === 'image') imageAssets.add(object.value);
  }
  return { teachingPackage, imageAssets: [...imageAssets] };
};
