import type { Prisma } from '@prisma/client';
import sharp from 'sharp';
import { FilesService } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import { readTeachingWorkbook } from './teaching-import-files';
import { TeachingCardsService } from './teaching-cards.service';

const url = process.env.RELEASE_WORKSPACE_TEST_DATABASE_URL;
(url ? describe : describe.skip)('current teaching content transfer', () => {
  const db = new PrismaService({ datasourceUrl: url });
  afterAll(() => db.$disconnect());

  it('restores four file types across course and reference IDs; detects dependency drift and cleans previews', async () => {
    const rollback = new Error('rollback transfer fixtures');
    await expect(
      db.$transaction(
        async (tx) => {
          const local = Object.assign(Object.create(tx) as PrismaService, {
            $transaction: (
              work: (client: Prisma.TransactionClient) => unknown,
            ) => work(tx),
          });
          const storage = new Map<string, Buffer>();
          const files = new FilesService(
            {
              getMedia: (key: string) => {
                const bytes = storage.get(key);
                return bytes
                  ? Promise.resolve(bytes)
                  : Promise.reject(new Error('missing image'));
              },
              putMedia: (key: string, bytes: Buffer) =>
                Promise.resolve(storage.set(key, bytes)),
              removeMedia: (key: string) =>
                Promise.resolve(storage.delete(key)),
            } as never,
            local,
          );
          const cards = new TeachingCardsService(local, files);
          const source = await tx.course.create({
            data: { title: 'Lesson 3 A' },
          });
          const target = await tx.course.create({
            data: { title: 'Lesson 3 B' },
          });
          const matrix = String.raw`\begin{bmatrix}
x & y \\
a & b
\end{bmatrix}`;
          const webp = await sharp({
            create: { width: 3, height: 3, channels: 3, background: 'red' },
          })
            .webp()
            .toBuffer();
          const png = await sharp({
            create: { width: 3, height: 3, channels: 3, background: 'blue' },
          })
            .png()
            .toBuffer();
          const uploaded1 = await files.storeImage(source.id, {
            size: webp.length,
            buffer: webp,
          } as Express.Multer.File);
          const uploaded2 = await files.storeImage(source.id, {
            size: png.length,
            buffer: png,
          } as Express.Multer.File);
          const images = [
            uploaded1.url.split('/').at(-1)!,
            uploaded2.url.split('/').at(-1)!,
          ];
          const reference = (
            kind: 'image' | 'latex',
            code: string,
            value: string,
          ) => ({
            type: 'ref_obj',
            bilingual: {
              conceptLabel: { en: 'Dynamic system', zh: '系统' },
              summary: {
                en: 'First line.\nSecond line with 中文.',
                zh: '第三行。',
              },
            },
            approvedPayload: {
              code,
              displayName: code + ' imported object',
              aliases: code === 'L3-F01' ? ['Legacy-F01'] : [],
              refObjects: [{ kind, value }],
            },
          });
          const formula = await cards.save(
            source.id,
            undefined,
            undefined,
            reference('latex', 'L3-F01', matrix),
            'editor',
          );
          const simple = await cards.save(
            source.id,
            undefined,
            undefined,
            reference('latex', 'Simple-2', 'x=1'),
            'editor',
          );
          const image = await cards.save(
            source.id,
            undefined,
            undefined,
            reference('image', 'Exhibit 3.1', images[0]),
            'editor',
          );
          const pngCard = await cards.save(
            source.id,
            undefined,
            undefined,
            reference('image', 'Exhibit 3.2', images[1]),
            'editor',
          );

          for (const [kind, ids] of [
            ['latex', [formula.id, simple.id]],
            ['image', [image.id, pngCard.id]],
          ] as const) {
            const doc = await cards.download(source.id, kind, ids, false);
            const file = {
              originalname: doc.filename,
              size: doc.buffer.length,
              buffer: doc.buffer,
            } as Express.Multer.File;
            const preview = await files.previewReferenceDocument(
              file,
              target.id,
              kind,
              'editor',
            );
            const rows = preview.rows!;
            expect(rows).toHaveLength(2);
            const items = rows.map((row) => ({
              draft: {
                type: 'ref_obj',
                bilingual: { conceptLabel: row.names, summary: row.summary },
                approvedPayload: {
                  code: row.code,
                  aliases: row.aliases,
                  displayName: row.displayName,
                  refObjects: [{ kind, value: row.value }],
                },
              },
            }));
            expect(
              await cards.importReferences(target.id, items, false, 'editor'),
            ).toEqual({ saved: 2 });
            if (preview.token) {
              await files.finishReferencePreview(
                target.id,
                preview.token,
                'editor',
              );
              for (const row of rows)
                expect(await files.getImage(target.id, row.value)).toBeTruthy();
              const cancelled = await files.previewReferenceDocument(
                file,
                target.id,
                kind,
                'editor',
              );
              await files.finishReferencePreview(
                target.id,
                cancelled.token!,
                'other',
              );
              expect(
                await files.getImage(target.id, cancelled.rows![0].value),
              ).toBeTruthy();
              await files.finishReferencePreview(
                target.id,
                cancelled.token!,
                'editor',
              );
              expect(
                (await files.getImage(target.id, cancelled.rows![0].value))
                  ?.bytes,
              ).toBeUndefined();
            }
          }
          const refs = await cards.listReferences(target.id);
          const restoredFormula = refs.find((ref) => ref.code === 'L3-F01')!;
          const restoredImage = refs.find((ref) => ref.code === 'Exhibit 3.1')!;
          expect(restoredFormula.id).not.toBe(formula.id);
          expect(restoredFormula.value).toBe(matrix);
          expect(
            (await files.getImage(target.id, restoredImage.value))?.bytes,
          ).toEqual(webp);
          expect(
            (
              await files.getImage(
                target.id,
                refs.find((ref) => ref.code === 'Exhibit 3.2')!.value,
              )
            )?.bytes,
          ).toEqual(png);
          expect(refs.find((ref) => ref.code === 'Simple-2')?.value).toBe(
            'x=1',
          );
          const passage = (id: string) =>
            'See [state illustration](refobj:' + id + ') in this lesson.';
          for (const [courseId, refId] of [
            [source.id, image.id],
            [target.id, restoredImage.id],
          ])
            await tx.page.create({
              data: {
                courseId,
                title: 'Vector Fields',
                contentMd: passage(refId),
                sortOrder: 0,
              },
            });

          const definition = await cards.save(
            source.id,
            undefined,
            undefined,
            {
              type: 'concept',
              evidence: [passage(image.id)],
              approvedPayload: {
                definitionName: 'Vector field',
                answerMd: 'Uses [this rule](refobj:' + formula.id + ').',
              },
            },
            'editor',
          );
          const question = await cards.save(
            source.id,
            undefined,
            undefined,
            {
              type: 'professor_qa',
              approvedPayload: {
                question: 'What changes?',
                answerMd: 'See [this illustration](refobj:' + image.id + ').',
              },
            },
            'editor',
          );
          for (const [kind, cardId] of [
            ['concept', definition.id],
            ['professor_qa', question.id],
          ] as const) {
            const exported = await cards.download(
              source.id,
              kind,
              [cardId],
              true,
            );
            const rows = await readTeachingWorkbook(kind, exported.buffer);
            expect(rows[0].dependencies?.size).toBe(kind === 'concept' ? 2 : 1);
            expect(rows[0].values.join(' ')).not.toMatch(/refobj:/);
            const preview = await cards.previewTeachingSheet(
              target.id,
              kind,
              rows,
            );
            expect(preview.rows[0]).toMatchObject({
              status: 'new',
              sourcePage: kind === 'concept' ? 'Vector Fields' : null,
            });
            await cards.importTeachingSheet(
              target.id,
              kind,
              [{ ...rows[0], binding: preview.rows[0].binding }],
              false,
              'editor',
              preview.stamp,
            );
            expect(
              (await cards.previewTeachingSheet(target.id, kind, rows)).rows[0]
                .status,
            ).toBe('same');
          }
          const xlsx = await cards.download(
            source.id,
            'concept',
            [definition.id],
            true,
          );
          const rows = await readTeachingWorkbook('concept', xlsx.buffer);
          const renamed = {
            ...rows[0],
            values: ['Renamed', ...rows[0].values.slice(1)],
          };
          expect(
            (await cards.previewTeachingSheet(target.id, 'concept', [renamed]))
              .rows[0].status,
          ).toBe('rename');
          const reviewed = await cards.previewTeachingSheet(
            target.id,
            'concept',
            rows,
          );
          const entry = reviewed.targets.find(
            (item) => item.title === 'Vector field',
          )!;
          await cards.importTeachingSheet(
            target.id,
            'concept',
            [renamed],
            false,
            'editor',
            reviewed.stamp,
          );
          await expect(
            cards.importTeachingSheet(
              target.id,
              'concept',
              [{ ...renamed, id: entry.id, revision: entry.revision }],
              true,
              'editor',
              reviewed.stamp,
            ),
          ).rejects.toThrow('TEACHING_SHEET_CHANGED');
          const original = await tx.tutorTeachingCard.findUniqueOrThrow({
            where: { id: restoredFormula.id },
          });
          await cards.save(
            target.id,
            original.id,
            original.revision,
            reference('latex', 'L3-F01', 'x=2'),
            'editor',
          );
          const blocked = await cards.previewTeachingSheet(
            target.id,
            'concept',
            rows,
          );
          expect(blocked.rows[0]).toMatchObject({
            status: 'invalid',
            issues: [{ column: 2, code: 'referenceChanged', detail: 'L3-F01' }],
          });
          await expect(
            cards.importTeachingSheet(
              target.id,
              'concept',
              [
                {
                  ...rows[0],
                  id: entry.id,
                  revision: entry.revision,
                  binding: reviewed.rows[0].binding,
                },
              ],
              true,
              'editor',
              reviewed.stamp,
            ),
          ).rejects.toThrow('TEACHING_SHEET_CHANGED');
          throw rollback;
        },
        { timeout: 25000 },
      ),
    ).rejects.toBe(rollback);
  }, 30000);
});
