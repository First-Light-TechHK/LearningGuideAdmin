import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import sharp from 'sharp';
import { PrismaService } from '../prisma/prisma.service';
import { FilesService } from '../files/files.service';
import { ReleasesService } from './releases.service';
import { ReleasePackagesService } from './release-packages.service';
import { TeachingCardsService } from './teaching-cards.service';
import { compileTeachingPublication } from '../ai/tutor/teaching-package-publication';
import type { Prisma } from '@prisma/client';

// Run in a rollback-only transaction. Each environment has its own image store.
const url = process.env.RELEASE_WORKSPACE_TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  'single Release migration between course IDs',
  () => {
    const db = new PrismaService({ datasourceUrl: url });
    afterAll(() => db.$disconnect());
    it('restores V1 with local images, references and evidence while the source is offline', async () => {
      const rolledBack = new Error('rollback fixture');
      await expect(
        db.$transaction(
          async (tx) => {
            const local = Object.assign(Object.create(tx) as PrismaService, {
              $transaction: (
                work: (client: Prisma.TransactionClient) => unknown,
              ) => work(tx),
            });
            const indexing = {
              indexRelease: jest.fn().mockResolvedValue(undefined),
            } as never;
            function environment() {
              const bytes = new Map<string, Buffer>();
              const storage = {
                getMedia: (key: string) => {
                  const blob = bytes.get(key);
                  if (!blob) throw Error('offline');
                  return Promise.resolve(blob);
                },
                putMedia: (key: string, blob: Buffer) => {
                  bytes.set(key, blob);
                  return Promise.resolve();
                },
                removeMedia: (key: string) => {
                  bytes.delete(key);
                  return Promise.resolve();
                },
              };
              const files = new FilesService(storage as never, local);
              const releases = new ReleasesService(
                local,
                indexing,
                files,
                compileTeachingPublication,
              );
              const packages = new ReleasePackagesService(
                local,
                files,
                indexing,
                compileTeachingPublication,
              );
              return { bytes, releases, packages, files };
            }
            const a = environment(),
              b = environment();
            const source = await tx.course.create({
              data: { title: 'Source' },
            });
            const target = await tx.course.create({
              data: { title: 'Target' },
            });
            const cards = new TeachingCardsService(local);
            const png = await sharp({
              create: { width: 2, height: 2, channels: 3, background: 'white' },
            })
              .png()
              .toBuffer();
            const asset = randomUUID() + '.png';
            a.bytes.set('knowledge-pages/' + source.id + '/' + asset, png);
            const ref = await cards.save(
              source.id,
              undefined,
              undefined,
              {
                type: 'ref_obj',
                bilingual: {
                  conceptLabel: { en: 'Figure' },
                  summary: { en: 'A figure' },
                },
                approvedPayload: {
                  code: 'F1',
                  refObjects: [{ kind: 'image', value: asset }],
                },
              },
              'author',
            );
            const passage = 'A state describes a system.';
            const draftOnly = randomUUID() + '.png';
            a.bytes.set('knowledge-pages/' + source.id + '/' + draftOnly, png);
            const imageDraft = ref.draft as Prisma.JsonObject;
            const imagePayload =
              imageDraft.approvedPayload as Prisma.JsonObject;
            const objects = imagePayload.refObjects as Prisma.JsonObject[];
            await tx.tutorTeachingCard.update({
              where: { id: ref.id },
              data: {
                draft: {
                  ...imageDraft,
                  approvedPayload: {
                    ...imagePayload,
                    refObjects: [{ ...objects[0], value: draftOnly }],
                  },
                },
              },
            });
            const formula = await cards.save(
              source.id,
              undefined,
              undefined,
              {
                type: 'ref_obj',
                bilingual: {
                  conceptLabel: { en: 'Equation' },
                  summary: { en: 'State equation' },
                },
                approvedPayload: {
                  code: 'E1',
                  refObjects: [{ kind: 'latex', value: 'T(t)' }],
                },
              },
              'author',
            );
            const link = '[Figure](refobj:' + ref.id + ')';
            const page = await tx.page.create({
              data: {
                courseId: source.id,
                title: 'Lesson',
                externalId: 'lesson',
                sortOrder: 3,
                sectionTags: { intro: ['tag'] },
                contentMd:
                  passage +
                  '\n' +
                  link +
                  '\n![Fig](/api/files/images/' +
                  source.id +
                  '/' +
                  asset +
                  ')',
              },
            });
            await cards.save(
              source.id,
              undefined,
              undefined,
              {
                type: 'concept',
                evidence: [passage],
                approvedPayload: {
                  definitionName: 'State',
                  answerMd: 'A system state.',
                  sourcePageId: page.id,
                },
              },
              'author',
            );
            await cards.save(
              source.id,
              undefined,
              undefined,
              {
                type: 'professor_qa',
                approvedPayload: {
                  question: 'What is state?',
                  answerMd:
                    'See ' +
                    link +
                    ' and [Equation](refobj:' +
                    formula.id +
                    ')',
                },
              },
              'author',
            );
            const v1 = await a.releases.publish(source.id, {
              revisionNotes: 'V1',
            });
            await tx.page.update({
              where: { id: page.id },
              data: { contentMd: 'later edit' },
            });
            const exported = await a.packages.download(v1.id);
            a.bytes.clear();
            const preview = await b.packages.import(
              target.id,
              exported.buffer,
              false,
            );
            expect(preview).toMatchObject({ pages: 1, cards: 4, images: 2 });
            const stage = b.files.stageReleaseImage.bind(b.files);
            const failing = jest
              .spyOn(b.files, 'stageReleaseImage')
              .mockImplementationOnce(stage)
              .mockRejectedValueOnce(new Error('storage unavailable'));
            await expect(
              b.packages.import(target.id, exported.buffer, true),
            ).rejects.toThrow('storage unavailable');
            failing.mockRestore();
            expect(b.bytes.size).toBe(0);
            expect(
              await tx.knowledgeImageAsset.count({
                where: { courseId: target.id },
              }),
            ).toBe(0);
            expect(
              await tx.release.count({ where: { courseId: target.id } }),
            ).toBe(0);
            const imported = await b.packages.import(
              target.id,
              exported.buffer,
              true,
            );
            const again = await b.packages.import(
              target.id,
              exported.buffer,
              true,
            );
            expect(again.id).toBe(imported.id);
            expect(
              await tx.release.count({ where: { courseId: target.id } }),
            ).toBe(1);
            expect(
              await tx.course.findUniqueOrThrow({ where: { id: target.id } }),
            ).toMatchObject({
              editingReleaseId: null,
              currentReleaseId: null,
              aiTestReleaseId: null,
            });
            await b.releases.activate(target.id, { releaseId: imported.id! });
            const restored = await tx.page.findFirstOrThrow({
              where: { courseId: target.id },
            });
            const refs = await cards.listReferences(target.id);
            const restoredRef = refs.find((x) => x.code === 'F1')!;
            const equation = refs.find((x) => x.code === 'E1')!;
            expect(equation.value).toBe('T(t)');
            const restoredCards = await cards.list(target.id);
            expect(
              restoredCards.find(
                (c) => (c.draft as Prisma.JsonObject).type === 'professor_qa',
              )?.draft,
            ).toMatchObject({
              approvedPayload: {
                answerMd:
                  'See [Figure](refobj:' +
                  restoredRef.id +
                  ') and [Equation](refobj:' +
                  equation.id +
                  ')',
              },
            });
            expect(restored.contentMd).toContain(passage);
            expect(restored.contentMd).toContain(
              '(refobj:' + restoredRef.id + ')',
            );
            expect(restored.contentMd).toContain(
              '/api/files/images/' + target.id + '/' + restoredRef.value,
            );
            expect(
              (await b.files.getImage(target.id, restoredRef.value))?.bytes,
            ).toEqual(png);
            expect(
              (await cards.list(target.id)).find(
                (row) => (row.draft as Prisma.JsonObject).type === 'concept',
              )?.draft,
            ).toMatchObject({ approvedPayload: { sourcePageId: restored.id } });
            const roundTrip = await b.packages.download(imported.id!);
            const manifest = async (bytes: Buffer) =>
              (await JSZip.loadAsync(bytes))
                .file('manifest.json')!
                .async('string');
            expect(JSON.parse(await manifest(roundTrip.buffer))).toEqual(
              JSON.parse(await manifest(exported.buffer)),
            );
            const broken = await JSZip.loadAsync(exported.buffer);
            broken.remove('images/' + asset);
            await expect(
              b.packages.import(
                target.id,
                await broken.generateAsync({ type: 'nodebuffer' }),
                true,
              ),
            ).rejects.toThrow();
            throw rolledBack;
          },
          { timeout: 45000 },
        ),
      ).rejects.toBe(rolledBack);
    }, 60000);
  },
);
