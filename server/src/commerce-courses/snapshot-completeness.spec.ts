import { computeCompleteness } from './completeness';
import {
  snapshotToCompletenessInput,
  type VersionSnapshot,
} from './version-snapshot';

function snapshot(
  change: (course: VersionSnapshot['course']) => void = () => undefined,
): VersionSnapshot {
  const info = (language: string) => ({
    language,
    title: `Course ${language}`,
    shortDescription: 'Short',
    overview: 'Overview',
    whatYouLearn: ['a', 'b', 'c', 'd'],
    provides: [{ title: '1' }, { title: '2' }, { title: '3' }, { title: '4' }],
  });
  const course: VersionSnapshot['course'] = {
    code: 'C001',
    slug: 'c001',
    categoryId: 'cat',
    coverAssetId: 'cover',
    learningMode: 'VIDEO_ONLY',
    defaultContentLanguage: 'en-GB',
    learningLanguages: ['en-GB'],
    localizations: [info('en-GB'), info('zh-CN')],
    lessons: [
      {
        id: 'l1',
        code: 'L001',
        sortOrder: 1,
        localizations: [
          {
            language: 'en-GB',
            title: 'One',
            description: 'First',
            videoAssetId: 'v1',
            videoDurationSeconds: 600,
            textHtml: null,
            textLearningPoints: null,
          },
          {
            language: 'zh-CN',
            title: '一',
            description: '第一',
            videoAssetId: null,
            videoDurationSeconds: null,
            textHtml: null,
            textLearningPoints: null,
          },
        ],
        exhibits: [],
        learningPoints: [
          {
            language: 'en-GB',
            code: 'V1',
            title: 'Start',
            source: 'VIDEO',
            timeSeconds: 10,
            anchorHeading: null,
            sortOrder: 0,
          },
        ],
        triggers: [],
        readings: [
          {
            language: 'en-GB',
            type: 'BOOK',
            title: 'A book',
            author: 'An author',
            whyRecommended: 'Because',
            sortOrder: 0,
          },
        ],
        questions: [],
        applicationTest: null,
      },
    ],
  };
  change(course);
  return { formatVersion: 2, capturedAt: '2026-11-17T00:00:00.000Z', course };
}

const noTrial = { trialEnabled: false, trialRows: [] };

describe('snapshotToCompletenessInput', () => {
  it('has no issue for a complete snapshot', () => {
    const result = computeCompleteness(
      snapshotToCompletenessInput(snapshot(), noTrial),
    );
    expect(result.issues).toEqual([]);
    expect(result.canPublish).toBe(true);
  });

  it('carries the cover', () => {
    const result = computeCompleteness(
      snapshotToCompletenessInput(
        snapshot((course) => {
          course.coverAssetId = null;
        }),
        noTrial,
      ),
    );
    expect(result.issues.map((i) => i.field)).toEqual(['cover']);
  });

  it('carries the Chinese Course Information of an English-only course', () => {
    const result = computeCompleteness(
      snapshotToCompletenessInput(
        snapshot((course) => {
          course.localizations = course.localizations.slice(0, 1);
        }),
        noTrial,
      ),
    );
    expect(
      result.issues.some((i) => i.language === 'zh-CN' && i.field === 'title'),
    ).toBe(true);
  });

  it('carries learning point titles, codes and times', () => {
    const result = computeCompleteness(
      snapshotToCompletenessInput(
        snapshot((course) => {
          course.lessons[0].learningPoints[0].title = '';
          course.lessons[0].learningPoints[0].timeSeconds = 900;
        }),
        noTrial,
      ),
    );
    expect(result.issues.map((i) => `${i.field}|${i.message}`).sort()).toEqual([
      'videoLearningPoints[V1].timeSeconds|Beyond video length (10:00)',
      'videoLearningPoints[V1].title|Required',
    ]);
  });

  it('carries triggers whose exhibit or time is not chosen yet', () => {
    const result = computeCompleteness(
      snapshotToCompletenessInput(
        snapshot((course) => {
          course.lessons[0].triggers = [
            { exhibitCode: null, language: 'en-GB', timeSeconds: null },
          ];
        }),
        noTrial,
      ),
    );
    expect(result.issues.map((i) => i.field).sort()).toEqual([
      'triggers[0].exhibitId',
      'triggers[0].timeSeconds',
    ]);
  });

  it('carries exhibits with their file ids and localized text', () => {
    const result = computeCompleteness(
      snapshotToCompletenessInput(
        snapshot((course) => {
          course.lessons[0].exhibits = [
            {
              code: 'E004',
              type: 'IMAGE',
              mediaAssetId: 'm1',
              thumbnailAssetId: null,
              sourceText: null,
              localized: { 'en-GB': { title: 'Map', description: '' } },
            },
          ];
        }),
        noTrial,
      ),
    );
    expect(result.issues.map((i) => i.field).sort()).toEqual([
      'exhibits[E004].description',
      'exhibits[E004].thumbnail',
    ]);
  });

  it('carries the readings', () => {
    const result = computeCompleteness(
      snapshotToCompletenessInput(
        snapshot((course) => {
          course.lessons[0].readings[0].author = null;
        }),
        noTrial,
      ),
    );
    expect(result.issues.map((i) => i.field)).toEqual(['readings[0].author']);
  });

  it('carries the files that are known to be broken', () => {
    const result = computeCompleteness(
      snapshotToCompletenessInput(snapshot(), noTrial, {
        brokenAssetIds: new Set(['cover', 'v1']),
      }),
    );
    expect(result.issues.map((i) => `${i.code}|${i.field}`).sort()).toEqual([
      'FILE_BROKEN|cover',
      'FILE_BROKEN|video',
    ]);
  });

  it('carries the questions with their codes', () => {
    const result = computeCompleteness(
      snapshotToCompletenessInput(
        snapshot((course) => {
          course.lessons[0].questions = [
            {
              code: 'K-0101',
              question: 'Why?',
              referenceAnswer: null,
              sortOrder: 0,
              enabled: true,
            },
          ];
        }),
        noTrial,
      ),
    );
    expect(result.issues).toEqual([
      expect.objectContaining({
        part: 'UNDERSTANDING',
        field: 'knowledge[K-0101].referenceAnswer',
        message: 'Reference answer missing',
      }),
    ]);
  });
});
