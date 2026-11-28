import type { Prisma } from '@prisma/client';
import * as XLSX from 'xlsx';
import { compileTeachingPublication } from '../ai/tutor/teaching-package-publication';
import { FilesService } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReleasesService } from './releases.service';
import { TeachingCardsService } from './teaching-cards.service';
import {
  readTeachingWorkbook,
  referenceWordTemplate,
  teachingWorkbook,
} from './teaching-import-files';
import {
  portableTeachingCells,
  prepareSheetRow,
  sheetReferences,
} from './teaching-sheet-rows';

it('generates separate Word templates that enter the current conversion path', async () => {
  const stored = new Map<string, Buffer>();
  const files = new FilesService(
    {
      putMedia: (key: string, bytes: Buffer) =>
        Promise.resolve(stored.set(key, bytes)),
    } as never,
    {
      course: { findUnique: () => Promise.resolve({ id: 'lesson' }) },
      knowledgeImageAsset: { create: () => Promise.resolve({}) },
    } as never,
  );
  async function convert(kind: 'latex' | 'image') {
    const buffer = await referenceWordTemplate(kind);
    return files.convertFile(
      {
        originalname: 'example.docx',
        buffer,
        size: buffer.length,
      } as Express.Multer.File,
      'lesson',
    );
  }
  const formula = await convert('latex');
  const image = await convert('image');
  expect(formula.markdown).toContain('### L3-F01');
  expect(formula.markdown).toMatch(/\$\$\n\\frac\{dx\}\{dt\}=F\(x,t\)\n\$\$/);
  expect(image.markdown).toContain('### Exhibit 3.1');
  expect(image.markdown).toMatch(
    /!\[.*\]\(\/api\/files\/images\/lesson\/.+\.png\)/,
  );
  expect(image.markdown).not.toContain('$$');
  expect(stored.size).toBe(1);
});

it('reads only the declared headers, keeps multiline text and identifies row numbers', async () => {
  const values = [
    'State',
    'A state describes a system.',
    'First line.\nSecond line.',
  ];
  const book = teachingWorkbook('concept', [values], true);
  expect(await readTeachingWorkbook('concept', book)).toEqual([
    { row: 2, values, errors: [] },
  ]);
  await expect(readTeachingWorkbook('professor_qa', book)).rejects.toThrow(
    'TEACHING_SHEET_INVALID',
  );
  expect(
    await readTeachingWorkbook(
      'professor_qa',
      teachingWorkbook('professor_qa', [], false),
    ),
  ).toEqual([]);
});

const url = process.env.RELEASE_WORKSPACE_TEST_DATABASE_URL;
it('round-trips the two-field definition format without matching a passage', async () => {
  const values = ['State', '', 'A state describes the system at a given time.'];
  const book = XLSX.read(teachingWorkbook('concept', [], false), {
    type: 'buffer',
  });
  XLSX.utils.sheet_add_aoa(book.Sheets.Definitions, [[values[0], values[2]]], {
    origin: 'A2',
  });
  const bytes = XLSX.write(book, {
    type: 'buffer',
    bookType: 'xlsx',
  }) as Buffer;
  const [row] = await readTeachingWorkbook('concept', bytes);
  expect(row?.values).toEqual(values);
  expect(row.sourceOmitted).toBe(true);
  expect(
    prepareSheetRow('concept', row, [], sheetReferences(undefined)),
  ).toMatchObject({
    issues: [],
    sourcePage: null,
    draft: {
      evidence: [],
      approvedPayload: { definitionName: 'State', answerMd: values[2] },
    },
  });
  const previous = {
    evidence: ['An existing excerpt.'],
    approvedPayload: { sourcePageId: 'origin' },
  };
  expect(
    prepareSheetRow('concept', row, [], sheetReferences(undefined), previous)
      .draft,
  ).toMatchObject(previous);
  const [transferred] = await readTeachingWorkbook(
    'concept',
    teachingWorkbook('concept', [values], false),
  );
  expect(
    prepareSheetRow(
      'concept',
      transferred,
      [],
      sheetReferences(undefined),
      previous,
    ).draft,
  ).toMatchObject({ evidence: [] });
});
(url ? describe : describe.skip)(
  'transactional teaching workbook import',
  () => {
    const db = new PrismaService({ datasourceUrl: url });
    afterAll(() => db.$disconnect());

    it('binds a Lesson 3 excerpt and object, handles edited rows and exports the published version', async () => {
      const rollback = new Error('rollback fixtures');
      await expect(
        db.$transaction(
          async (tx) => {
            const local = Object.assign(Object.create(tx) as PrismaService, {
              $transaction: (
                work: (client: Prisma.TransactionClient) => unknown,
              ) => work(tx),
            });
            const cards = new TeachingCardsService(local);
            const releases = new ReleasesService(
              local,
              { indexRelease: () => Promise.resolve() } as never,
              {} as never,
              compileTeachingPublication,
            );
            const course = await tx.course.create({
              data: { title: 'Lesson 3 import verification' },
            });
            const excerpt =
              'That collection of arrows across the entire vector space is called a vector field.';
            const page = await tx.page.create({
              data: {
                courseId: course.id,
                title: 'Vector Fields',
                contentMd: excerpt,
                sortOrder: 0,
              },
            });
            const formula = {
              type: 'ref_obj',
              bilingual: {
                conceptLabel: { en: 'General dynamic system' },
                summary: { en: 'Quick reference for system change.' },
              },
              approvedPayload: {
                code: 'L3-F01',
                refObjects: [{ kind: 'latex', value: 'dx/dt=F(x,t)' }],
              },
            };
            await cards.importReferences(
              course.id,
              [{ draft: formula }],
              false,
              'expert',
            );
            const reference = (await cards.listReferences(course.id))[0];
            const definitions = [
              [
                'Vector field',
                excerpt,
                'A rule assigns a change vector to each point. See {{ref:L3-F01}}.',
              ],
            ];
            const questions = [
              [
                "Do 'state' and 'state variable' mean the same thing?",
                'The state describes the condition. State variables measure that condition. See {{ref:L3-F01}}.',
              ],
            ];
            for (const kind of ['concept', 'professor_qa'] as const) {
              const bytes = teachingWorkbook(
                kind,
                kind === 'concept' ? definitions : questions,
                true,
              );
              const rows = await readTeachingWorkbook(kind, bytes);
              const preview = await cards.previewTeachingSheet(
                course.id,
                kind,
                rows,
              );
              expect(preview.rows[0]).toMatchObject({
                status: 'new',
                sourcePage: kind === 'concept' ? 'Vector Fields' : null,
              });
              expect(
                await cards.importTeachingSheet(
                  course.id,
                  kind,
                  [rows[0]],
                  false,
                  'expert',
                  preview.stamp,
                ),
              ).toEqual({ saved: 1 });
              const same = await cards.previewTeachingSheet(
                course.id,
                kind,
                rows,
              );
              expect(same.rows[0].status).toBe('same');
              const bad = {
                row: 3,
                values:
                  kind === 'concept'
                    ? ['Bad', 'Missing passage', 'Copied text.']
                    : ['Bad', '{{ref:missing}}'],
                errors: [],
              };
              const invalid = await cards.previewTeachingSheet(
                course.id,
                kind,
                [bad],
              );
              expect(invalid.rows[0].status).toBe('invalid');
              const temporary = {
                row: 4,
                values:
                  kind === 'concept'
                    ? ['Temporary', excerpt, 'Valid explanation.']
                    : ['Temporary', 'Valid answer.'],
                errors: [],
              };
              const count = await tx.tutorTeachingCard.count({
                where: { courseId: course.id },
              });
              // The active PostgreSQL transaction is rolled back by this savepoint when the batch fails.
              await tx.$executeRawUnsafe('SAVEPOINT batch_import');
              await expect(
                cards.importTeachingSheet(
                  course.id,
                  kind,
                  [temporary, bad],
                  false,
                  'expert',
                  preview.stamp,
                ),
              ).rejects.toThrow('TEACHING_SHEET_CHANGED');
              await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT batch_import');
              expect(
                await tx.tutorTeachingCard.count({
                  where: { courseId: course.id },
                }),
              ).toBe(count);
            }
            const definition = (await cards.list(course.id)).find(
              (row) => (row.draft as Prisma.JsonObject).type === 'concept',
            )!;
            expect(definition.draft).toMatchObject({
              approvedPayload: {
                sourcePageId: page.id,
                answerMd: expect.stringContaining(
                  'refobj:' + reference.id,
                ) as string,
              },
            });

            const v1 = await releases.publish(course.id, {
              revisionNotes: 'V1',
            });
            const updated = {
              ...formula,
              approvedPayload: {
                ...formula.approvedPayload,
                refObjects: [{ kind: 'latex', value: 'dx/dt=G(x,t)' }],
              },
            };
            await cards.importReferences(
              course.id,
              [{ id: reference.id, revision: 1, draft: updated }],
              true,
              'expert',
            );
            expect((await cards.listReferences(course.id))[0]).toMatchObject({
              id: reference.id,
              value: 'dx/dt=G(x,t)',
            });
            const original = (await cards.list(course.id)).find(
              (row) => (row.draft as Prisma.JsonObject).type === 'professor_qa',
            )!;
            const renamed = {
              row: 2,
              values: ['Renamed question', 'New answer'],
              revision: original.revision,
              id: original.id,
            };
            const { stamp } = await cards.listWithStamp(course.id);
            await cards.importTeachingSheet(
              course.id,
              'professor_qa',
              [renamed],
              true,
              'expert',
              stamp,
            );
            await expect(
              cards.importTeachingSheet(
                course.id,
                'professor_qa',
                [renamed],
                true,
                'expert',
                stamp,
              ),
            ).rejects.toThrow('TEACHING_SHEET_CHANGED');
            const snapshot = v1.snapshotData as Prisma.JsonObject;
            const archived = snapshot.editor as {
              cards: { draft: Prisma.JsonValue }[];
            };
            const exported = archived.cards.flatMap((card) => {
              const cells = portableTeachingCells(
                'professor_qa',
                card.draft,
                sheetReferences(
                  snapshot.teachingPackageInput as Record<string, unknown>,
                ),
              );
              return cells ? [cells] : [];
            });
            expect(exported).toEqual(questions);
            throw rollback;
          },
          { timeout: 20000 },
        ),
      ).rejects.toBe(rollback);
    }, 25000);
  },
);
