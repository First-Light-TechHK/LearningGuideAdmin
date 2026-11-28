import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  PayloadTooLargeException,
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
  selectedSheetKinds,
  TEACHING_BATCH_LIMIT,
  TEACHING_SHEET_BYTES,
  TEACHING_WORKBOOK_ROW_LIMIT,
  teachingWorkbook,
  teachingWorkbookSheets,
  type SheetKind,
  type WorkbookSheet,
} from './teaching-import-files';
import { FilesService } from '../files/files.service';
import {
  referenceImageBytes,
  referenceTransferLimits,
} from './teaching-reference-limits';
import {
  referenceDocument,
  type ReferenceDocumentRow,
  type ReferenceKind,
} from './teaching-reference-document';
import {
  cellKey,
  fingerprintReference,
  portableTeachingCells,
  prepareSheetRow,
  sheetReferences,
  teachingCells,
  type SheetRow,
} from './teaching-sheet-rows';
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
    const name = {
      en: optionalText(names.en, 100),
      zh: optionalText(names.zh, 100),
    };
    const primaryName = name.en || name.zh;
    if (!primaryName) throw new BadRequestException('INVALID_TEACHING_CARD');
    const summary = {
      en: optionalText(summaries.en, 2000),
      zh: optionalText(summaries.zh, 2000),
    };
    const primarySummary = summary.en || summary.zh;
    if (!primarySummary)
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
      label: customLabel || [code, primaryName].join(' · '),
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
      canonicalPoint: primarySummary,
      bilingual: {
        conceptLabel: { ...name, en: primaryName },
        summary: { ...summary, en: primarySummary },
        triggers: { en: [], zh: [] },
      },
      approvedPayload: {
        code,
        displayName: customLabel,
        refObjects: [reference],
        aliases: strings(inputPayload.aliases ?? [], 80, 80),
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
    const evidence = strings(data.evidence ?? [], 8, 3200);
    if (!/\p{L}/u.test(prose))
      throw new BadRequestException('INVALID_TEACHING_CARD');
    const sourcePageId = evidence.length
      ? optionalText(inputPayload.sourcePageId, 100)
      : undefined;
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
        ...(sourcePageId ? { sourcePageId } : {}),
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
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly files?: FilesService,
  ) {}

  private imageBytes(courseId: string, name: string) {
    return (
      this.files?.getImage(courseId, name).then((image) => image?.bytes) ??
      Promise.resolve(undefined)
    );
  }

  async download(
    courseId: string,
    kind: SheetKind | ReferenceKind,
    ids: unknown,
    chinese: boolean,
  ) {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      !ids.every((id: unknown) => typeof id === 'string') ||
      new Set(ids).size !== ids.length
    )
      throw new BadRequestException('TEACHING_TRANSFER_SELECTION');
    const selected = ids;
    const isSheet = kind === 'concept' || kind === 'professor_qa';
    if (
      selected.length >
      (isSheet ? TEACHING_BATCH_LIMIT : referenceTransferLimits[kind].rows)
    )
      throw new PayloadTooLargeException('TEACHING_TRANSFER_TOO_LARGE');
    const { title, entries, authored } = await this.prisma.$transaction(
      async (tx) => {
        const course = await tx.course.findUniqueOrThrow({
          where: { id: courseId },
          select: { title: true },
        });
        const entries = await tx.tutorTeachingCard.findMany({
          where: { courseId, id: { in: selected }, deletedAt: null },
          orderBy: [
            { createdAt: { sort: 'desc', nulls: 'last' } },
            { additionPosition: 'asc' },
            { id: 'asc' },
          ],
        });
        if (entries.length !== selected.length)
          throw new BadRequestException('TEACHING_TRANSFER_SELECTION');
        return {
          title: course.title,
          entries,
          authored: isSheet
            ? await this.referenceContent(courseId, tx)
            : undefined,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
    if (!isSheet)
      return this.downloadReferenceDocument(
        courseId,
        title,
        kind,
        entries.map((entry) => entry.draft),
        chinese,
      );
    const { sheets, dependencies } = await this.portableWorkbook(
      courseId,
      [{ kind, drafts: entries.map(({ draft }) => draft) }],
      authored,
    );
    const buffer = teachingWorkbook(
      kind,
      sheets[0].rows,
      chinese,
      dependencies,
    );
    if (buffer.length > TEACHING_SHEET_BYTES)
      throw new PayloadTooLargeException('TEACHING_TRANSFER_TOO_LARGE');
    const label =
      kind === 'concept'
        ? chinese
          ? '定义'
          : 'Definitions'
        : chinese
          ? '教授问答'
          : 'Professor Q&A';
    const filename =
      title.replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120) +
      '_' +
      label +
      '.xlsx';
    return { filename, buffer };
  }

  async downloadTeachingWorkbook(courseId: string, input: unknown) {
    if (!Array.isArray(input) || !input.length)
      throw new BadRequestException('TEACHING_TRANSFER_SELECTION');
    const groups = (input as unknown[]).map(object);
    const kinds = selectedSheetKinds(groups.map(({ kind }) => kind));
    const idsByKind = new Map<SheetKind, Set<string>>();
    for (const kind of kinds) {
      const { ids } = groups.find((group) => group.kind === kind)!;
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        !ids.every((id: unknown) => typeof id === 'string') ||
        new Set(ids).size !== ids.length
      )
        throw new BadRequestException('TEACHING_TRANSFER_SELECTION');
      if (ids.length > TEACHING_BATCH_LIMIT)
        throw new PayloadTooLargeException('TEACHING_TRANSFER_TOO_LARGE');
      idsByKind.set(kind, new Set(ids));
    }
    const ids = [...idsByKind.values()].flatMap((group) => [...group]);
    const { title, sheets, authored } = await this.prisma.$transaction(
      async (tx) => {
        const course = await tx.course.findUniqueOrThrow({
          where: { id: courseId },
          select: { title: true },
        });
        const entries = await tx.tutorTeachingCard.findMany({
          where: { courseId, id: { in: ids }, deletedAt: null },
          orderBy: [
            { createdAt: { sort: 'desc', nulls: 'last' } },
            { additionPosition: 'asc' },
            { id: 'asc' },
          ],
        });
        if (entries.length !== ids.length)
          throw new BadRequestException('TEACHING_TRANSFER_SELECTION');
        const sheets = kinds.map((kind) => ({
          kind,
          drafts: entries
            .filter(({ id }) => idsByKind.get(kind)?.has(id))
            .map(({ draft }) => draft),
        }));
        return {
          title: course.title,
          sheets,
          authored: await this.referenceContent(courseId, tx),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
    return this.exportTeachingWorkbook(courseId, title, sheets, authored);
  }

  private async exportTeachingWorkbook(
    courseId: string,
    title: string,
    output: readonly { kind: SheetKind; drafts: readonly Prisma.JsonValue[] }[],
    authored?: Record<string, unknown>,
  ) {
    if (
      output.reduce((sum, sheet) => sum + sheet.drafts.length, 0) >
      TEACHING_WORKBOOK_ROW_LIMIT
    )
      throw new PayloadTooLargeException('TEACHING_TRANSFER_TOO_LARGE');
    const { sheets, dependencies } = await this.portableWorkbook(
      courseId,
      output,
      authored,
    );
    const buffer = teachingWorkbookSheets(sheets, dependencies);
    if (buffer.length > TEACHING_SHEET_BYTES)
      throw new PayloadTooLargeException('TEACHING_TRANSFER_TOO_LARGE');
    const filename =
      title.replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120) +
      '_Teaching Entries.xlsx';
    return { filename, buffer };
  }

  private async portableWorkbook(
    courseId: string,
    output: readonly { kind: SheetKind; drafts: readonly Prisma.JsonValue[] }[],
    authored?: Record<string, unknown>,
  ) {
    const refs = sheetReferences(authored);
    const referenced = new Set<string>();
    const sheets = output.map(({ kind, drafts }) => {
      if (drafts.length > TEACHING_BATCH_LIMIT)
        throw new PayloadTooLargeException('TEACHING_TRANSFER_TOO_LARGE');
      const rows = drafts.map((draft) => {
        const row = portableTeachingCells(kind, draft, refs, referenced);
        if (!row) throw new BadRequestException('TEACHING_TRANSFER_SELECTION');
        if (
          row.slice(1).some((value) => wikiTeachingReferenceIds(value).length)
        )
          throw new BadRequestException('TEACHING_TRANSFER_UNPORTABLE');
        return row;
      });
      return { kind, rows };
    });
    const hashes = await this.referenceFingerprints(courseId, refs, referenced);
    const dependencies = new Map<string, string>();
    for (const id of referenced) {
      const code = refs.ids.get(id)?.code;
      const hash = hashes.get(id);
      if (!code || !hash)
        throw new BadRequestException('TEACHING_TRANSFER_UNPORTABLE');
      const key = cellKey(code);
      const previous = dependencies.get(key);
      if (previous !== undefined && previous !== hash)
        throw new BadRequestException('TEACHING_TRANSFER_UNPORTABLE');
      dependencies.set(key, hash);
    }
    return { sheets, dependencies };
  }

  private async downloadReferenceDocument(
    courseId: string,
    title: string,
    kind: ReferenceKind,
    drafts: readonly Prisma.JsonValue[],
    chinese: boolean,
  ) {
    const limits = referenceTransferLimits[kind];
    const rows: ReferenceDocumentRow[] = [];
    let total = 0;
    for (const draft of drafts) {
      const card = object(draft);
      const payload = object(card.approvedPayload);
      const [ref] = readLectureReferences(payload);
      if (card.type !== 'ref_obj' || ref?.kind !== kind)
        throw new BadRequestException('TEACHING_TRANSFER_SELECTION');
      const code = string(payload.code, 80);
      const bilingual = object(card.bilingual),
        names = object(bilingual.conceptLabel),
        summary = object(bilingual.summary);
      const bytes =
        kind === 'image'
          ? await this.imageBytes(courseId, ref.value)
          : undefined;
      if (kind === 'image' && !bytes)
        throw new BadRequestException('TEACHING_TRANSFER_UNPORTABLE');
      if (bytes) {
        if (bytes.length > referenceImageBytes)
          throw new PayloadTooLargeException(
            `图片引用「${code}」超过单图 8 MiB 限制`,
          );
        total += bytes.length;
        if (total > limits.bytes)
          throw new PayloadTooLargeException('TEACHING_TRANSFER_TOO_LARGE');
      }
      rows.push({
        code,
        kind,
        value: ref.value,
        names: { en: string(names.en, 100), zh: optionalText(names.zh, 100) },
        summary: {
          en: string(summary.en, 2000),
          zh: optionalText(summary.zh, 2000),
        },
        aliases: strings(payload.aliases ?? [], 80, 80),
        displayName: optionalText(payload.displayName, 350),
        bytes,
      });
    }
    const buffer = await referenceDocument(kind, rows);
    if (
      buffer.length > limits.bytes ||
      (this.files && !(await this.files.fitsReferenceDocument(buffer, kind)))
    )
      throw new PayloadTooLargeException('TEACHING_TRANSFER_TOO_LARGE');
    const label =
      kind === 'latex'
        ? chinese
          ? '公式引用'
          : 'Formula references'
        : chinese
          ? '图片引用'
          : 'Image references';
    const filename =
      title.replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120) +
      '_' +
      label +
      '.docx';
    return { filename, buffer };
  }

  private async referenceFingerprints(
    courseId: string,
    refs: ReturnType<typeof sheetReferences>,
    ids: Iterable<string>,
  ) {
    const hashes = new Map<string, string>();
    for (const id of ids) {
      const ref = refs.ids.get(id);
      if (!ref) continue;
      const hash = await fingerprintReference(ref, (name) =>
        this.imageBytes(courseId, name),
      );
      if (hash) hashes.set(id, hash);
    }
    return hashes;
  }

  private fingerprintsForRows(
    courseId: string,
    refs: ReturnType<typeof sheetReferences>,
    rows: SheetRow[],
  ) {
    const ids = new Set<string>();
    for (const row of rows)
      for (const code of row.dependencies?.keys() ?? [])
        for (const id of refs.codes.get(cellKey(code)) ?? []) ids.add(id);
    return this.referenceFingerprints(courseId, refs, ids);
  }

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
    return [
      ...sheetReferences(
        await this.referenceContent(courseId, this.prisma),
      ).ids.values(),
    ];
  }

  private async referenceContent(
    courseId: string,
    db: Prisma.TransactionClient,
  ) {
    const course = await db.course.findUnique({
      where: { id: courseId },
      select: { editingReleaseId: true },
    });
    if (!course) throw new NotFoundException('课程不存在');
    const [base, approved] = await Promise.all([
      course.editingReleaseId
        ? db.release.findFirst({
            where: { id: course.editingReleaseId, courseId },
            select: { snapshotData: true },
          })
        : null,
      db.tutorTeachingCard.findMany({
        where: { courseId },
        select: { id: true, approved: true, reviewerId: true, deletedAt: true },
        orderBy: { id: 'asc' },
      }),
    ]);
    try {
      const authored = mergeApprovedCards(
        teachingPackageBase(base?.snapshotData),
        approved,
      );
      teachingReferenceCatalogue(authored);
      return authored;
    } catch {
      throw new ConflictException('LECTURE_REFERENCE_CATALOG_INVALID');
    }
  }

  private async sheetContext(
    tx: Prisma.TransactionClient,
    courseId: string,
    kind: SheetKind,
  ) {
    const [entries, pages, authored] = await Promise.all([
      this.list(courseId, tx),
      kind === 'concept'
        ? tx.page.findMany({
            where: { courseId, syncState: 'SYNCED' },
            select: { id: true, title: true, contentMd: true },
          })
        : [],
      this.referenceContent(courseId, tx),
    ]);
    const choices = entries.flatMap((entry) => {
      const values = teachingCells(kind, entry.draft);
      return values ? [{ entry, values }] : [];
    });
    return { choices, pages, refs: sheetReferences(authored) };
  }

  async previewTeachingSheet(
    courseId: string,
    kind: SheetKind,
    rows: SheetRow[],
  ) {
    const result = await this.previewTeachingWorkbook(courseId, [
      { kind, name: kind, rows },
    ]);
    const [{ rows: reviewed, targets }] = result.sheets;
    return { stamp: result.stamp, rows: reviewed, targets };
  }

  async previewTeachingWorkbook(
    courseId: string,
    sheets: readonly WorkbookSheet[],
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        const course = await tx.course.findUniqueOrThrow({
          where: { id: courseId },
          select: { updatedAt: true },
        });
        return {
          stamp: course.updatedAt.toISOString(),
          sheets: await Promise.all(
            sheets.map(async ({ kind, name, rows, invalid }) => ({
              kind,
              name,
              invalid,
              ...(invalid
                ? { rows: [], targets: [] }
                : await this.reviewTeachingSheet(tx, courseId, kind, rows)),
            })),
          ),
        };
      },
      { isolationLevel: 'RepeatableRead', timeout: 30000 },
    );
  }

  private async reviewTeachingSheet(
    tx: Prisma.TransactionClient,
    courseId: string,
    kind: SheetKind,
    rows: SheetRow[],
  ) {
    const { choices, pages, refs } = await this.sheetContext(
      tx,
      courseId,
      kind,
    );
    const keys = rows.map((row) => cellKey(row.values[0]));
    const fingerprints = await this.fingerprintsForRows(courseId, refs, rows);
    return {
      targets: choices.map(({ entry, values }) => ({
        id: entry.id,
        revision: entry.revision,
        title: values[0],
        values,
      })),
      rows: rows.map((row, index) => {
        const key = keys[index];
        const matches = choices.filter(
          ({ values }) => key && cellKey(values[0]) === key,
        );
        const prepared = prepareSheetRow(
          kind,
          row,
          pages,
          refs,
          matches.length === 1 ? matches[0].entry.draft : undefined,
          fingerprints,
        );
        const same =
          matches.length === 1 &&
          matches[0].values.every(
            (value, column) => value === prepared.cells[column],
          );
        const similar =
          key && !matches.length
            ? choices.filter(({ values }) =>
                values
                  .slice(1)
                  .some(
                    (value, col) =>
                      value.trim() && value === prepared.cells[col + 1],
                  ),
              )
            : [];
        const status = prepared.issues.length
          ? 'invalid'
          : keys.indexOf(key) !== keys.lastIndexOf(key)
            ? 'duplicate'
            : matches.length > 1
              ? 'choose'
              : same
                ? 'same'
                : matches.length
                  ? 'update'
                  : similar.length
                    ? 'rename'
                    : 'new';
        return {
          row: row.row,
          values: row.values,
          status,
          sourcePage: prepared.sourcePage,
          issues: prepared.issues,
          targetId: matches.length === 1 ? matches[0].entry.id : null,
          suggestedIds: similar ? similar.map(({ entry }) => entry.id) : [],
          references: prepared.references,
          binding: prepared.binding,
        };
      }),
    };
  }

  async importTeachingSheet(
    courseId: string,
    kind: SheetKind,
    items: unknown,
    updatesOnly: boolean,
    employeeId: string,
    stamp?: string,
  ) {
    if (!Array.isArray(items))
      throw new BadRequestException('TEACHING_SHEET_INVALID');
    return this.importTeachingWorkbook(
      courseId,
      [{ kind, items }],
      updatesOnly,
      employeeId,
      stamp,
    );
  }

  async importTeachingWorkbook(
    courseId: string,
    sheets: readonly { kind: SheetKind; items: unknown[] }[],
    updatesOnly: boolean,
    employeeId: string,
    stamp?: string,
  ) {
    if (
      !stamp ||
      !sheets.length ||
      sheets.reduce((sum, { items }) => sum + items.length, 0) >
        TEACHING_WORKBOOK_ROW_LIMIT ||
      sheets.some(
        ({ items }) => !items.length || items.length > TEACHING_BATCH_LIMIT,
      )
    )
      throw new BadRequestException('TEACHING_SHEET_INVALID');
    selectedSheetKinds(sheets.map(({ kind }) => kind));
    return this.prisma.$transaction(
      async (tx) => {
        await this.lockExistingCourse(tx, courseId, stamp);
        if (sheets.some(({ kind }) => kind === 'concept'))
          await tx.$queryRaw`SELECT id FROM "Page" WHERE "courseId" = ${courseId} FOR SHARE`;
        let saved = 0;
        for (const { kind, items } of sheets)
          saved += await this.saveTeachingSheet(
            tx,
            courseId,
            kind,
            items,
            updatesOnly,
            employeeId,
          );
        return { saved };
      },
      { timeout: 30000 },
    );
  }

  private async saveTeachingSheet(
    tx: Prisma.TransactionClient,
    courseId: string,
    kind: SheetKind,
    items: readonly unknown[],
    updatesOnly: boolean,
    employeeId: string,
  ) {
    const { choices, pages, refs } = await this.sheetContext(
      tx,
      courseId,
      kind,
    );
    const dependencies = new Map<string, string>();
    for (const raw of items) {
      const item = object(raw);
      if (item.dependencies instanceof Map)
        for (const [code, hash] of item.dependencies as Map<string, string>)
          dependencies.set(code, hash);
    }
    const fingerprints = await this.fingerprintsForRows(courseId, refs, [
      { row: 0, values: [], errors: [], dependencies },
    ]);
    const names = new Set<string>();
    const targets = new Set<string>();
    const at = new Date();
    let saved = 0;
    for (const [position, raw] of items.entries()) {
      const item = object(raw);
      const row = item.row;
      const length = kind === 'concept' ? 3 : 2;
      if (
        typeof row !== 'number' ||
        !Number.isSafeInteger(row) ||
        row < 2 ||
        !Array.isArray(item.values) ||
        item.values.length !== length ||
        !item.values.every((value: unknown) => typeof value === 'string')
      )
        throw new BadRequestException('TEACHING_SHEET_INVALID');
      const values = item.values;
      const key = cellKey(values[0]);
      const id = item.id === undefined ? undefined : string(item.id, 150);
      if (!id && updatesOnly) throw new ForbiddenException();
      const match = choices.find(({ entry }) => entry.id === id);
      if (
        names.has(key) ||
        (id && targets.has(id)) ||
        (id
          ? !match ||
            match.entry.revision !== item.revision ||
            (cellKey(match.values[0]) !== key &&
              choices.some(
                ({ entry, values: prior }) =>
                  entry.id !== id && cellKey(prior[0]) === key,
              ))
          : choices.some(({ values: prior }) => cellKey(prior[0]) === key))
      )
        throw new ConflictException('TEACHING_SHEET_CHANGED');
      names.add(key);
      if (id) targets.add(id);
      const prepared = prepareSheetRow(
        kind,
        {
          row,
          values,
          errors: [],
          dependencies,
          sourceOmitted: item.sourceOmitted === true,
        },
        pages,
        refs,
        match?.entry.draft,
        fingerprints,
      );
      if (
        prepared.issues.length ||
        (item.binding !== undefined && prepared.binding !== item.binding)
      )
        throw new ConflictException('TEACHING_SHEET_CHANGED');
      if (
        match?.values.every((value, column) => value === prepared.cells[column])
      )
        continue;
      await this.saveEntry(
        tx,
        courseId,
        id,
        match?.entry.revision,
        prepared.draft,
        employeeId,
        position,
        at,
      );
      saved++;
    }
    return saved;
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
    if (!Array.isArray(items) || !items.length)
      throw new BadRequestException('INVALID_TEACHING_CARD');
    if (items.length > referenceTransferLimits.latex.rows)
      throw new PayloadTooLargeException('TEACHING_REFERENCE_BATCH_LIMIT');
    const references = (items as unknown[]).map((raw) => {
      const item = object(raw);
      const value = object(item.draft);
      if (value.type !== 'ref_obj')
        throw new BadRequestException('INVALID_TEACHING_CARD');
      const payload = object(value.approvedPayload);
      const ref = object(
        Array.isArray(payload.refObjects) ? payload.refObjects[0] : null,
      );
      if (ref.kind !== 'latex' && ref.kind !== 'image')
        throw new BadRequestException('INVALID_TEACHING_CARD');
      return { item, value, payload, ref };
    });
    if (
      references.filter(({ ref }) => ref.kind === 'image').length >
      referenceTransferLimits.image.rows
    )
      throw new PayloadTooLargeException('TEACHING_REFERENCE_BATCH_LIMIT');
    return this.prisma.$transaction(
      async (tx) => {
        await this.lockExistingCourse(tx, courseId);
        const course = await tx.course.findUnique({
          where: { id: courseId },
          select: { editingReleaseId: true },
        });
        const release =
          course?.editingReleaseId &&
          (await tx.release.findFirst({
            where: { id: course.editingReleaseId, courseId },
            select: { snapshotData: true },
          }));
        const inherited = sheetReferences(
          teachingPackageBase(release && release.snapshotData),
        );
        const deleted = new Set(
          (await this.deletedReferenceCodes(courseId, tx)).map((code) =>
            code.normalize('NFKC').toLowerCase(),
          ),
        );
        const seen = new Set<string>();
        const targets = new Set<string>();
        const importedAt = new Date();
        const referenceNumbers = await this.loadReferenceNumbers(tx, courseId);
        for (const [
          position,
          { item, value, payload, ref },
        ] of references.entries()) {
          const id = item.id === undefined ? undefined : string(item.id, 100);
          if (updatesOnly && !id) throw new ForbiddenException();
          const revision = item.revision;
          if (
            id &&
            (typeof revision !== 'number' || !Number.isSafeInteger(revision))
          )
            throw new BadRequestException('INVALID_TEACHING_CARD');
          const code = string(payload.code, 80).normalize('NFKC').toLowerCase();
          const numbers = [
            code,
            ...strings(payload.aliases ?? [], 80, 80).map(cellKey),
          ];
          if (
            numbers.some((number) =>
              [...(inherited.codes.get(number) ?? [])].some(
                (owner) => owner !== id,
              ),
            )
          )
            throw new ConflictException('REFERENCE_CODE_IN_USE');
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
            referenceNumbers,
          );
        }
        return { saved: references.length };
      },
      { timeout: 30000 },
    );
  }

  private async loadReferenceNumbers(
    tx: Prisma.TransactionClient,
    courseId: string,
  ) {
    const rows = await tx.tutorTeachingCard.findMany({
      where: {
        courseId,
        deletedAt: null,
        draft: { path: ['type'], equals: 'ref_obj' },
      },
      select: { id: true, draft: true, approved: true },
    });
    return new Map(
      rows.map(({ id, draft, approved }) => [
        id,
        [draft, approved].flatMap((version) => {
          const record = version as Prisma.JsonObject | null;
          if (record?.type !== 'ref_obj') return [];
          const payload = record.approvedPayload as Prisma.JsonObject;
          return [
            string(payload.code, 80),
            ...((payload.aliases ?? []) as string[]),
          ];
        }),
      ]),
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
    batchReferenceNumbers?: Map<string, string[]>,
  ) {
    const stableId = id ?? randomUUID();
    const draft = draftOf(value, stableId);
    const legacyType =
      typeof draft.type === 'string' && LEGACY_CARD_TYPES.includes(draft.type);
    if (draft.type === 'ref_obj') {
      const referenceNumbers =
        batchReferenceNumbers ??
        (await this.loadReferenceNumbers(tx, courseId));
      const payload = draft.approvedPayload as Prisma.InputJsonObject;
      const code = string(payload.code, 80);
      const aliases = new Set(
        strings(payload.aliases ?? [], 80, 80)
          .map((number) => number.normalize('NFKC'))
          .filter((number) => cellKey(number) !== cellKey(code)),
      );
      const numbers = new Set([code, ...aliases].map(cellKey));
      for (const [owner, stored] of referenceNumbers)
        for (const number of stored) {
          if (owner === stableId) {
            if (cellKey(number) !== cellKey(code)) aliases.add(number);
          } else if (numbers.has(cellKey(number)))
            throw new ConflictException('REFERENCE_CODE_IN_USE');
        }
      Object.assign(payload, { aliases: [...aliases] });
      batchReferenceNumbers?.set(stableId, [code, ...aliases]);
    }
    if (
      draft.type === 'concept' &&
      (draft.evidence as string[]).length &&
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
