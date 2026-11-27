import { buildAnchoredChunks } from './anchored-chunks';
import { prepareReviewedLecture } from './lecture-teaching';
import { snapshotHash } from './snapshot-hash';
import {
  validateReviewedTeachingPackage,
  type ReviewedTeachingCard,
} from './reviewed-package-validator';

const input = {
  courseId: 'course-1',
  releaseId: 'release-1',
  snapshot: {
    pages: [{ id: 'page-1', title: 'Page', contentMd: '# Topic\nEvidence' }],
  },
};

function makeCard(
  overrides: Partial<ReviewedTeachingCard> = {},
): ReviewedTeachingCard {
  const base = {
    cardId: 'card-1',
    conceptId: 'concept-1',
    type: 'concept',
    topic: 'topic-1',
    canonicalPoint: 'Evidence supports the concept.',
    approvedPayload: { explanation: 'Approved content.' },
    bilingual: {
      conceptLabel: { en: 'Concept', zh: '概念' },
      summary: { en: 'Summary', zh: '摘要' },
      triggers: { en: ['concept'], zh: ['概念'] },
    },
    useWhen: ['learner asks for the concept'],
    doNotUseWhen: ['question is outside the course'],
    sourceSupport: [buildAnchoredChunks(input)[0].anchor.id],
    links: [],
    priority: 1,
    reviewerId: 'reviewer-1',
    reviewStatus: 'approved' as const,
    cardHash: '',
    ...overrides,
  };
  const content: Record<string, unknown> = { ...base };
  delete content.cardHash;
  return { ...base, cardHash: snapshotHash(content) };
}

function makePackage() {
  return {
    manifest: {
      courseId: input.courseId,
      releaseId: input.releaseId,
      snapshotHash: snapshotHash(input.snapshot),
      packageRevision: 1,
      schemaVersion: 'tutor-package-v1',
      buildVersion: 'offline-builder-1',
    },
    sources: buildAnchoredChunks(input),
    cards: [makeCard()],
    glossary: [
      {
        conceptId: 'concept-1',
        label: { en: 'Concept', zh: '概念' },
        aliases: { en: ['idea'], zh: ['观念'] },
      },
    ],
  };
}

const validate = (candidate: unknown) =>
  validateReviewedTeachingPackage({ ...input, candidate });

describe('validateReviewedTeachingPackage', () => {
  it.each(['concept', 'misreading', 'professor_qa'])(
    'validates English-only published %s cards with matching glossary labels',
    (type) => {
      const candidate = makePackage();
      const label = { en: 'Concept', zh: '' };
      candidate.cards = [
        makeCard({
          type,
          bilingual: {
            conceptLabel: label,
            summary: { en: 'Summary', zh: '' },
            triggers: { en: ['concept'], zh: [] },
          },
        }),
      ];
      candidate.glossary[0].label = label;
      expect(validate(candidate).valid).toBe(true);
      candidate.glossary[0].label = { en: 'Concept', zh: '概念' };
      expect(validate(candidate).valid).toBe(true);
    },
  );
  it.each([
    {
      nameZh: '',
      summaryZh: '',
      summaryEn: 'Add components.',
      expected: 'Add components.',
    },
    {
      nameZh: '加法',
      summaryZh: '逐分量相加。',
      summaryEn: '',
      expected: '逐分量相加。',
    },
  ])(
    'displays new and historical numbered references in Chinese turns',
    ({ nameZh, summaryZh, summaryEn, expected }) => {
      const candidate = makePackage();
      const label = { en: 'Addition', zh: nameZh };
      const ref = {
        id: 'card-1',
        code: 'L1-F01',
        label: 'Addition',
        kind: 'latex',
        value: 'a+b',
        requires: [],
      };
      candidate.cards = [
        makeCard({
          type: 'ref_obj',
          topic: '*',
          bilingual: {
            conceptLabel: label,
            summary: { en: summaryEn, zh: summaryZh },
            triggers: { en: [], zh: [] },
          },
          approvedPayload: { code: ref.code, refObjects: [ref] },
          useWhen: ['*'],
        }),
      ];
      candidate.glossary[0].label = label;
      const turn = prepareReviewedLecture(
        {
          id: input.releaseId,
          courseId: input.courseId,
          versionTag: 'v1',
          pages: input.snapshot.pages,
          teachingPackage: candidate,
        },
        '请展示 L1-F01',
      );
      expect(turn).toMatchObject({
        kind: 'reference',
        directAnswer: expected + '\n\n[Addition](refobj:card-1)',
      });
    },
  );

  it('验证快照绑定、来源和卡片后返回可信重建内容及包哈希', () => {
    const candidate = makePackage();
    const result = validate(candidate);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.sources).toEqual(buildAnchoredChunks(input));
      expect(result.value.cards).toEqual(candidate.cards);
      expect(result.packageHash).toMatch(/^[a-f0-9]{64}$/);
      candidate.manifest.buildVersion = 'changed-after-validation';
      candidate.cards[0].approvedPayload = { explanation: 'Changed.' };
      expect(result.value.manifest.buildVersion).toBe('offline-builder-1');
      expect(result.value.cards[0].approvedPayload).toEqual({
        explanation: 'Approved content.',
      });
      expect(result.packageHash).toBe(snapshotHash(result.value));
    }
  });

  it('拒绝错误 Release、快照、schema 和修订号', () => {
    const candidate = makePackage();
    for (const manifest of [
      { ...candidate.manifest, releaseId: 'other' },
      { ...candidate.manifest, snapshotHash: '0'.repeat(64) },
      { ...candidate.manifest, schemaVersion: 'unknown' },
      { ...candidate.manifest, packageRevision: 0 },
    ])
      expect(validate({ ...candidate, manifest })).toEqual({
        valid: false,
        reason: 'MANIFEST_MISMATCH',
      });
  });

  it('拒绝未审核、未知卡类型、重复卡、无效来源和错误卡哈希', () => {
    const candidate = makePackage();
    const cases = [
      { ...makeCard({ reviewStatus: 'candidate' as never }) },
      { ...makeCard({ type: 'unknown' }) },
      { ...makeCard({ sourceSupport: ['missing-anchor'] }) },
    ];
    const tamperedHash = makeCard();
    tamperedHash.canonicalPoint = 'tampered';
    expect(validate({ ...candidate, cards: [cases[0]] })).toEqual({
      valid: false,
      reason: 'INVALID_CARD',
    });
    expect(validate({ ...candidate, cards: [cases[1]] })).toEqual({
      valid: false,
      reason: 'INVALID_CARD',
    });
    expect(validate({ ...candidate, cards: [cases[2]] })).toEqual({
      valid: false,
      reason: 'SOURCE_NOT_FOUND',
    });
    expect(validate({ ...candidate, cards: [tamperedHash] })).toEqual({
      valid: false,
      reason: 'CARD_HASH_MISMATCH',
    });
    expect(
      validate({
        ...candidate,
        cards: [candidate.cards[0], candidate.cards[0]],
      }),
    ).toEqual({ valid: false, reason: 'DUPLICATE_ID' });
    expect(
      validate({
        ...candidate,
        sources: [candidate.sources[0], candidate.sources[0]],
      }),
    ).toEqual({ valid: false, reason: 'DUPLICATE_ID' });
  });

  it('拒绝未闭合的卡片链接和未知字段', () => {
    const candidate = makePackage();
    const linked = makeCard({ links: ['missing-card'] });
    expect(validate({ ...candidate, cards: [linked] })).toEqual({
      valid: false,
      reason: 'LINK_NOT_FOUND',
    });
    expect(validate({ ...candidate, unexpected: true })).toEqual({
      valid: false,
      reason: 'INVALID_PACKAGE',
    });
  });

  it('要求 glossary 的概念身份与卡片一致且 ID 唯一', () => {
    const candidate = makePackage();
    expect(
      validate({
        ...candidate,
        glossary: [
          { ...candidate.glossary[0], label: { en: 'Other', zh: '概念' } },
        ],
      }),
    ).toEqual({ valid: false, reason: 'GLOSSARY_MISMATCH' });
    expect(
      validate({
        ...candidate,
        glossary: [candidate.glossary[0], candidate.glossary[0]],
      }),
    ).toEqual({ valid: false, reason: 'DUPLICATE_ID' });
  });

  it('安全拒绝 getter、循环和非 JSON 候选', () => {
    const candidate = makePackage();
    const getter = Object.defineProperty({ ...candidate }, 'sources', {
      get: () => {
        throw new Error('do not execute');
      },
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const malformed of [getter, cycle, null, new Proxy(candidate, {})])
      expect(validate(malformed)).toEqual({
        valid: false,
        reason: 'INVALID_PACKAGE',
      });
  });
});
