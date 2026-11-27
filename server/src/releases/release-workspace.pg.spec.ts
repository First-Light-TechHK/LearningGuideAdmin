import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PagesService } from '../pages/pages.service';
import { TeachingCardsService } from './teaching-cards.service';
import { ReleasesService } from './releases.service';
import { compileTeachingPublication } from '../ai/tutor/teaching-package-publication';

// Only run against an explicitly supplied migrated test database.
const url = process.env.RELEASE_WORKSPACE_TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  'Release editor round trip on PostgreSQL',
  () => {
    const db = new PrismaService({ datasourceUrl: url });
    const courseId = randomUUID();
    const cards = new TeachingCardsService(db);
    const pages = new PagesService(db);
    const releases = new ReleasesService(
      db,
      {
        indexRelease: () => Promise.resolve(),
        status: () => 'missing',
      } as never,
      {} as never,
      compileTeachingPublication,
    );
    afterAll(async () => {
      try {
        await db.release.deleteMany({ where: { courseId } });
        await db.course.deleteMany({ where: { id: courseId } });
      } finally {
        await db.$disconnect();
      }
    });

    it('restores page identities, deleted references and definitions, rejects stale writes and republishes V1', async () => {
      await db.course.create({ data: { id: courseId, title: 'Test course' } });
      const page = await db.page.create({
        data: {
          courseId,
          externalId: 'lesson',
          title: 'Vectors',
          contentMd: 'An exact passage.',
          sortOrder: 6,
          sectionTags: { vectors: ['tag'] },
        },
      });
      await db.page.create({
        data: {
          courseId,
          title: 'Stale',
          contentMd: 'Local notes',
          sortOrder: 7,
          syncState: 'STALE',
        },
      });
      const ref = await cards.save(
        courseId,
        undefined,
        undefined,
        {
          type: 'ref_obj',
          bilingual: {
            conceptLabel: { en: 'Acceleration' },
            summary: { en: 'Acceleration formula' },
          },
          approvedPayload: {
            code: 'F1',
            refObjects: [{ kind: 'latex', value: 'a=F/m' }],
          },
        },
        'author',
      );
      const definition = {
        type: 'concept',
        evidence: [page.contentMd],
        approvedPayload: {
          definitionName: 'Vector',
          answerMd: 'A directed quantity.',
          sourcePageId: page.id,
        },
      };
      const defined = await cards.save(
        courseId,
        undefined,
        undefined,
        definition,
        'author',
      );
      const qa = (answerMd: string) => ({
        type: 'professor_qa',
        approvedPayload: { question: 'Which formula?', answerMd },
      });
      const answer = await cards.save(
        courseId,
        undefined,
        undefined,
        qa('Use [F1](refobj:' + ref.id + ')'),
        'author',
      );
      const pending = await db.tutorTeachingCard.create({
        data: { courseId, draft: { note: 'unapproved' }, additionPosition: 4 },
      });
      const before = await cards.list(courseId);
      const v1 = await releases.publish(courseId, { revisionNotes: 'V1' });
      const stampV1 = (await cards.listWithStamp(courseId)).stamp;
      await cards.save(
        courseId,
        answer.id,
        answer.revision,
        qa('Use answer B.'),
        'editor',
        stampV1,
      );
      expect(
        await cards.deleteSelection(
          courseId,
          [{ id: ref.id, revision: ref.revision }],
          false,
        ),
      ).toEqual({ blockers: [] });
      await pages.update(page.id, { title: 'Edited' });
      const v2 = await releases.publish(courseId, { revisionNotes: 'V2' });
      await db.course.update({
        where: { id: courseId },
        data: { currentReleaseId: v2.id },
      });
      await releases.activate(courseId, { releaseId: v1.id });
      const after = await cards.listWithStamp(courseId);
      expect(after.entries).toEqual(
        before.map((row) => ({
          ...row,
          updatedAt: expect.any(Date) as Date,
        })),
      );
      expect(
        after.entries.find((row) => row.id === pending.id)?.approved,
      ).toBeNull();
      expect(await db.page.findUnique({ where: { id: page.id } })).toEqual(
        page,
      );
      expect(
        await db.page.count({ where: { courseId, syncState: 'STALE' } }),
      ).toBe(1);
      expect(after.stamp).not.toBe(stampV1);
      await expect(
        cards.save(
          courseId,
          defined.id,
          defined.revision,
          definition,
          'editor',
          stampV1,
        ),
      ).rejects.toThrow(ConflictException);
      await expect(
        pages.update(page.id, { title: 'Stale save' }, stampV1),
      ).rejects.toThrow(ConflictException);
      const v3 = await releases.publish(courseId, { revisionNotes: 'V3' });
      const first = v1.snapshotData as Prisma.JsonObject;
      const third = v3.snapshotData as Prisma.JsonObject;
      expect(third.editor).toEqual(first.editor);
      expect(third.pages).toEqual(first.pages);
      expect(third.teachingPackageInput).toEqual(first.teachingPackageInput);
      expect(await db.release.findUnique({ where: { id: v2.id } })).toEqual(v2);
      expect(
        await db.course.findUnique({ where: { id: courseId } }),
      ).toMatchObject({ currentReleaseId: v2.id, editingReleaseId: v3.id });
      await expect(
        cards.save(
          courseId,
          defined.id,
          defined.revision,
          definition,
          'editor',
        ),
      ).resolves.toMatchObject({ id: defined.id });
    });
  },
);
