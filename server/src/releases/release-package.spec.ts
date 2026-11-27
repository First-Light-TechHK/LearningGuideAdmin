import JSZip from 'jszip';
import { compileTeachingPublication } from '../ai/tutor/teaching-package-publication';
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
