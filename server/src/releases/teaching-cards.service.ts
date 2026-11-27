import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { lockCourseRow } from '../prisma/course-lock';
import { PrismaService } from '../prisma/prisma.service';
import {
  readLectureReferences,
  teachingReferenceCatalogue,
  wikiTeachingReferenceIds,
} from '../ks/contract/teaching-references';
import { cleanProfessorQa } from '../ks/contract/professor-qa-content';
import {
  mergeApprovedCards,
  teachingPackageBase,
} from './teaching-card-publication';

const LEGACY_CARD_TYPES = [
  'frame',
  'lens',
  'source',
  'boundary',
  'teaching_move',
];
const CARD_TYPES = [
  'concept',
  'misreading',
  'professor_qa',
  ...LEGACY_CARD_TYPES,
];
const CATEGORIES = [
  '*',
  'factual_recall',
  'concept_framework',
  'interpretive_application',
];

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('INVALID_TEACHING_CARD');
  return value as Record<string, unknown>;
}

function string(value: unknown, limit: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit)
    throw new BadRequestException('INVALID_TEACHING_CARD');
  return value.trim();
}

function optionalText(value: unknown, limit: number) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > limit)
    throw new BadRequestException('INVALID_TEACHING_CARD');
  return value.trim();
}

function strings(value: unknown, max: number, limit = 400) {
  if (!Array.isArray(value) || value.length > max)
    throw new BadRequestException('INVALID_TEACHING_CARD');
  return (value as unknown[]).map((item) => string(item, limit));
}

function draftOf(value: unknown, id: string): Prisma.InputJsonObject {
  const data = object(cleanProfessorQa(value));
  const type = string(data.type, 30);
  const inputPayload = object(data.approvedPayload);
  if (type === 'ref_obj') {
    const bilingual = object(data.bilingual);
    const names = object(bilingual.conceptLabel);
    const summaries = object(bilingual.summary);
    const name = { en: string(names.en, 100), zh: optionalText(names.zh, 100) };
    const summary = {
      en: optionalText(summaries.en, 2000),
      zh: optionalText(summaries.zh, 2000),
    };
    if (!summary.en)
      throw new BadRequestException('REFERENCE_SUMMARY_REQUIRED');
    const code = string(inputPayload.code, 80).normalize('NFKC');
    const customLabel = optionalText(inputPayload.displayName, 350);
    const source = object(
      Array.isArray(inputPayload.refObjects)
        ? inputPayload.refObjects[0]
        : null,
    );
    const reference = {
      id,
      kind: source.kind,
      value: source.value,
      requires: [],
      code,
      label:
        customLabel || [code, name.zh, name.en].filter(Boolean).join(' · '),
    };
    try {
      readLectureReferences({ refObjects: [reference] });
    } catch {
      throw new BadRequestException('INVALID_TEACHING_CARD');
    }
    if (reference.label.length > 350 || /[\r\n]/.test(code))
      throw new BadRequestException('INVALID_TEACHING_CARD');
    return {
      type,
      topic: '*',
      conceptId: id,
      canonicalPoint: summary.zh || summary.en,
      bilingual: { conceptLabel: name, summary, triggers: { en: [], zh: [] } },
      approvedPayload: {
        code,
        displayName: customLabel,
        refObjects: [reference],
      } as Prisma.InputJsonObject,
      evidence: [],
      useWhen: ['*'],
      priority: 10,
      links: [],
      doNotUseWhen: [],
    };
  }
  if (type === 'concept' && inputPayload.definitionName !== undefined) {
    const definitionName = string(inputPayload.definitionName, 100);
    const answerMd = string(inputPayload.answerMd, 12000);
    const prose = answerMd.replace(
      /!?\[[^\]]*\]\([^)]*\)|\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g,
      '',
    );
    const evidence = strings(data.evidence, 8, 3200);
    if (!evidence.length || !/\p{L}/u.test(prose))
      throw new BadRequestException('INVALID_TEACHING_CARD');
    const sourcePageId = optionalText(inputPayload.sourcePageId, 100);
    let refs;
    try {
      refs = readLectureReferences(inputPayload);
    } catch {
      throw new BadRequestException('INVALID_TEACHING_CARD');
    }
    const summary = prose.trim().slice(0, 2000);
    return {
      type,
      topic: '*',
      conceptId: id,
      canonicalPoint: summary,
      bilingual: {
        conceptLabel: { en: definitionName, zh: '' },
        summary: { en: summary, zh: '' },
        triggers: { en: [], zh: [] },
      },
      approvedPayload: {
        definitionName,
        answerMd,
        sourcePageId,
        refObjects: refs.map((ref) => ({ ...ref })),
      },
      evidence,
      useWhen: ['*'],
      doNotUseWhen: [],
      priority: 10,
      links: [],
    };
  }
  if (type === 'professor_qa' && inputPayload.question !== undefined) {
    const question = string(inputPayload.question, 400);
    const answerMd = string(inputPayload.answerMd, 12000);
    const triggers: { en: string[]; zh: string[] } = { en: [], zh: [] };
    const previous = object(data.bilingual ?? {});
    const previousName = object(previous.conceptLabel ?? {});
    const chineseQuestion = /\p{Script=Han}/u.test(question);
    triggers[chineseQuestion ? 'zh' : 'en'].push(question);
    const conceptLabel = {
      en: optionalText(previousName.en, 400) || question,
      zh:
        optionalText(previousName.zh, 400) || (chineseQuestion ? question : ''),
    };
    const useWhen = strings(data.useWhen ?? ['*'], 4, 40);
    const priority = data.priority ?? 10;
    if (
      !useWhen.length ||
      useWhen.some((item) => !CATEGORIES.includes(item)) ||
      typeof priority !== 'number' ||
      !Number.isInteger(priority) ||
      priority < 0 ||
      priority > 100
    )
      throw new BadRequestException('INVALID_TEACHING_CARD');
    let references;
    try {
      references = readLectureReferences(inputPayload);
    } catch {
      throw new BadRequestException('INVALID_TEACHING_CARD');
    }
    return {
      type,
      topic: string(data.topic ?? '*', 100),
      conceptId: string(data.conceptId || id, 100),
      canonicalPoint: answerMd.slice(0, 2000),
      bilingual: {
        conceptLabel,
        summary: {
          en: answerMd.slice(0, 2000),
          zh: /\p{Script=Han}/u.test(answerMd) ? answerMd.slice(0, 2000) : '',
        },
        triggers,
      },
      approvedPayload: {
        question,
        answerMd,
        refObjects: references.map((ref) => ({ ...ref })),
      },
      evidence: strings(data.evidence ?? [], 8, 3200),
      useWhen,
      priority,
      links: strings(data.links ?? [], 20, 100),
      doNotUseWhen: strings(data.doNotUseWhen ?? [], 30),
    };
  }
  const useWhen = strings(data.useWhen, 4, 40);
  const priority = data.priority;
  if (
    !CARD_TYPES.includes(type) ||
    !useWhen.length ||
    useWhen.some((entry) => !CATEGORIES.includes(entry)) ||
    typeof priority !== 'number' ||
    !Number.isInteger(priority) ||
    priority < 0 ||
    priority > 100
  )
    throw new BadRequestException('INVALID_TEACHING_CARD');
  const bilingual = object(data.bilingual);
  const conceptLabel = object(bilingual.conceptLabel);
  const summary = object(bilingual.summary);
  const triggers = object(bilingual.triggers);
  const englishTriggers = strings(triggers.en ?? [], 30);
  const chineseTriggers = strings(triggers.zh ?? [], 30);
  const payload = object(data.approvedPayload);
  const evidence = strings(data.evidence, 8, 3200);
  if (!evidence.length || JSON.stringify(payload).length > 12000)
    throw new BadRequestException('INVALID_TEACHING_CARD');
  if (
    type === 'professor_qa' &&
    (typeof payload.answerMd !== 'string' ||
      !payload.answerMd.trim() ||
      englishTriggers.length + chineseTriggers.length === 0)
  )
    throw new BadRequestException('INVALID_TEACHING_CARD');
  return {
    type,
    topic: string(data.topic, 100),
    conceptId: string(data.conceptId, 100),
    canonicalPoint: string(data.canonicalPoint, 2000),
    bilingual: {
      conceptLabel: {
        en: string(conceptLabel.en, 100),
        zh: optionalText(conceptLabel.zh, 100),
      },
      summary: {
        en: string(summary.en, 2000),
        zh: optionalText(summary.zh, 2000),
      },
      triggers: { en: englishTriggers, zh: chineseTriggers },
    },
    approvedPayload: payload as Prisma.InputJsonObject,
    useWhen,
    doNotUseWhen: strings(data.doNotUseWhen, 30),
    links: strings(data.links, 20, 100),
    evidence,
    priority,
  };
}

@Injectable()
export class TeachingCardsService {
  constructor(private readonly prisma: PrismaService) {}

  async listWithStamp(courseId: string) {
    return this.prisma.$transaction(
      async (tx) => {
        const course = await tx.course.findUniqueOrThrow({
          where: { id: courseId },
          select: { updatedAt: true },
        });
        return {
          stamp: course.updatedAt.toISOString(),
          entries: await this.list(courseId, tx),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  list(courseId: string, db: Prisma.TransactionClient = this.prisma) {
    return db.tutorTeachingCard.findMany({
      where: { courseId, deletedAt: null },
      orderBy: [
        { createdAt: { sort: 'desc', nulls: 'last' } },
        { additionPosition: 'asc' },
        { id: 'asc' },
      ],
    });
  }

  async listReferences(courseId: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { editingReleaseId: true },
    });
    if (!course) throw new NotFoundException('课程不存在');
    const [base, approved] = await Promise.all([
      course.editingReleaseId
        ? this.prisma.release.findFirst({
            where: { id: course.editingReleaseId, courseId },
            select: { snapshotData: true },
          })
        : null,
      this.prisma.tutorTeachingCard.findMany({
        where: { courseId },
        select: { id: true, approved: true, reviewerId: true, deletedAt: true },
        orderBy: { id: 'asc' },
      }),
    ]);
    try {
      return [
        ...teachingReferenceCatalogue(
          mergeApprovedCards(teachingPackageBase(base?.snapshotData), approved),
        ).values(),
      ];
    } catch {
      throw new ConflictException('LECTURE_REFERENCE_CATALOG_INVALID');
    }
  }

  async deleteSelection(
    courseId: string,
    items: unknown,
    preview: boolean,
    stamp?: string,
  ) {
    if (!Array.isArray(items) || !items.length)
      throw new BadRequestException('INVALID_TEACHING_CARD');
    const expected = new Map<string, number>();
    for (const input of items as unknown[]) {
      const { id, revision } = object(input);
      if (
        typeof id !== 'string' ||
        !id ||
        expected.has(id) ||
        typeof revision !== 'number' ||
        !Number.isSafeInteger(revision) ||
        revision < 1
      )
        throw new BadRequestException('INVALID_TEACHING_CARD');
      expected.set(id, revision);
    }
    return this.prisma.$transaction(async (tx) => {
      await lockCourseRow(tx, courseId);
      const course = await tx.course.findUnique({
        where: { id: courseId },
        select: { editingReleaseId: true, updatedAt: true },
      });
      if (
        course &&
        stamp !== undefined &&
        course.updatedAt.toISOString() !== stamp
      )
        throw new ConflictException('工作区版本已变化，请重新加载后编辑');
      if (!course) throw new NotFoundException('课程不存在');
      const rows = await tx.tutorTeachingCard.findMany({ where: { courseId } });
      const byId = new Map(rows.map((row) => [row.id, row]));
      const blockers: { id: string; source: string; kind: string }[] = [];
      for (const [id, revision] of expected) {
        const row = byId.get(id);
        if (!row || row.deletedAt || row.revision !== revision)
          blockers.push({ id, source: id, kind: 'changed' });
      }
      // Legacy questions can own inline references whose IDs differ from their card ID.
      const owners = new Map<string, Set<string>>();
      const retained = new Set<string>();
      const indexReferences = (raw: unknown, owner?: string) => {
        if (!raw) return;
        const refs = object(object(raw).approvedPayload ?? {}).refObjects;
        if (!Array.isArray(refs)) return;
        for (const ref of refs as unknown[]) {
          const { id } = object(ref);
          if (typeof id !== 'string') continue;
          if (!owner) retained.add(id);
          else {
            const ids = owners.get(id) ?? new Set<string>();
            ids.add(owner);
            owners.set(id, ids);
          }
        }
      };
      const release =
        course.editingReleaseId &&
        (await tx.release.findFirst({
          where: { id: course.editingReleaseId, courseId },
          select: { snapshotData: true },
        }));
      const base = teachingPackageBase(release && release.snapshotData);
      const baseCards = (
        Array.isArray(base?.cards) ? (base.cards as unknown[]) : []
      )
        .map(object)
        .filter((card) => !byId.has(String(card.cardId)));
      for (const card of baseCards) indexReferences(card);
      for (const row of rows) {
        if (!row.deletedAt)
          indexReferences(
            row.approved,
            expected.has(row.id) ? row.id : undefined,
          );
      }
      const check = (ids: Iterable<unknown>, source: string, kind: string) => {
        for (const id of new Set(ids)) {
          if (typeof id !== 'string') continue;
          if (expected.has(id)) blockers.push({ id, source, kind });
          else if (!retained.has(id)) {
            for (const owner of owners.get(id) ?? [])
              blockers.push({ id: owner, source, kind });
          }
        }
      };
      const inspect = (raw: unknown, fallback: string, kind: string) => {
        if (!raw) return;
        const card = object(raw);
        const payload = object(card.approvedPayload ?? {});
        const name = object(object(card.bilingual ?? {}).conceptLabel ?? {});
        const source =
          [payload.question, payload.displayName, name.zh, name.en].find(
            (value): value is string =>
              typeof value === 'string' && !!value.trim(),
          ) ?? fallback;
        check(
          [
            ...(Array.isArray(card.links) ? (card.links as unknown[]) : []),
            ...(Array.isArray(payload.refObjects)
              ? (payload.refObjects as unknown[]).map((ref) => object(ref).id)
              : []),
            ...wikiTeachingReferenceIds(
              typeof payload.answerMd === 'string' ? payload.answerMd : '',
            ),
          ],
          source,
          kind,
        );
      };
      for (const row of rows) {
        if (row.deletedAt || expected.has(row.id)) continue;
        if (row.revision !== row.approvedRevision)
          inspect(row.draft, row.id, 'draft');
        inspect(row.approved, row.id, 'approved');
      }
      for (const card of baseCards) inspect(card, String(card.cardId), 'base');
      // Page edits do not take the course lock. Keep checked pages stable through commit.
      if (!preview)
        await tx.$queryRaw`SELECT id FROM "Page" WHERE "courseId" = ${courseId} FOR SHARE`;
      const pages = await tx.page.findMany({
        where: { courseId },
        select: { title: true, contentMd: true },
      });
      for (const page of pages)
        check(wikiTeachingReferenceIds(page.contentMd), page.title, 'wiki');
      if (!preview && !blockers.length) {
        await tx.tutorTeachingCard.updateMany({
          where: {
            courseId,
            deletedAt: null,
            id: { in: [...expected.keys()] },
          },
          data: { deletedAt: new Date(), revision: { increment: 1 } },
        });
      }
      return { blockers };
    });
  }

  async save(
    courseId: string,
    id: string | undefined,
    revision: number | undefined,
    value: unknown,
    employeeId: string,
    stamp?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockExistingCourse(tx, courseId, stamp);
      return this.saveEntry(tx, courseId, id, revision, value, employeeId);
    });
  }

  private async lockExistingCourse(
    tx: Prisma.TransactionClient,
    courseId: string,
    stamp?: string,
  ) {
    await lockCourseRow(tx, courseId);
    const course = await tx.course.findUnique({
      where: { id: courseId },
      select: { updatedAt: true },
    });
    if (!course) throw new NotFoundException('课程不存在');
    if (stamp !== undefined && course.updatedAt.toISOString() !== stamp)
      throw new ConflictException('工作区版本已变化，请重新加载后编辑');
  }

  async deletedReferenceCodes(
    courseId: string,
    db: Prisma.TransactionClient = this.prisma,
  ) {
    const rows = await db.tutorTeachingCard.findMany({
      where: {
        courseId,
        deletedAt: { not: null },
        draft: { path: ['type'], equals: 'ref_obj' },
      },
      select: { draft: true, approved: true },
    });
    return [
      ...new Set(
        rows.flatMap((row) =>
          [row.draft, row.approved].flatMap((version) => {
            if (!version) return [];
            const payload = object(object(version).approvedPayload);
            return [
              String(payload.code),
              ...strings(payload.aliases ?? [], Infinity),
            ];
          }),
        ),
      ),
    ];
  }

  async importReferences(
    courseId: string,
    items: unknown,
    updatesOnly: boolean,
    employeeId: string,
  ) {
    if (!Array.isArray(items) || !items.length || items.length > 200)
      throw new BadRequestException('INVALID_TEACHING_CARD');
    return this.prisma.$transaction(
      async (tx) => {
        await this.lockExistingCourse(tx, courseId);
        const deleted = new Set(
          (await this.deletedReferenceCodes(courseId, tx)).map((code) =>
            code.normalize('NFKC').toLowerCase(),
          ),
        );
        const seen = new Set<string>();
        const targets = new Set<string>();
        const importedAt = new Date();
        for (const [position, raw] of (items as unknown[]).entries()) {
          const item = object(raw);
          const id = item.id === undefined ? undefined : string(item.id, 100);
          if (updatesOnly && !id) throw new ForbiddenException();
          const revision = item.revision;
          if (
            id &&
            (typeof revision !== 'number' || !Number.isSafeInteger(revision))
          )
            throw new BadRequestException('INVALID_TEACHING_CARD');
          const value = object(item.draft);
          if (value.type !== 'ref_obj')
            throw new BadRequestException('INVALID_TEACHING_CARD');
          const payload = object(value.approvedPayload);
          const ref = object(
            Array.isArray(payload.refObjects) ? payload.refObjects[0] : null,
          );
          const code = string(payload.code, 80).normalize('NFKC').toLowerCase();
          if (!id && deleted.has(code) && item.recreate !== true)
            throw new ConflictException('TEACHING_CARD_REVISION_CHANGED');
          if (seen.has(code) || (id && targets.has(id)))
            throw new ConflictException('REFERENCE_CODE_IN_USE');
          seen.add(code);
          if (id) {
            targets.add(id);
            const current = await tx.tutorTeachingCard.findFirst({
              where: { id, courseId, deletedAt: null },
              select: { draft: true },
            });
            const prior =
              current && object(object(current.draft).approvedPayload);
            const priorRef =
              prior &&
              object(
                Array.isArray(prior.refObjects) ? prior.refObjects[0] : null,
              );
            if (
              !prior ||
              priorRef?.kind !== ref.kind ||
              String(prior.code).normalize('NFKC').toLowerCase() !== code
            )
              throw new ConflictException('TEACHING_CARD_REVISION_CHANGED');
          }
          if (ref.kind === 'image') {
            const asset = string(ref.value, 80);
            if (
              !(await tx.knowledgeImageAsset.findFirst({
                where: {
                  courseId,
                  storageKey: 'knowledge-pages/' + courseId + '/' + asset,
                },
                select: { id: true },
              }))
            )
              throw new BadRequestException('INVALID_TEACHING_CARD');
          }
          await this.saveEntry(
            tx,
            courseId,
            id,
            typeof revision === 'number' ? revision : undefined,
            value,
            employeeId,
            position,
            importedAt,
          );
        }
        return { saved: items.length };
      },
      { timeout: 30000 },
    );
  }

  private async saveEntry(
    tx: Prisma.TransactionClient,
    courseId: string,
    id: string | undefined,
    revision: number | undefined,
    value: unknown,
    employeeId: string,
    additionPosition = 0,
    importedAt?: Date,
  ) {
    const stableId = id ?? randomUUID();
    const draft = draftOf(value, stableId);
    const legacyType =
      typeof draft.type === 'string' && LEGACY_CARD_TYPES.includes(draft.type);
    if (draft.type === 'ref_obj') {
      const rows = await tx.tutorTeachingCard.findMany({
        where: {
          courseId,
          deletedAt: null,
          draft: { path: ['type'], equals: 'ref_obj' },
        },
        select: { id: true, draft: true, approved: true },
      });
      const payload = draft.approvedPayload as Prisma.InputJsonObject;
      const code = string(payload.code, 80);
      const aliases = new Set<string>();
      for (const row of rows)
        for (const version of [row.draft, row.approved]) {
          const record = version as Prisma.JsonObject | null;
          if (record?.type !== 'ref_obj') continue;
          const stored = record.approvedPayload as Prisma.JsonObject;
          for (const number of [
            string(stored.code, 80),
            ...((stored.aliases ?? []) as string[]),
          ]) {
            if (row.id === stableId) {
              if (number.toLowerCase() !== code.toLowerCase())
                aliases.add(number);
            } else if (number.toLowerCase() === code.toLowerCase())
              throw new ConflictException('REFERENCE_CODE_IN_USE');
          }
        }
      Object.assign(payload, { aliases: [...aliases] });
    }
    if (
      draft.type === 'concept' &&
      object(draft.approvedPayload).definitionName !== undefined
    ) {
      const payload = draft.approvedPayload as Prisma.InputJsonObject;
      const [excerpt] = draft.evidence as string[];
      const matches = await tx.page.findMany({
        where: {
          courseId,
          syncState: 'SYNCED',
          contentMd: { contains: excerpt.replace(/[\\%_]/g, '\\$&') },
        },
        select: { id: true, contentMd: true },
      });
      const exact = matches.filter((page) => page.contentMd.includes(excerpt));
      const page = exact[0];
      if (
        exact.length !== 1 ||
        !page ||
        page.contentMd.indexOf(excerpt) !==
          page.contentMd.lastIndexOf(excerpt) ||
        (payload.sourcePageId && payload.sourcePageId !== page.id)
      )
        throw new BadRequestException('DEFINITION_PASSAGE_CHANGED');
      Object.assign(payload, { sourcePageId: page.id });
    }
    // New saves satisfy the existing Release contract in the same write.
    const saved = { draft, approved: draft, reviewerId: employeeId };
    if (!id) {
      if (legacyType) throw new BadRequestException('INVALID_TEACHING_CARD');
      return tx.tutorTeachingCard.create({
        data: {
          id: stableId,
          courseId,
          ...saved,
          approvedRevision: 1,
          additionPosition,
          ...(importedAt && { createdAt: importedAt }),
        },
      });
    }
    const existing = await tx.tutorTeachingCard.findFirst({
      where: { id, courseId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('TEACHING_CARD_NOT_FOUND');
    const existingType = (existing.draft as Prisma.JsonObject).type;
    if (
      (existingType === 'ref_obj') !== (draft.type === 'ref_obj') ||
      (legacyType && existingType !== draft.type)
    )
      throw new BadRequestException('INVALID_TEACHING_CARD');
    if (existing.revision !== revision)
      throw new ConflictException('TEACHING_CARD_REVISION_CHANGED');
    const previous = existing.draft as Prisma.JsonObject;
    const converting =
      existingType === 'concept' &&
      draft.type === 'concept' &&
      object(draft.approvedPayload).definitionName !== undefined &&
      object(previous.approvedPayload).definitionName === undefined;
    const legacy =
      previous.legacyDefinition ?? (converting ? previous : undefined);
    if (legacy)
      saved.draft = {
        ...draft,
        legacyDefinition: legacy,
      };
    return tx.tutorTeachingCard.update({
      where: { id },
      data: {
        ...saved,
        approvedRevision: existing.revision + 1,
        revision: { increment: 1 },
      },
    });
  }
}
