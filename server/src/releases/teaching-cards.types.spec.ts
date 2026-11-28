import { compileTeachingPackage } from '../ai/tutor/teaching-package-publication';
import { lectureReferenceMarkdown } from '../ai/tutor/lecture-references';
import { prepareReviewedLecture } from '../ai/tutor/lecture-teaching';
import { mergeApprovedCards } from './teaching-card-publication';
import type { PrismaService } from '../prisma/prisma.service';
import { TeachingCardsService } from './teaching-cards.service';

const draft = {
  type: 'concept',
  topic: '*',
  conceptId: 'vector',
  canonicalPoint: 'A vector is an element of a vector space.',
  bilingual: {
    conceptLabel: { en: 'Vector', zh: '向量' },
    summary: { en: 'Element of a vector space', zh: '向量空间的元素' },
    triggers: { en: ['vector'], zh: ['向量'] },
  },
  approvedPayload: {},
  useWhen: ['*'],
  doNotUseWhen: [],
  links: [],
  evidence: ['A vector is an element of a vector space.'],
  priority: 10,
};

// Modeling Life, Lesson 1, student dialogue about the cup of coffee.
const line = '所以在我们这个例子里，我们唯一关注的变量就是温度，其他都不考虑？';
const page = {
  id: 'lesson-1',
  title: '状态空间与向量',
  contentMd: 'S（中文）：' + line,
};
const definition = {
  type: 'concept',
  evidence: [line],
  approvedPayload: {
    definitionName: '状态变量',
    answerMd: '状态变量是描述系统在某一时刻状态的量。',
    sourcePageId: page.id,
  },
};

function setup() {
  const cards = {
    create: jest.fn<
      void,
      [{ data: Parameters<typeof mergeApprovedCards>[1][number] }]
    >(),
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn(),
    update: jest.fn<
      void,
      [
        {
          data: {
            draft: Record<string, unknown>;
            approved: Record<string, unknown>;
          };
        },
      ]
    >(),
  };
  const tx = {
    $executeRaw: jest.fn(),
    page: { findMany: jest.fn().mockResolvedValue([page]) },
    course: { findUnique: jest.fn().mockResolvedValue({ id: 'c' }) },
    tutorTeachingCard: cards,
  };
  const service = new TeachingCardsService({
    $transaction: (fn: (client: typeof tx) => unknown) => fn(tx),
  } as unknown as PrismaService);
  return { service, cards };
}

describe('teaching entry types', () => {
  it('saves the main question, professor answer and references from a legacy payload', async () => {
    const { service, cards } = setup();
    const ref = {
      id: 'fig',
      label: '图',
      kind: 'latex',
      value: 'x',
      requires: [],
    };
    const answerMd = '教授的回答 [图](refobj:fig)';
    await service.save(
      'c',
      undefined,
      undefined,
      {
        type: 'professor_qa',
        approvedPayload: {
          question: '主问题？',
          answerMd,
          refObjects: [ref],
          variants: ['旧问法'],
          keywords: ['词'],
        },
      },
      'editor',
    );
    const saved = cards.create.mock.calls[0][0].data.approved;
    expect(saved).toMatchObject({
      bilingual: { triggers: { en: [], zh: ['主问题？'] } },
    });
    expect(saved).toHaveProperty('approvedPayload', {
      question: '主问题？',
      answerMd,
      refObjects: [ref],
    });
  });

  it.each(['State variable', '状态变量', '状态 variable'])(
    'saves a language-neutral definition and publishes its bound passage: %s',
    async (name) => {
      const { service, cards } = setup();
      await service.save(
        'c',
        undefined,
        undefined,
        {
          ...definition,
          approvedPayload: {
            ...definition.approvedPayload,
            definitionName: name,
          },
        },
        'editor',
      );
      const data = cards.create.mock.calls[0][0].data;
      const authored = mergeApprovedCards(undefined, [data])!;
      const pkg = compileTeachingPackage({
        courseId: 'c',
        releaseId: 'r',
        snapshot: { pages: [page] },
        authored,
      });
      expect(pkg.sources[0].anchor.pageId).toBe(page.id);
      expect(pkg.cards[0].approvedPayload).toMatchObject({
        definitionName: name,
      });
    },
  );

  it('publishes a definition without a source and drops a stale page id', async () => {
    const { service, cards } = setup();
    await service.save(
      'c',
      undefined,
      undefined,
      { ...definition, evidence: [] },
      'editor',
    );
    const authored = mergeApprovedCards(undefined, [
      cards.create.mock.calls[0][0].data,
    ])!;
    const pkg = compileTeachingPackage({
      courseId: 'c',
      releaseId: 'r',
      snapshot: { pages: [page] },
      authored,
    });
    expect(pkg.sources).toEqual([]);
    expect(pkg.cards[0].sourceSupport).toEqual([]);
    expect(pkg.cards[0].approvedPayload).not.toHaveProperty('sourcePageId');
    const lecture = prepareReviewedLecture(
      {
        id: 'r',
        courseId: 'c',
        versionTag: 'test',
        pages: [page],
        teachingPackage: pkg,
      },
      '状态变量是什么？',
    );
    expect(lecture.kind).toBe('reviewed');
    expect(lecture.trace.selectedCardIds).toEqual([pkg.cards[0].cardId]);
    expect(lecture.trace.sourceIds).toEqual([]);
  });

  it.each([
    { ...definition, evidence: ['missing passage'] },
    {
      ...definition,
      approvedPayload: { ...definition.approvedPayload, definitionName: '  ' },
    },
    {
      ...definition,
      approvedPayload: {
        ...definition.approvedPayload,
        answerMd: '[Figure](refobj:figure)',
      },
    },
    {
      ...definition,
      approvedPayload: { ...definition.approvedPayload, answerMd: '$$x=1$$' },
    },
  ])('rejects incomplete or unbound definitions', async (invalid) => {
    const { service, cards } = setup();
    await expect(
      service.save('c', undefined, undefined, invalid, 'editor'),
    ).rejects.toThrow();
    expect(cards.create).not.toHaveBeenCalled();
  });

  it('retains the original bilingual content across edits without publishing the archive', async () => {
    const { service, cards } = setup();
    cards.findFirst.mockResolvedValue({ draft, revision: 1 });
    await service.save('c', 'old', 1, definition, 'editor');
    expect(cards.update.mock.calls[0][0].data.draft.legacyDefinition).toEqual(
      draft,
    );
    expect(cards.update.mock.calls[0][0].data.approved).not.toHaveProperty(
      'legacyDefinition',
    );
    cards.findFirst.mockResolvedValue({
      draft: { ...definition, legacyDefinition: draft },
      revision: 2,
    });
    await service.save('c', 'old', 2, definition, 'editor');
    expect(cards.update.mock.calls[1][0].data.draft.legacyDefinition).toEqual(
      draft,
    );
  });

  it.each([
    ['latex', 'T(t)', '用公式解释状态变量'],
    [
      'image',
      '12345678-1234-1234-1234-123456789012.png',
      '结合图片解释状态变量',
    ],
  ])(
    'replays a published definition by name or dialogue with its %s exhibit',
    async (kind, value, questionWithExhibit) => {
      const { service, cards } = setup();
      await service.save(
        'c',
        undefined,
        undefined,
        {
          type: 'ref_obj',
          bilingual: {
            conceptLabel: { en: 'Temperature' },
            summary: { en: 'Temperature over time' },
          },
          approvedPayload: {
            code: 'F-1',
            refObjects: [{ kind, value }],
          },
        },
        'editor',
      );
      const exhibit = cards.create.mock.calls[0][0].data;
      const answerMd =
        definition.approvedPayload.answerMd +
        ' [温度](refobj:' +
        exhibit.id +
        ')';
      await service.save(
        'c',
        undefined,
        undefined,
        {
          ...definition,
          approvedPayload: { ...definition.approvedPayload, answerMd },
        },
        'editor',
      );
      const saved = cards.create.mock.calls[1][0].data;
      const release = {
        id: 'r',
        versionTag: 'test',
        courseId: 'c',
        pages: [page],
        teachingPackage: compileTeachingPackage({
          courseId: 'c',
          releaseId: 'r',
          snapshot: { pages: [page] },
          authored: mergeApprovedCards(undefined, [exhibit, saved])!,
        }),
      };
      for (const question of [
        '什么是状态变量？',
        line + '这句话指什么？',
        questionWithExhibit,
      ]) {
        const result = prepareReviewedLecture(release, question);
        expect(result.kind).toBe('reviewed');
        expect(result.trace.selectedCardIds).toContain(saved.id);
        if (result.kind === 'reviewed') {
          expect(result.outputContract).toContain('supplementary definition');
          expect(result.knowledge).toContain(answerMd);
          expect(result.knowledge).toContain(line);
          const ref = result.references.find((item) => item.id === exhibit.id);
          expect(ref).toBeDefined();
          expect(
            lectureReferenceMarkdown(ref!, 'c', 'learner-course', release.id),
          ).toContain(
            kind === 'image'
              ? '/api/user/courses/learner-course/images/' + value
              : '$$' + value + '$$',
          );
        }
      }
    },
  );

  it.each(['concept', 'misreading'])(
    'publishes an English-only %s without fabricated translations',
    async (type) => {
      const { service, cards } = setup();
      const bilingual = {
        conceptLabel: { en: 'Vector', zh: '' },
        summary: { en: 'An element of a vector space.', zh: '' },
        triggers: { en: ['vector'], zh: [] },
      };
      await service.save(
        'c',
        undefined,
        undefined,
        { ...draft, type, bilingual },
        'editor',
      );
      expect(cards.create.mock.calls[0]).toMatchObject([
        { data: { approved: { type, bilingual } } },
      ]);
    },
  );
  it('writes the first revision and makes it available for release on create', async () => {
    const { service, cards } = setup();
    await service.save(
      'c',
      undefined,
      undefined,
      { ...draft, reviewerId: 'from-body' },
      'editor',
    );
    expect(cards.create).toHaveBeenCalledWith({
      data: {
        id: expect.any(String) as string,
        courseId: 'c',
        additionPosition: 0,
        draft,
        approved: draft,
        approvedRevision: 1,
        reviewerId: 'editor',
      },
    });
  });

  it.each(['frame', 'lens', 'source', 'boundary', 'teaching_move'])(
    'rejects creating or switching to the legacy type %s',
    async (type) => {
      const { service, cards } = setup();
      cards.findFirst.mockResolvedValue({ draft, revision: 1 });
      await expect(
        service.save('c', undefined, undefined, { ...draft, type }, 'editor'),
      ).rejects.toThrow('INVALID_TEACHING_CARD');
      await expect(
        service.save('c', 'card', 1, { ...draft, type }, 'editor'),
      ).rejects.toThrow('INVALID_TEACHING_CARD');
      expect(cards.create).not.toHaveBeenCalled();
      expect(cards.update).not.toHaveBeenCalled();
    },
  );

  it('allows an existing legacy draft to keep its type or switch to a current type', async () => {
    const { service, cards } = setup();
    const legacyDraft = { ...draft, type: 'frame' };
    cards.findFirst.mockResolvedValue({ draft: legacyDraft, revision: 1 });
    await service.save('c', 'card', 1, legacyDraft, 'editor');
    const updated = { ...draft, type: 'misreading' };
    await service.save('c', 'card', 1, updated, 'editor');
    expect(cards.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'card' },
      data: {
        draft: legacyDraft,
        approved: legacyDraft,
        approvedRevision: 2,
        reviewerId: 'editor',
        revision: { increment: 1 },
      },
    });
    expect(cards.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'card' },
      data: {
        draft: updated,
        approved: updated,
        approvedRevision: 2,
        reviewerId: 'editor',
        revision: { increment: 1 },
      },
    });
  });
});
