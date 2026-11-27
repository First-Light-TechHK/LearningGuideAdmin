import type { PrismaService } from '../prisma/prisma.service';
import { wikiTeachingReferenceIds } from '../ks/contract/teaching-references';
import { TeachingCardsService } from './teaching-cards.service';

const reference = {
  id: 'vector',
  kind: 'latex',
  label: 'Vector',
  value: 'x^2',
  requires: [],
};
const projection = (ref: typeof reference) => ({
  conceptId: 'vector',
  bilingual: { conceptLabel: { en: 'Vector', zh: '向量' } },
  approvedPayload: { refObjects: [ref] },
});

function setup() {
  const prisma = {
    course: {
      findUnique: jest.fn().mockResolvedValue({ editingReleaseId: 'r1' }),
    },
    release: {
      findFirst: jest.fn().mockResolvedValue({
        snapshotData: {
          teachingPackageInput: {
            cards: [projection(reference)],
            glossary: [],
          },
        },
      }),
    },
    tutorTeachingCard: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return {
    prisma,
    service: new TeachingCardsService(prisma as unknown as PrismaService),
  };
}

describe('course references', () => {
  it('combines same-course legacy and approved objects without exposing drafts', async () => {
    const { prisma, service } = setup();
    const diagram = { ...reference, id: 'derivative', value: '2x' };
    prisma.tutorTeachingCard.findMany.mockResolvedValue([
      { id: 'draft', approved: null, reviewerId: null },
      { id: 'approved', approved: projection(diagram), reviewerId: 'teacher' },
    ]);

    await expect(service.listReferences('c1')).resolves.toEqual([
      reference,
      diagram,
    ]);
    expect(prisma.release.findFirst).toHaveBeenCalledWith({
      where: { id: 'r1', courseId: 'c1' },
      select: { snapshotData: true },
    });
    expect(prisma.tutorTeachingCard.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { courseId: 'c1' },
        select: { id: true, approved: true, reviewerId: true, deletedAt: true },
      }),
    );
  });

  it('reports conflicting reference IDs instead of picking an arbitrary object', async () => {
    const { prisma, service } = setup();
    prisma.tutorTeachingCard.findMany.mockResolvedValue([
      {
        id: 'approved',
        approved: projection({ ...reference, value: 'y^2' }),
        reviewerId: 'teacher',
      },
    ]);

    await expect(service.listReferences('c1')).rejects.toThrow(
      'LECTURE_REFERENCE_CATALOG_INVALID',
    );
  });

  it('collects authored references and skips reference examples inside code', () => {
    expect(
      wikiTeachingReferenceIds(
        [
          '[Vector](refobj:vector) [Same](refobj:vector)',
          '`[Example](refobj:inline)`',
          '```md',
          '[Example](refobj:fenced)',
          '```',
          '    [Example](refobj:indented)',
          '参见 Exhibit 1.1',
        ].join('\n'),
      ),
    ).toEqual(['vector']);
  });
});
