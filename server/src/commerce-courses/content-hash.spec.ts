import { canonicalJson, contentHash, snapshotAssetIds } from './content-hash';
import type { SnapshotLesson, VersionSnapshot } from './version-snapshot';

function lesson(overrides: Partial<SnapshotLesson> = {}): SnapshotLesson {
  return {
    id: 'lesson-row-1',
    code: 'L01',
    sortOrder: 1,
    localizations: [
      {
        language: 'en-GB',
        title: 'Why models',
        description: null,
        videoAssetId: 'video-a',
        videoDurationSeconds: 1469,
        textHtml: '<h1>1.1 Why models</h1><p>Text</p>',
        textLearningPoints: [{ code: '1.1', title: 'Why models' }],
      },
      {
        language: 'zh-CN',
        title: '为什么要建模',
        description: null,
        videoAssetId: null,
        videoDurationSeconds: null,
        textHtml: null,
        textLearningPoints: null,
      },
    ],
    exhibits: [
      {
        code: 'E01',
        type: 'IMAGE',
        mediaAssetId: 'image-a',
        thumbnailAssetId: null,
        sourceText: null,
        localized: { 'en-GB': { title: 'Exhibit 1' } },
      },
      {
        code: 'E02',
        type: 'IMAGE',
        mediaAssetId: 'image-b',
        thumbnailAssetId: null,
        sourceText: null,
        localized: null,
      },
    ],
    learningPoints: [
      {
        language: 'en-GB',
        code: '1.1',
        title: 'Why models',
        source: 'VIDEO',
        timeSeconds: 10,
        anchorHeading: null,
        sortOrder: 1,
      },
      {
        language: 'en-GB',
        code: '1.2',
        title: 'Simple rules',
        source: 'VIDEO',
        timeSeconds: 412,
        anchorHeading: null,
        sortOrder: 2,
      },
    ],
    triggers: [
      { exhibitCode: 'E01', language: 'en-GB', timeSeconds: 37 },
      { exhibitCode: 'E02', language: 'en-GB', timeSeconds: 160 },
    ],
    readings: [],
    questions: [],
    applicationTest: null,
    ...overrides,
  };
}

function snapshot(lessons: SnapshotLesson[] = [lesson()]): VersionSnapshot {
  return {
    formatVersion: 2,
    capturedAt: '2026-11-12T00:00:00.000Z',
    course: {
      code: 'C001',
      slug: 'modeling-life',
      categoryId: null,
      coverAssetId: 'cover-a',
      learningMode: 'SELF_PACED',
      defaultContentLanguage: 'en-GB',
      learningLanguages: ['en-GB'],
      localizations: [
        {
          language: 'en-GB',
          title: 'Modeling life',
          shortDescription: null,
          overview: null,
          whatYouLearn: ['Models'],
          provides: null,
        },
      ],
      lessons,
    },
  };
}

const byId = (id: string | null) => (id ? `asset:${id}` : null);

describe('canonicalJson (RFC 8785)', () => {
  it('sorts object keys and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: [true, null], c: undefined })).toBe(
      '{"a":[true,null],"b":1}',
    );
  });

  it('serialises numbers the ECMAScript way', () => {
    expect(canonicalJson([1.0, 0.1, 1e21, -0])).toBe('[1,0.1,1e+21,0]');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
  });
});

describe('contentHash', () => {
  it('is a 64-character sha256 hex digest', () => {
    expect(contentHash(snapshot(), byId)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores capture time and lesson row ids', () => {
    const a = snapshot();
    const b = snapshot([lesson({ id: 'another-row-id' })]);
    b.capturedAt = '2027-01-01T00:00:00.000Z';
    expect(contentHash(b, byId)).toBe(contentHash(a, byId));
  });

  it('ignores the learning point stamps the server writes on text headings', () => {
    const plain = lesson();
    plain.localizations[0].textHtml = '<h1>1.1 Why models</h1><p>Text</p>';
    const stamped = lesson();
    stamped.localizations[0].textHtml =
      '<h1 data-lp="T1">1.1 Why models</h1><p>Text</p>';
    const restamped = lesson();
    restamped.localizations[0].textHtml =
      "<h1 class='k' data-lp='T7'>1.1 Why models</h1><p>Text</p>";
    expect(contentHash(snapshot([stamped]), byId)).toBe(
      contentHash(snapshot([plain]), byId),
    );
    expect(contentHash(snapshot([restamped]), byId)).not.toBe(
      contentHash(snapshot([plain]), byId),
    );
    const sameWithClass = lesson();
    sameWithClass.localizations[0].textHtml =
      "<h1 class='k'>1.1 Why models</h1><p>Text</p>";
    expect(contentHash(snapshot([restamped]), byId)).toBe(
      contentHash(snapshot([sameWithClass]), byId),
    );
  });

  it('still sees a change in the heading text itself', () => {
    const a = lesson();
    a.localizations[0].textHtml = '<h1 data-lp="T1">One</h1><p>Text</p>';
    const b = lesson();
    b.localizations[0].textHtml = '<h1 data-lp="T1">Two</h1><p>Text</p>';
    expect(contentHash(snapshot([a]), byId)).not.toBe(
      contentHash(snapshot([b]), byId),
    );
  });

  it('ignores the order rows come back from the database', () => {
    const base = lesson();
    const shuffled = lesson({
      localizations: [...base.localizations].reverse(),
      exhibits: [...base.exhibits].reverse(),
      learningPoints: [...base.learningPoints].reverse(),
      triggers: [...base.triggers].reverse(),
    });
    expect(contentHash(snapshot([shuffled]), byId)).toBe(
      contentHash(snapshot([base]), byId),
    );
  });

  it('sees a change in the order of the exhibits of a lesson', () => {
    const ordered = (first: string, second: string) => {
      const base = lesson();
      return lesson({
        exhibits: [
          { ...base.exhibits[0], sortOrder: first === 'E01' ? 1 : 2 },
          { ...base.exhibits[1], sortOrder: second === 'E02' ? 2 : 1 },
        ],
      });
    };
    const inCodeOrder = contentHash(snapshot([ordered('E01', 'E02')]), byId);
    const reordered = contentHash(snapshot([ordered('E02', 'E01')]), byId);
    expect(reordered).not.toBe(inCodeOrder);
  });

  it('gives an exhibit list in code order the same fingerprint as before it had an order', () => {
    // A version published before exhibits had an order has no sortOrder in its snapshot;
    // the same content, now carrying the order the migration gave it, must not look like a draft.
    const legacy = lesson();
    const withOrder = lesson({
      exhibits: legacy.exhibits.map((exhibit, index) => ({
        ...exhibit,
        sortOrder: index + 1,
      })),
    });
    expect(contentHash(snapshot([withOrder]), byId)).toBe(
      contentHash(snapshot([legacy]), byId),
    );
  });

  it('changes when any content changes', () => {
    const base = contentHash(snapshot(), byId);
    const moved = lesson();
    moved.learningPoints[1] = { ...moved.learningPoints[1], timeSeconds: 413 };
    expect(contentHash(snapshot([moved]), byId)).not.toBe(base);

    const renamed = snapshot();
    renamed.course.localizations[0].title = 'Modelling life';
    expect(contentHash(renamed, byId)).not.toBe(base);
  });

  it('matches across environments when the files are the same', () => {
    // Sandbox 和 Production 的资产行 ID 不同，但文件 sha256 相同。
    const sandbox = snapshot();
    const production = snapshot([
      lesson({
        localizations: lesson().localizations.map((loc) => ({
          ...loc,
          videoAssetId: loc.videoAssetId ? 'prod-video' : null,
        })),
      }),
    ]);
    production.course.coverAssetId = 'prod-cover';
    const checksums: Record<string, string> = {
      'video-a': 'f00d',
      'prod-video': 'f00d',
      'cover-a': 'c0ve',
      'prod-cover': 'c0ve',
    };
    const byChecksum = (id: string | null) =>
      id ? (checksums[id] ? `sha256:${checksums[id]}` : `asset:${id}`) : null;
    expect(contentHash(production, byChecksum)).toBe(
      contentHash(sandbox, byChecksum),
    );
    expect(contentHash(production, byId)).not.toBe(contentHash(sandbox, byId));
  });
});

describe('snapshotAssetIds', () => {
  it('lists every referenced asset once', () => {
    expect(snapshotAssetIds(snapshot()).sort()).toEqual([
      'cover-a',
      'image-a',
      'image-b',
      'video-a',
    ]);
  });
});
