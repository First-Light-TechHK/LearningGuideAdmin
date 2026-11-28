import JSZip from 'jszip';
import {
  compileTeachingPackage,
  compileTeachingPublication,
} from '../ai/tutor/teaching-package-publication';
import { qaParts } from '../knowledge/professor-qa-parts';
import { KsInternalController } from '../ks/ks-internal.controller';
import type { PrismaKnowledgeClient } from '../ks/prisma-knowledge.client';
import {
  contentOf,
  makeMapping,
  pack,
  rebuild,
  translate,
  unpack,
  type Manifest,
} from './release-package';

const origin = {
  courseId: 'source',
  releaseId: 'r1',
  externalId: null,
  commerceCode: null,
};
function content(markdown: string) {
  return contentOf({
    editor: {
      version: 1,
      cards: [],
      pages: [
        {
          id: 'p1',
          title: 'Lesson',
          sortOrder: 1,
          syncState: 'SYNCED',
          contentMd: markdown,
        },
      ],
    },
  });
}

it('migrates a release with 2,000 entries and sends the entire QA and teaching candidate sets to retrieval', async () => {
  const label = { en: 'State', zh: '' };
  const cards = Array.from({ length: 2000 }, (_, i) => ({
    cardId: `card-${i}`,
    type: i < 500 ? 'concept' : 'professor_qa',
    conceptId: 'state',
    topic: '*',
    canonicalPoint: 'The condition of a system.',
    bilingual: {
      conceptLabel: label,
      summary: label,
      triggers: { en: [], zh: [] },
    },
    approvedPayload:
      i < 500
        ? {
            definitionName: `State ${i}`,
            answerMd: 'The condition of a system.',
          }
        : {
            question: `What is state ${i}?`,
            answerMd: 'The condition of a system.',
          },
    evidence: [],
    useWhen: ['*'],
    doNotUseWhen: [],
    links: [],
    priority: 10,
    reviewerId: 'editor',
  }));
  const authored = {
    cards,
    glossary: [{ conceptId: 'state', label, aliases: { en: [], zh: [] } }],
  };
  const version = {
    ...content('Course text.'),
    teachingPackageBase: authored,
    teachingPackageInput: authored,
  };
  const archive = await pack(
    {
      format: 'knowledge-release-v1',
      origin,
      versionTag: 'Large version',
      revisionNotes: '',
      content: version,
      images: {},
    },
    new Map(),
  );
  const { manifest } = await unpack(archive);
  const target = translate(
    manifest.content,
    origin.courseId,
    'target',
    makeMapping(manifest.content, origin, 'target'),
    new Set(),
  );
  const release = rebuild(
    target,
    'target',
    'restored',
    compileTeachingPublication,
  );
  const publication = compileTeachingPackage({
    courseId: 'target',
    releaseId: 'restored',
    snapshot: { pages: release.pages },
    authored: target.teachingPackageInput!,
  });
  const indexed = qaParts(publication.cards as Parameters<typeof qaParts>[0]);
  const allowed = publication.cards
    .filter((card) => card.type === 'professor_qa')
    .map((card) => card.cardId);
  const teaching = publication.cards
    .filter((card) => card.type === 'concept')
    .map((card) => card.cardId);
  expect(allowed).toHaveLength(1500);
  expect(teaching).toHaveLength(500);
  expect(indexed).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ cardId: allowed.at(-1), part: 0 }),
      expect.objectContaining({ cardId: teaching.at(-1), part: 1 }),
    ]),
  );
  const retrieveProfessorQa = jest
    .fn()
    .mockReturnValue({ status: 'ready', cardIds: [allowed.at(-1)] });
  const ks = new KsInternalController({
    retrieveProfessorQa,
  } as unknown as PrismaKnowledgeClient);
  expect(
    ks.retrieveProfessorQa('restored', {
      courseId: 'target',
      query: 'What is state 1999?',
      allowedIds: allowed,
      teachingIds: teaching,
    }),
  ).toEqual({ status: 'ready', cardIds: [allowed.at(-1)] });
  expect(retrieveProfessorQa).toHaveBeenCalledWith(
    'target',
    'restored',
    'What is state 1999?',
    allowed,
    teaching,
  );
});

it('distinguishes a genuinely empty version from missing editor history', () => {
  expect(() => contentOf({ pages: [] })).toThrow('编辑快照');
  expect(
    contentOf({ editor: { version: 1, cards: [], pages: [] } }).editor.cards,
  ).toEqual([]);
});

it('only rewrites course resources in Markdown prose, preserving code examples and external sources', () => {
  const asset = '11111111-1111-4111-8111-111111111111.png';
  const image = '![figure](/api/files/images/source/' + asset + ')';
  const lines = [
    image,
    '`' + image + '`',
    '    ' + image,
    '~~~~md',
    image,
    '~~~~',
    '[source](https://example.com/lesson)',
  ];
  const version = content(lines.join('\r\n'));
  const map = makeMapping(version, origin, 'target');
  const assets = new Set<string>();
  const result = translate(version, 'source', 'target', map, assets);
  expect(result.editor.pages[0].contentMd.split('\r\n')).toEqual([
    image.replace('/source/', '/target/'),
    ...lines.slice(1),
  ]);
  expect([...assets]).toEqual([asset]);
});

it('identifies the page and object for a broken Wiki reference', () => {
  expect(() =>
    rebuild(
      content('See [Figure](refobj:missing)'),
      'course',
      'r2',
      compileTeachingPublication,
    ),
  ).toThrow(/Lesson.*missing/);
});

it('rejects an altered manifest and a reading export before importing', async () => {
  const manifest: Manifest = {
    format: 'knowledge-release-v1',
    origin,
    versionTag: 'V1',
    revisionNotes: 'Notes',
    content: content('Text'),
    images: {},
  };
  const zip = await JSZip.loadAsync(await pack(manifest, new Map()));
  zip.file(
    'manifest.json',
    JSON.stringify({ ...manifest, versionTag: 'Changed' }),
  );
  await expect(
    unpack(await zip.generateAsync({ type: 'nodebuffer' })),
  ).rejects.toThrow('摘要');
  await expect(
    unpack(
      await new JSZip()
        .file('Lesson.md', 'Text')
        .generateAsync({ type: 'nodebuffer' }),
    ),
  ).rejects.toThrow('可迁移版本');
});
