import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ProfessorQaIndexService } from '../knowledge/professor-qa-index.service';
import type { EmbeddingService } from '../ai/embedding/embedding.service';
import { searchProfessorQa } from './professor-qa-search';

const url = process.env.PROFESSOR_QA_TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  'professor QA on an isolated migrated PostgreSQL database',
  () => {
    const db = new PrismaService(url ? { datasourceUrl: url } : undefined);
    const courseId = randomUUID();
    const other = randomUUID();
    const vec = (n: number) =>
      Array.from({ length: 1536 }, (_, i) => Number(i === n));
    // Three deliberately orthogonal semantic classes; the database performs the actual distance calculation.
    const embedding = {
      model: 'fixture-' + courseId,
      embedTexts: jest.fn((texts: string[]) =>
        Promise.resolve(texts.map((t) => vec(t.includes('pendulum') ? 0 : 1))),
      ),
      embedQuery: jest.fn(() => Promise.resolve(vec(0))),
    };
    const worker = new ProfessorQaIndexService(
      db,
      embedding as unknown as EmbeddingService,
    );
    const allowed = ['pendulum', 'other'];
    const add = (course: string, suffix: string) =>
      db.release.create({
        data: {
          courseId: course,
          versionTag: suffix,
          revisionNotes: '',
          snapshotData: {
            teachingPackage: {
              cards: [
                {
                  cardId: 'period-definition',
                  type: 'concept',
                  bilingual: {
                    conceptLabel: { en: 'pendulum period' },
                    summary: { en: 'Time for a full swing.' },
                    triggers: { en: ['oscillation duration'] },
                  },
                },
                {
                  cardId: 'pendulum',
                  type: 'professor_qa',
                  approvedPayload: {
                    question: 'pendulum period',
                    answerMd:
                      'Small oscillations are approximately isochronous. ' +
                      suffix,
                  },
                },
                {
                  cardId: 'other',
                  type: 'professor_qa',
                  approvedPayload: {
                    question: 'another concept',
                    answerMd: 'another answer',
                  },
                },
              ],
            },
          },
        },
      });
    afterAll(async () => {
      await db.release.deleteMany({
        where: { courseId: { in: [courseId, other] } },
      });
      await db.course.deleteMany({ where: { id: { in: [courseId, other] } } });
      await db.$disconnect();
    });
    it('queues releases, publishes complete generations, reuses vectors, degrades and isolates releases', async () => {
      await db.course.createMany({
        data: [
          { id: courseId, title: 'QA test' },
          { id: other, title: 'QA test other' },
        ],
      });
      const a = await add(courseId, 'one');
      expect(
        (
          await searchProfessorQa(
            db,
            embedding,
            courseId,
            a.id,
            'swing duration',
            allowed,
          )
        ).status,
      ).toBe('missing');
      embedding.embedTexts.mockRejectedValueOnce(new Error('fixture outage'));
      await worker.buildNext(a.id);
      expect(
        (
          await searchProfessorQa(
            db,
            embedding,
            courseId,
            a.id,
            'swing duration',
            allowed,
          )
        ).status,
      ).toBe('missing');
      await db.$executeRaw`UPDATE "ProfessorQaIndex" SET "nextAttempt"=now() WHERE "releaseId"=${a.id}`;
      await worker.buildNext(a.id);
      const b = await add(courseId, 'two');
      await worker.buildNext(b.id);
      expect(embedding.embedTexts.mock.lastCall?.[0]).toEqual([
        'pendulum period\nSmall oscillations are approximately isochronous. two',
      ]);
      const result = await searchProfessorQa(
        db,
        embedding,
        courseId,
        a.id,
        'swing duration',
        allowed,
      );
      expect(result.status).toBe('ready');
      expect(result.cardIds[0]).toBe('pendulum');
      expect(embedding.embedQuery).toHaveBeenCalledTimes(1);
      const mixed = await searchProfessorQa(
        db,
        embedding,
        courseId,
        a.id,
        '摆动一次需要多久？',
        allowed,
        ['period-definition'],
      );
      expect(mixed.teachingCardIds).toEqual(['period-definition']);
      expect(mixed.cardIds).not.toContain('period-definition');
      expect(embedding.embedQuery).toHaveBeenCalledTimes(2);
      embedding.embedQuery.mockRejectedValueOnce(new Error('offline'));
      expect(
        await searchProfessorQa(
          db,
          embedding,
          courseId,
          b.id,
          'isochronous',
          allowed,
        ),
      ).toMatchObject({ status: 'degraded', cardIds: ['pendulum'] });
      expect(
        (
          await searchProfessorQa(
            db,
            embedding,
            other,
            a.id,
            'pendulum',
            allowed,
          )
        ).cardIds,
      ).toEqual([]);
      expect(
        (
          await searchProfessorQa(db, embedding, courseId, a.id, 'pendulum', [
            'other',
          ])
        ).cardIds,
      ).toEqual(['other']);
    }, 30000);
  },
);
