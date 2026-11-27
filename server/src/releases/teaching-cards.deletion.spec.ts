import type { PrismaService } from '../prisma/prisma.service';
import { TeachingCardsService } from './teaching-cards.service';
import { mergeApprovedCards } from './teaching-card-publication';

const item = (id: string) => ({ id, revision: 1 });
const question = {
  approvedPayload: { question: 'Question', answerMd: '[Diagram](refobj:b)' },
};
function setup() {
  const rows = [
    { ...item('a'), draft: { links: ['b'] }, approved: question },
    { ...item('b'), draft: { links: ['a'] }, approved: null },
  ];
  const tx = {
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
    course: {
      findUnique: jest.fn().mockResolvedValue({ editingReleaseId: 'r' }),
    },
    page: { findMany: jest.fn().mockResolvedValue([]) },
    release: { findFirst: jest.fn().mockResolvedValue(null) },
    tutorTeachingCard: {
      findMany: jest.fn().mockResolvedValue(rows),
      updateMany: jest.fn(),
    },
  };
  const prisma = {
    $transaction: (run: (client: typeof tx) => unknown) => run(tx),
  };
  return {
    tx,
    service: new TeachingCardsService(prisma as unknown as PrismaService),
  };
}

describe('teaching card deletion', () => {
  it('previews and commits only the full mutually linked selection', async () => {
    const { tx, service } = setup();
    expect(
      (await service.deleteSelection('course', [item('b')], false)).blockers,
    ).toEqual([
      { id: 'b', kind: 'draft', source: 'a' },
      { id: 'b', kind: 'approved', source: 'Question' },
    ]);
    const selection = [item('a'), item('b')];
    expect(
      (await service.deleteSelection('course', selection, true)).blockers,
    ).toEqual([]);
    expect(tx.tutorTeachingCard.updateMany).not.toHaveBeenCalled();
    await service.deleteSelection('course', selection, false);
    expect(tx.tutorTeachingCard.updateMany).toHaveBeenCalledWith({
      where: { courseId: 'course', deletedAt: null, id: { in: ['a', 'b'] } },
      data: { deletedAt: expect.any(Date) as Date, revision: { increment: 1 } },
    });
  });
  it('rechecks Wiki and baseline references after preview', async () => {
    const { tx, service } = setup();
    const selection = [item('a'), item('b')];
    await service.deleteSelection('course', selection, true);
    tx.page.findMany.mockResolvedValue([
      { title: 'Lesson', contentMd: '[B](refobj:b)' },
    ]);
    tx.release.findFirst.mockResolvedValue({
      snapshotData: {
        teachingPackageInput: {
          cards: [
            {
              cardId: 'legacy',
              approvedPayload: { refObjects: [{ id: 'a' }] },
            },
          ],
        },
      },
    });
    expect(
      (await service.deleteSelection('course', selection, false)).blockers,
    ).toEqual([
      { id: 'a', source: 'legacy', kind: 'base' },
      { id: 'b', source: 'Lesson', kind: 'wiki' },
    ]);
    expect(tx.tutorTeachingCard.updateMany).not.toHaveBeenCalled();
  });
  it('rejects stale, out-of-course and malformed selections without writing', async () => {
    const { tx, service } = setup();
    const result = await service.deleteSelection(
      'course',
      [{ id: 'a', revision: 9 }, item('b'), item('foreign')],
      false,
    );
    expect(result.blockers.map((b) => b.id)).toEqual(['a', 'foreign']);
    await expect(
      service.deleteSelection('course', [], false),
    ).rejects.toThrow();
    await expect(
      service.deleteSelection('course', [item('a'), item('a')], false),
    ).rejects.toThrow();
    expect(tx.tutorTeachingCard.updateMany).not.toHaveBeenCalled();
  });
  it('protects Wiki links to legacy inline references owned by a selected question', async () => {
    const { tx, service } = setup();
    tx.tutorTeachingCard.findMany.mockResolvedValue([
      {
        ...item('owner'),
        draft: {},
        approved: { approvedPayload: { refObjects: [{ id: 'inline' }] } },
      },
    ]);
    tx.page.findMany.mockResolvedValue([
      { title: 'Lesson', contentMd: '[old](refobj:inline)' },
    ]);
    expect(
      (await service.deleteSelection('course', [item('owner')], false))
        .blockers,
    ).toEqual([{ id: 'owner', source: 'Lesson', kind: 'wiki' }]);
    expect(tx.tutorTeachingCard.updateMany).not.toHaveBeenCalled();
  });

  it('suppresses deleted cards even when they exist in the historical package', () => {
    const base = { cards: [{ cardId: 'a' }], glossary: [] };
    expect(
      mergeApprovedCards(base, [
        {
          id: 'a',
          approved: question,
          deletedAt: new Date(),
          reviewerId: 'teacher',
        },
      ]),
    ).toBeUndefined();
    expect(base.cards).toEqual([{ cardId: 'a' }]);
  });
});
