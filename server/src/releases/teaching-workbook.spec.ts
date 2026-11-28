import type { PrismaService } from '../prisma/prisma.service';
import type { FilesService } from '../files/files.service';
import { request as expressRequest, type Response } from 'express';
import * as XLSX from 'xlsx';
import type { ReleasePackagesService } from './release-packages.service';
import { ReleasesController } from './releases.controller';
import type { ReleasesService } from './releases.service';
import { TeachingCardsService } from './teaching-cards.service';
import {
  readTeachingWorkbook,
  readTeachingWorkbookSheets,
  teachingWorkbook,
  teachingWorkbookSheets,
} from './teaching-import-files';

const definition = {
  type: 'concept',
  evidence: ['A state describes a system.'],
  approvedPayload: {
    definitionName: 'State',
    answerMd: 'The condition of a system.',
  },
};
const question = {
  type: 'professor_qa',
  approvedPayload: {
    question: 'Why model a state?',
    answerMd: 'See [Flow](refobj:f1).',
  },
};

function readWorkbook(bytes: Buffer) {
  return XLSX.read(bytes, { type: 'buffer' });
}

it('writes English headers and only the requested sheets from the teaching workspace', async () => {
  const entries = [
    { id: 'concept', draft: definition },
    { id: 'professor_qa', draft: question },
  ];
  const tx = {
    course: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ title: 'Course' }),
      findUnique: jest.fn().mockResolvedValue({ editingReleaseId: null }),
    },
    tutorTeachingCard: {
      findMany: jest.fn(({ where }: { where: { id?: { in: string[] } } }) =>
        where.id
          ? entries.filter(({ id }) => where.id?.in.includes(id))
          : [
              {
                id: 'f1',
                reviewerId: 'editor',
                deletedAt: null,
                approved: {
                  type: 'ref_obj',
                  conceptId: 'reference',
                  bilingual: { conceptLabel: { en: 'Flow', zh: '' } },
                  approvedPayload: {
                    code: 'L1-F01',
                    refObjects: [
                      {
                        id: 'f1',
                        code: 'L1-F01',
                        kind: 'latex',
                        label: 'Flow',
                        value: 'x+y',
                        requires: [],
                      },
                    ],
                  },
                },
              },
            ],
      ),
    },
  };
  const controller = new ReleasesController(
    {} as ReleasesService,
    new TeachingCardsService({
      $transaction: (run: (client: typeof tx) => unknown) => run(tx),
    } as unknown as PrismaService),
    {} as ReleasePackagesService,
    {} as FilesService,
  );
  for (const selection of ['concept', 'professor_qa', 'professor_qa,concept']) {
    const send = jest.fn<void, [Buffer]>();
    const response = {
      setHeader: jest.fn(),
      type: jest.fn().mockReturnValue({ send }),
    };
    await controller.downloadCurrentTeaching(
      'course',
      'workbook',
      'zh-CN',
      undefined,
      selection.split(',').map((kind) => ({ kind, ids: [kind] })),
      response as unknown as Response,
    );
    const bytes = send.mock.calls[0][0];
    const { sheets } = await readTeachingWorkbookSheets(bytes);
    expect(sheets.map(({ kind }) => kind)).toEqual(
      ['concept', 'professor_qa'].filter((kind) => selection.includes(kind)),
    );
    const book = readWorkbook(bytes);
    if (selection.includes('concept')) {
      expect(
        XLSX.utils.sheet_to_json(book.Sheets.Definitions, { header: 1 }),
      ).toEqual([
        ['Definition name', 'Textbook excerpt', 'Definition'],
        ['State', 'A state describes a system.', 'The condition of a system.'],
      ]);
    }
    if (selection.includes('professor_qa')) {
      const rows = XLSX.utils.sheet_to_json<unknown[]>(
        book.Sheets['Professor Q&A'],
        { header: 1 },
      );
      expect(rows.map((row) => row[0])).toEqual([
        'Student question',
        'Why model a state?',
      ]);
      expect(rows[1][1]).toBe('See {{ref:L1-F01}}.');
      expect(
        sheets
          .find((sheet) => sheet.kind === 'professor_qa')
          ?.rows[0].dependencies?.get('l1-f01'),
      ).toMatch(/^[a-f0-9]{64}$/);
    } else {
      expect(book.SheetNames).not.toContain('_TeachingReferences');
    }
  }
});

it('uses sheet names independently of position and reads the old single-sheet format', async () => {
  const deps = new Map([['l1-f01', 'a'.repeat(64)]]);
  const bytes = teachingWorkbookSheets(
    [
      { kind: 'professor_qa', rows: [['Question?', 'See {{ref:L1-F01}}.']] },
      { kind: 'concept', rows: [] },
    ],
    deps,
  );
  const book = readWorkbook(bytes);
  expect(
    book.Workbook?.Sheets?.find((sheet) => sheet.name === '_TeachingReferences')
      ?.Hidden,
  ).toBe(1);
  expect(
    XLSX.utils.sheet_to_json(book.Sheets.Definitions, { header: 1 }),
  ).toEqual([['Definition name', 'Definition']]);
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([['Notes']]),
    'Draft notes',
  );
  XLSX.utils.sheet_add_aoa(book.Sheets.Definitions, [['Wrong heading']], {
    origin: 'A1',
  });
  const review = await readTeachingWorkbookSheets(
    XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
  );
  expect(review.skippedSheets).toEqual(['Draft notes']);
  expect(review.sheets[0]).toMatchObject({
    kind: 'professor_qa',
    rows: [
      {
        row: 2,
        values: ['Question?', 'See {{ref:L1-F01}}.'],
        dependencies: deps,
      },
    ],
  });
  expect(review.sheets[1]).toMatchObject({
    kind: 'concept',
    invalid: true,
    rows: [],
  });
  XLSX.utils.book_set_sheet_visibility(book, 'Definitions', 1);
  const hidden = await readTeachingWorkbookSheets(
    XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
  );
  expect(hidden.skippedSheets).toEqual(['Definitions', 'Draft notes']);
  expect(hidden.sheets.map((sheet) => sheet.kind)).toEqual(['professor_qa']);

  const legacy = teachingWorkbook('concept', [['State', '', 'Meaning.']], true);
  expect((await readTeachingWorkbookSheets(legacy)).sheets[0].rows).toEqual(
    await readTeachingWorkbook('concept', legacy),
  );
});

it('does not misclassify a new workbook with only an unsupported sheet as a legacy file', async () => {
  const template = readWorkbook(
    teachingWorkbookSheets([{ kind: 'concept', rows: [] }]),
  );
  const future = XLSX.utils.book_new();
  future.Custprops = template.Custprops;
  XLSX.utils.book_append_sheet(
    future,
    template.Sheets.Definitions,
    'Future content',
  );
  await expect(
    readTeachingWorkbookSheets(
      XLSX.write(future, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
    ),
  ).rejects.toThrow('TEACHING_SHEET_INVALID');
});

it('writes selections in a single transaction and rolls back the first sheet if the second fails', async () => {
  const stamp = new Date('2026-11-28T02:00:00Z');
  const committed: string[] = [];
  const transaction = jest.fn(
    async (work: (tx: unknown) => Promise<unknown>) => {
      const staged: string[] = [];
      const tx = {
        $executeRaw: jest.fn(),
        $queryRaw: jest.fn(),
        course: {
          findUnique: jest.fn().mockResolvedValue({ updatedAt: stamp }),
          findUniqueOrThrow: jest.fn().mockResolvedValue({ updatedAt: stamp }),
        },
        page: { findMany: jest.fn().mockResolvedValue([]) },
        tutorTeachingCard: {
          findMany: jest.fn().mockResolvedValue([]),
          create: ({ data }: { data: { draft: { type: string } } }) =>
            Promise.resolve(staged.push(data.draft.type)),
        },
      };
      const result = await work(tx);
      committed.push(...staged);
      return result;
    },
  );
  const service = new TeachingCardsService({
    $transaction: transaction,
  } as unknown as PrismaService);
  const controller = new ReleasesController(
    {} as ReleasesService,
    service,
    {} as ReleasePackagesService,
    {} as FilesService,
  );
  const file = {
    originalname: 'Teaching Entries.xlsx',
    buffer: teachingWorkbookSheets([
      { kind: 'concept', rows: [['State', '', 'A condition.']] },
      {
        kind: 'professor_qa',
        rows: [['Why model a state?', 'To describe how a system evolves.']],
      },
    ]),
  } as Express.Multer.File;
  const review = await controller.previewTeachingSheet(
    'course',
    'workbook',
    file,
  );
  expect(review.stamp).toBe(stamp.toISOString());
  expect(review).toMatchObject({
    sheets: [
      { kind: 'concept', rows: [{ row: 2, status: 'new' }] },
      { kind: 'professor_qa', rows: [{ row: 2, status: 'new' }] },
    ],
  });
  transaction.mockClear();
  const request = Object.assign(
    Object.create(expressRequest) as typeof expressRequest,
    {
      employee: { employeeId: 'employee' },
      headers: { 'x-workspace-stamp': review.stamp },
    },
  );
  const definition = { kind: 'concept', row: 2 };
  const question = { kind: 'professor_qa', row: 2 };
  await expect(
    controller.applyTeachingSheet(
      'course',
      'workbook',
      JSON.stringify([definition, { ...question, id: 'changed', revision: 1 }]),
      request,
      file,
    ),
  ).rejects.toThrow('TEACHING_SHEET_CHANGED');
  expect(transaction).toHaveBeenCalledTimes(1);
  expect(committed).toEqual([]);
  await expect(
    controller.applyTeachingSheet(
      'course',
      'workbook',
      JSON.stringify([definition, question]),
      request,
      file,
    ),
  ).resolves.toEqual({ saved: 2 });
  expect(transaction).toHaveBeenCalledTimes(2);
  expect(committed).toEqual(['concept', 'professor_qa']);

  const fullWorkbook = {
    ...file,
    buffer: teachingWorkbookSheets([
      {
        kind: 'concept',
        rows: Array.from({ length: 500 }, (_, index) => [
          `Definition ${index}`,
          '',
          'A condition.',
        ]),
      },
      {
        kind: 'professor_qa',
        rows: Array.from({ length: 500 }, (_, index) => [
          `Question ${index}?`,
          'An answer.',
        ]),
      },
    ]),
  };
  const fullReview = await controller.previewTeachingSheet(
    'course',
    'workbook',
    fullWorkbook,
  );
  if (!('sheets' in fullReview)) throw new Error('Expected a workbook review');
  expect(fullReview.sheets.map(({ rows }) => rows.length)).toEqual([500, 500]);
  const selection = fullReview.sheets.flatMap(({ kind, rows }) =>
    rows.map(({ row }) => ({ kind, row })),
  );
  await expect(
    controller.applyTeachingSheet(
      'course',
      'workbook',
      JSON.stringify(selection),
      request,
      fullWorkbook,
    ),
  ).resolves.toEqual({ saved: 1000 });
  expect(committed).toHaveLength(1002);

  const tooMany = await readTeachingWorkbookSheets(
    teachingWorkbookSheets([
      {
        kind: 'concept',
        rows: Array.from({ length: 501 }, (_, index) => [
          `Definition ${index}`,
          '',
          'A condition.',
        ]),
      },
    ]),
  );
  expect(tooMany.sheets[0]).toMatchObject({ invalid: true, rows: [] });
});
