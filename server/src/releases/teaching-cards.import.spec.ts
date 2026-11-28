import type { PrismaService } from '../prisma/prisma.service';
import { TeachingCardsService } from './teaching-cards.service';

const draft = {
  type: 'ref_obj',
  bilingual: {
    conceptLabel: { zh: '向量', en: 'Vector' },
    summary: { zh: '向量', en: 'Vector' },
  },
  approvedPayload: {
    code: 'L1-F01',
    refObjects: [{ kind: 'latex', value: 'x+y' }],
  },
};
function setup() {
  const tx = {
    $executeRaw: jest.fn(),
    course: { findUnique: jest.fn().mockResolvedValue({ id: 'c' }) },
    tutorTeachingCard: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    knowledgeImageAsset: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const service = new TeachingCardsService({
    $transaction: (fn: (client: typeof tx) => unknown) => fn(tx),
  } as unknown as PrismaService);
  return { service, tx };
}

describe('reference document import', () => {
  it('creates up to 500 formulas using one active-reference lookup and rejects oversized batches', async () => {
    const { service, tx } = setup();
    const items = Array.from({ length: 500 }, (_, i) => ({
      draft: {
        ...draft,
        approvedPayload: { ...draft.approvedPayload, code: `L1-F${i}` },
      },
    }));
    await expect(
      service.importReferences('c', items, false, 'editor'),
    ).resolves.toEqual({ saved: 500 });
    expect(tx.tutorTeachingCard.create).toHaveBeenCalledTimes(500);
    expect(tx.tutorTeachingCard.findMany).toHaveBeenCalledTimes(2);
    await expect(
      service.importReferences('c', [...items, items[0]], false, 'editor'),
    ).rejects.toMatchObject({ status: 413 });
    const images = items.slice(0, 301).map(({ draft }) => ({
      draft: {
        ...draft,
        approvedPayload: {
          ...draft.approvedPayload,
          refObjects: [{ kind: 'image', value: 'image.png' }],
        },
      },
    }));
    await expect(
      service.importReferences('c', images, false, 'editor'),
    ).rejects.toMatchObject({ status: 413 });
    expect(tx.knowledgeImageAsset.findFirst).not.toHaveBeenCalled();
  });

  it('checks the expected revision and makes imported updates available for release', async () => {
    const { service, tx } = setup();
    tx.tutorTeachingCard.findFirst.mockResolvedValue({
      id: 'existing',
      revision: 2,
      draft,
    });
    const item = { id: 'existing', revision: 1, draft };
    await expect(
      service.importReferences('c', [item], true, 'editor'),
    ).rejects.toThrow('TEACHING_CARD_REVISION_CHANGED');
    expect(tx.tutorTeachingCard.update).not.toHaveBeenCalled();
    await expect(
      service.importReferences('c', [{ ...item, revision: 2 }], true, 'editor'),
    ).resolves.toEqual({ saved: 1 });
    const [call] = tx.tutorTeachingCard.update.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(call.data).toEqual({
      draft: call.data.approved,
      approved: expect.objectContaining({ type: 'ref_obj' }) as unknown,
      approvedRevision: 3,
      reviewerId: 'editor',
      revision: { increment: 1 },
    });
  });
  it('preserves preview order for new references sharing a transaction timestamp', async () => {
    const { service, tx } = setup();
    const second = {
      ...draft,
      approvedPayload: { ...draft.approvedPayload, code: 'L1-F02' },
    };
    await service.importReferences(
      'c',
      [{ draft }, { draft: second }],
      false,
      'editor',
    );
    const calls = tx.tutorTeachingCard.create.mock.calls as [
      { data: { additionPosition: number; createdAt: Date } },
    ][];
    expect(calls.map(([call]) => call.data.additionPosition)).toEqual([0, 1]);
    expect(calls[0][0].data.createdAt).toBeInstanceOf(Date);
    expect(calls[1][0].data.createdAt).toEqual(calls[0][0].data.createdAt);
  });

  it('requires explicit selection to recreate and disallows creating with edit permission', async () => {
    const { service, tx } = setup();
    tx.tutorTeachingCard.findMany.mockResolvedValueOnce([
      { draft, approved: null },
    ]);
    await expect(
      service.importReferences('c', [{ draft }], false, 'editor'),
    ).rejects.toThrow('TEACHING_CARD_REVISION_CHANGED');
    await expect(
      service.importReferences('c', [{ draft }], true, 'editor'),
    ).rejects.toThrow('Forbidden');
    expect(tx.tutorTeachingCard.create).not.toHaveBeenCalled();
  });
  it('rejects unrelated card types and images outside the course', async () => {
    const { service, tx } = setup();
    await expect(
      service.importReferences(
        'c',
        [{ draft: { ...draft, type: 'concept' } }],
        false,
        'editor',
      ),
    ).rejects.toThrow('INVALID_TEACHING_CARD');
    const value = '00000000-0000-0000-0000-000000000001.png';
    await expect(
      service.importReferences(
        'c',
        [
          {
            draft: {
              ...draft,
              approvedPayload: {
                code: 'E1',
                refObjects: [{ kind: 'image', value }],
              },
            },
          },
        ],
        false,
        'editor',
      ),
    ).rejects.toThrow('INVALID_TEACHING_CARD');
    expect(tx.knowledgeImageAsset.findFirst).toHaveBeenCalledWith({
      where: { courseId: 'c', storageKey: 'knowledge-pages/c/' + value },
      select: { id: true },
    });
    expect(tx.tutorTeachingCard.create).not.toHaveBeenCalled();
  });

  it('saves a reference with just the English name and summary', async () => {
    const { service, tx } = setup();
    const englishOnly = {
      ...draft,
      bilingual: {
        conceptLabel: { en: 'Vector' },
        summary: { en: 'Add components.' },
      },
    };
    await service.importReferences(
      'c',
      [{ draft: englishOnly }],
      false,
      'editor',
    );
    const [call] = tx.tutorTeachingCard.create.mock.calls[0] as [
      { data: { approved: unknown } },
    ];
    expect(call.data.approved).toMatchObject({
      bilingual: {
        conceptLabel: { en: 'Vector', zh: '' },
        summary: { en: 'Add components.', zh: '' },
      },
      approvedPayload: { refObjects: [{ label: 'L1-F01 · Vector' }] },
    });
  });

  it.each([
    {
      conceptLabel: { zh: '向量', en: 'Vector' },
      summary: { zh: '逐分量相加。', en: 'Add components.' },
      label: 'Vector',
      point: 'Add components.',
    },
    {
      conceptLabel: { zh: '向量' },
      summary: { zh: '逐分量相加。' },
      label: '向量',
      point: '逐分量相加。',
    },
  ])(
    'uses $label as the default name when saving a reference',
    async ({ conceptLabel, summary, label, point }) => {
      const { service, tx } = setup();
      await service.save(
        'c',
        undefined,
        undefined,
        {
          ...draft,
          bilingual: { conceptLabel, summary },
          approvedPayload: { ...draft.approvedPayload, code: ' Ｌ1-F01 ' },
        },
        'editor',
      );
      const [call] = tx.tutorTeachingCard.create.mock.calls[0] as [
        { data: { id: string; approved: unknown } },
      ];
      expect(call.data.approved).toMatchObject({
        canonicalPoint: point,
        bilingual: {
          conceptLabel: { ...conceptLabel, en: label },
          summary: { ...summary, en: point },
        },
        approvedPayload: {
          refObjects: [{ id: call.data.id, label: 'L1-F01 · ' + label }],
        },
      });
    },
  );

  it('requires a reference summary for individual and imported saves', async () => {
    const { service, tx } = setup();
    const withoutSummary = {
      ...draft,
      bilingual: { ...draft.bilingual, summary: { zh: '', en: ' ' } },
    };
    await expect(
      service.save('c', undefined, undefined, withoutSummary, 'editor'),
    ).rejects.toThrow('REFERENCE_SUMMARY_REQUIRED');
    await expect(
      service.importReferences(
        'c',
        [{ draft: withoutSummary }],
        false,
        'editor',
      ),
    ).rejects.toThrow('REFERENCE_SUMMARY_REQUIRED');
    expect(tx.tutorTeachingCard.create).not.toHaveBeenCalled();
  });
});
