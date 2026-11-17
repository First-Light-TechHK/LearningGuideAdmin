import {
  computeCompleteness,
  type CompletenessInput,
  type CompletenessIssue,
  type ContentExhibit,
  type ContentLesson,
  type ContentLocalization,
  type ContentReading,
} from './completeness';

function courseInfo(language: string): ContentLocalization {
  return {
    language,
    title: `Course ${language}`,
    shortDescription: 'Short',
    overview: 'Overview',
    whatYouLearn: ['a', 'b', 'c', 'd'],
    provides: ['1', '2', '3', '4'],
  };
}

function lessonOne(): ContentLesson {
  return {
    id: 'lesson-1',
    code: 'L001',
    sortOrder: 1,
    localizations: [
      {
        language: 'en-GB',
        title: 'Lesson 1',
        description: 'Description',
        videoAssetId: 'video-1',
        videoDurationSeconds: 600,
        textHtml: '<h1 data-lp="T1">Heading</h1><p>Body</p>',
      },
      { language: 'zh-CN', title: '第一课', description: '说明' },
    ],
    learningPoints: [
      {
        language: 'en-GB',
        source: 'VIDEO',
        code: 'V1',
        title: 'Intro',
        timeSeconds: 30,
      },
      { language: 'en-GB', source: 'TEXT', code: 'T1', title: 'Heading' },
    ],
    triggers: [],
    exhibits: [],
    readings: [reading()],
    questions: [{ question: 'Q', referenceAnswer: 'A' }],
    applicationTest: { scenario: 'S', referenceAnswer: 'A', enabled: true },
  };
}

function reading(change: Partial<ContentReading> = {}): ContentReading {
  return {
    language: 'en-GB',
    type: 'BOOK',
    title: 'A book',
    author: 'An author',
    whyRecommended: 'Because',
    ...change,
  };
}

function exhibit(change: Partial<ContentExhibit> = {}): ContentExhibit {
  return {
    code: 'E001',
    type: 'IMAGE',
    mediaAssetId: 'media-1',
    thumbnailAssetId: 'thumb-1',
    localized: {
      'en-GB': { title: 'Map', description: 'A map' },
      'zh-CN': { title: '地图', description: '一张地图' },
    },
    ...change,
  };
}

function baseInput(
  overrides: Partial<CompletenessInput> = {},
): CompletenessInput {
  return {
    categoryId: 'cat-1',
    coverAssetId: 'cover-1',
    learningMode: 'VIDEO_AND_TEXT',
    learningLanguages: ['en-GB'],
    localizations: [courseInfo('en-GB'), courseInfo('zh-CN')],
    lessons: [lessonOne()],
    trialEnabled: true,
    trialRows: [
      {
        lessonId: 'lesson-1',
        status: 'READY',
        videoCutoffSeconds: 60,
        textCutoffLearningPointId: 'lp-1',
      },
    ],
    ...overrides,
  };
}

/** The first lesson of the base input with one localization or list changed. */
function withLesson(change: (lesson: ContentLesson) => void): ContentLesson[] {
  const lesson = lessonOne();
  change(lesson);
  return [lesson];
}

function find(
  issues: CompletenessIssue[],
  match: Partial<CompletenessIssue>,
): CompletenessIssue | undefined {
  return issues.find((issue) =>
    Object.entries(match).every(
      ([key, value]) => issue[key as keyof CompletenessIssue] === value,
    ),
  );
}

describe('computeCompleteness', () => {
  it('marks all 3 steps complete and reports no issue', () => {
    const result = computeCompleteness(baseInput());
    expect(result.steps.courseInformation.complete).toBe(true);
    expect(result.steps.content.complete).toBe(true);
    expect(result.steps.trial.complete).toBe(true);
    expect(result.completedSteps).toBe(3);
    expect(result.canPublish).toBe(true);
    expect(result.issues).toEqual([]);
  });

  describe('Course Information', () => {
    it('blocks publish when Course Information is incomplete', () => {
      const result = computeCompleteness(
        baseInput({
          localizations: [
            {
              language: 'en-GB',
              title: 'Course',
              shortDescription: '',
              overview: 'Overview',
              whatYouLearn: ['a'],
              provides: ['1'],
            },
            courseInfo('zh-CN'),
          ],
        }),
      );
      expect(result.steps.courseInformation.complete).toBe(false);
      expect(result.canPublish).toBe(false);
      expect(result.publishBlockers.join(' ')).toContain('Course Information');
    });

    it('is Incomplete when an English-only course has an empty zh-CN title', () => {
      const zh = { ...courseInfo('zh-CN'), title: '  ' };
      const result = computeCompleteness(
        baseInput({ localizations: [courseInfo('en-GB'), zh] }),
      );
      expect(result.steps.courseInformation.complete).toBe(false);
      expect(result.canPublish).toBe(false);
      expect(
        find(result.issues, {
          step: 'COURSE_INFORMATION',
          field: 'title',
          language: 'zh-CN',
          message: 'Required',
        }),
      ).toBeDefined();
      expect(
        find(result.issues, { field: 'title', language: 'en-GB' }),
      ).toBeUndefined();
    });

    it('flags every field of a language that has no Course Information row at all', () => {
      const result = computeCompleteness(
        baseInput({ localizations: [courseInfo('en-GB')] }),
      );
      const fields = result.issues
        .filter(
          (i) => i.step === 'COURSE_INFORMATION' && i.language === 'zh-CN',
        )
        .map((i) => i.field);
      expect(fields).toEqual(
        expect.arrayContaining(['title', 'shortDescription', 'overview']),
      );
    });

    it('is Incomplete without a cover', () => {
      const result = computeCompleteness(baseInput({ coverAssetId: null }));
      expect(result.steps.courseInformation.complete).toBe(false);
      expect(result.canPublish).toBe(false);
      expect(
        find(result.issues, {
          step: 'COURSE_INFORMATION',
          field: 'cover',
          message: 'Required',
        }),
      ).toBeDefined();
    });

    it('is Incomplete without a category', () => {
      const result = computeCompleteness(baseInput({ categoryId: null }));
      expect(find(result.issues, { field: 'category' })).toBeDefined();
    });

    it('flags learn[3] when English has 4 items and Chinese has 3', () => {
      const zh = { ...courseInfo('zh-CN'), whatYouLearn: ['一', '二', '三'] };
      const result = computeCompleteness(
        baseInput({ localizations: [courseInfo('en-GB'), zh] }),
      );
      expect(
        find(result.issues, {
          field: 'learn[3]',
          language: 'zh-CN',
          message: 'Required',
        }),
      ).toBeDefined();
      expect(
        find(result.issues, {
          field: 'learn',
          language: 'zh-CN',
          message: 'At least 4 items',
        }),
      ).toBeDefined();
      expect(find(result.issues, { language: 'en-GB' })).toBeUndefined();
    });

    it('flags a blank item inside a list of 4', () => {
      const en = { ...courseInfo('en-GB'), whatYouLearn: ['a', ' ', 'c', 'd'] };
      const result = computeCompleteness(
        baseInput({ localizations: [en, courseInfo('zh-CN')] }),
      );
      expect(
        find(result.issues, { field: 'learn[1]', language: 'en-GB' }),
      ).toBeDefined();
      expect(find(result.issues, { field: 'learn[0]' })).toBeUndefined();
    });

    it('counts a This course provides item by its title and flags fewer than 4 and more than 6', () => {
      const few = {
        ...courseInfo('en-GB'),
        provides: [{ title: 'x' }, { title: 'y' }, { title: 'z' }],
      };
      const result = computeCompleteness(
        baseInput({ localizations: [few, courseInfo('zh-CN')] }),
      );
      expect(
        find(result.issues, {
          field: 'provides',
          language: 'en-GB',
          message: 'At least 4 items',
        }),
      ).toBeDefined();

      const many = {
        ...courseInfo('en-GB'),
        provides: ['1', '2', '3', '4', '5', '6', '7'],
      };
      const tooMany = computeCompleteness(
        baseInput({ localizations: [many, courseInfo('zh-CN')] }),
      );
      expect(
        find(tooMany.issues, { field: 'provides', message: 'At most 6 items' }),
      ).toBeDefined();
    });

    it('derives the missing strings from the issues', () => {
      const result = computeCompleteness(baseInput({ coverAssetId: null }));
      expect(result.steps.courseInformation.missing).toHaveLength(
        result.issues.filter((i) => i.step === 'COURSE_INFORMATION').length,
      );
      expect(result.steps.courseInformation.missing.join(' ')).toContain(
        'cover',
      );
    });
  });

  describe('Lesson information', () => {
    it('is Incomplete when the Chinese lesson title is empty, even for an English-only course', () => {
      const result = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.localizations[1].title = '';
          }),
        }),
      );
      const issue = find(result.issues, {
        step: 'COURSE_CONTENT',
        part: 'LESSON_INFO',
        field: 'title',
        language: 'zh-CN',
      });
      expect(issue).toMatchObject({
        lessonId: 'lesson-1',
        lessonCode: 'L001',
        lessonPosition: 1,
        message: 'Required',
      });
      expect(result.steps.content.lessons[0].studyComplete).toBe(false);
      expect(result.canPublish).toBe(false);
    });

    it('is Incomplete when the lesson has no Chinese row at all', () => {
      const result = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.localizations = lesson.localizations.slice(0, 1);
          }),
        }),
      );
      const fields = result.issues
        .filter((i) => i.part === 'LESSON_INFO' && i.language === 'zh-CN')
        .map((i) => i.field);
      expect(fields.sort()).toEqual(['description', 'title']);
    });

    it('numbers lessons by their order among the lessons that are not removed', () => {
      const second = lessonOne();
      second.id = 'lesson-2';
      second.code = 'L002';
      second.sortOrder = 2;
      second.localizations[1].description = '';
      const removed = lessonOne();
      removed.id = 'lesson-0';
      removed.code = 'L000';
      removed.sortOrder = 0;
      removed.archivedAt = new Date();
      const result = computeCompleteness(
        baseInput({ lessons: [second, removed, lessonOne()] }),
      );
      expect(
        find(result.issues, { field: 'description', lessonCode: 'L002' }),
      ).toMatchObject({ lessonPosition: 2 });
      expect(find(result.issues, { lessonCode: 'L000' })).toBeUndefined();
    });
  });

  describe('Study, video', () => {
    it('flags a missing video and a video whose length cannot be read', () => {
      const noVideo = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.localizations[0].videoAssetId = null;
          }),
        }),
      );
      expect(
        find(noVideo.issues, {
          part: 'STUDY',
          field: 'video',
          language: 'en-GB',
          message: 'Video is required',
        }),
      ).toBeDefined();

      const unreadable = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.localizations[0].videoDurationSeconds = null;
          }),
        }),
      );
      expect(
        find(unreadable.issues, { code: 'DURATION_UNREADABLE' }),
      ).toMatchObject({ part: 'STUDY', field: 'video.duration' });
      // Without a length there is nothing to compare a time against.
      expect(
        find(unreadable.issues, { message: 'Beyond video length (00:00)' }),
      ).toBeUndefined();
    });

    it('wants at least 1 video learning point', () => {
      const result = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.learningPoints = lesson.learningPoints?.filter(
              (lp) => lp.source !== 'VIDEO',
            );
          }),
        }),
      );
      expect(
        find(result.issues, {
          field: 'videoLearningPoints',
          message: 'At least 1 learning point',
        }),
      ).toBeDefined();
    });

    it('flags a blank learning point title', () => {
      const result = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.learningPoints![0].title = '   ';
          }),
        }),
      );
      expect(
        find(result.issues, {
          part: 'STUDY',
          field: 'videoLearningPoints[V1].title',
          rowKey: 'V1',
          message: 'Required',
        }),
      ).toBeDefined();
    });

    it('flags a learning point with no time', () => {
      const result = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.learningPoints![0].timeSeconds = null;
          }),
        }),
      );
      expect(
        find(result.issues, {
          field: 'videoLearningPoints[V1].timeSeconds',
          message: 'Required',
        }),
      ).toBeDefined();
    });

    it('says Beyond video length (10:00) for a learning point at 700 s in a 600 s video', () => {
      const result = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.learningPoints![0].timeSeconds = 700;
          }),
        }),
      );
      expect(
        find(result.issues, {
          field: 'videoLearningPoints[V1].timeSeconds',
          message: 'Beyond video length (10:00)',
        }),
      ).toBeDefined();
      expect(result.steps.content.lessons[0].studyComplete).toBe(false);
    });

    it('accepts a learning point exactly at the end of the video', () => {
      const result = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.learningPoints![0].timeSeconds = 600;
          }),
        }),
      );
      expect(result.issues).toEqual([]);
    });

    it('flags a trigger with no exhibit, no time, or a time beyond the video', () => {
      const result = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.triggers = [
              { language: 'en-GB', exhibitCode: null, timeSeconds: 10 },
              { language: 'en-GB', exhibitCode: 'E001', timeSeconds: null },
              { language: 'en-GB', exhibitCode: 'E001', timeSeconds: 605 },
              { language: 'en-GB', exhibitCode: 'E002', timeSeconds: 20 },
            ];
          }),
        }),
      );
      expect(
        find(result.issues, {
          field: 'triggers[0].exhibitId',
          message: 'Choose an exhibit',
        }),
      ).toBeDefined();
      expect(
        find(result.issues, {
          field: 'triggers[1].timeSeconds',
          message: 'Required',
        }),
      ).toBeDefined();
      expect(
        find(result.issues, {
          field: 'triggers[2].timeSeconds',
          message: 'Beyond video length (10:00)',
        }),
      ).toBeDefined();
      expect(find(result.issues, { field: 'triggers[3].exhibitId' })).toBe(
        undefined,
      );
    });

    it('does not ask for video rules in a text-only course', () => {
      const result = computeCompleteness(
        baseInput({
          learningMode: 'TEXT_ONLY',
          lessons: withLesson((lesson) => {
            lesson.localizations[0].videoAssetId = null;
            lesson.localizations[0].videoDurationSeconds = null;
            lesson.learningPoints = lesson.learningPoints?.filter(
              (lp) => lp.source === 'TEXT',
            );
          }),
        }),
      );
      expect(result.issues).toEqual([]);
    });
  });

  describe('Study, text', () => {
    it('flags missing text', () => {
      const result = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.localizations[0].textHtml = '';
          }),
        }),
      );
      expect(
        find(result.issues, {
          part: 'STUDY',
          field: 'text',
          language: 'en-GB',
          message: 'Text is required',
        }),
      ).toBeDefined();
    });

    it('asks for Heading 1 when the text has none', () => {
      const result = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.localizations[0].textHtml = '<p>Only a paragraph</p>';
          }),
        }),
      );
      expect(
        find(result.issues, { field: 'textLearningPoints' }),
      ).toMatchObject({
        message:
          'No learning points found. Set each learning point title as Heading 1 (H1).',
      });
    });

    it('flags a heading with no body under it', () => {
      const result = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.localizations[0].textHtml =
              '<h1 data-lp="T1">One</h1><h1 data-lp="T2">Two</h1><p>Body</p>';
          }),
        }),
      );
      expect(
        find(result.issues, {
          field: 'textLearningPoints[T1].body',
          rowKey: 'T1',
          message: 'No text under this heading',
        }),
      ).toBeDefined();
      expect(find(result.issues, { rowKey: 'T2' })).toBeUndefined();
    });

    it('flags a heading with nothing but an exhibit card under it', () => {
      const result = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.localizations[0].textHtml =
              '<h1 data-lp="T1">One</h1><figure data-exhibit-code="E001"><strong>Map</strong> a description</figure>';
          }),
        }),
      );
      expect(
        find(result.issues, { field: 'textLearningPoints[T1].body' }),
      ).toBeDefined();
    });

    it("flags an empty heading as Title can't be empty", () => {
      const result = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.localizations[0].textHtml =
              '<h1 data-lp="T1">One</h1><p>a</p><h1> </h1><p>b</p>';
          }),
        }),
      );
      expect(
        find(result.issues, {
          field: 'textLearningPoints[#2].title',
          message: "Title can't be empty",
        }),
      ).toBeDefined();
      expect(result.steps.content.lessons[0].studyComplete).toBe(false);
    });
  });

  describe('Exhibits', () => {
    it('is happy with a complete exhibit', () => {
      const result = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.exhibits = [exhibit()];
          }),
        }),
      );
      expect(result.issues).toEqual([]);
    });

    it('makes Study Incomplete when an exhibit has no thumbnail', () => {
      const result = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.exhibits = [exhibit({ thumbnailAssetId: null })];
          }),
        }),
      );
      expect(
        find(result.issues, {
          part: 'STUDY',
          field: 'exhibits[E001].thumbnail',
          rowKey: 'E001',
          message: 'Required',
        }),
      ).toBeDefined();
      expect(result.steps.content.lessons[0].studyComplete).toBe(false);
    });

    it('flags a missing file and a missing type', () => {
      const result = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.exhibits = [exhibit({ mediaAssetId: null, type: '' })];
          }),
        }),
      );
      expect(
        find(result.issues, { field: 'exhibits[E001].media' }),
      ).toBeDefined();
      expect(
        find(result.issues, { field: 'exhibits[E001].type' }),
      ).toBeDefined();
    });

    it('asks for a title and a description only in the learning languages', () => {
      const bare = exhibit({
        localized: { 'en-GB': { title: ' ', description: '' } },
      });
      const english = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.exhibits = [bare];
          }),
        }),
      );
      expect(
        english.issues.map((i) => `${i.language}|${i.field}`).sort(),
      ).toEqual([
        'en-GB|exhibits[E001].description',
        'en-GB|exhibits[E001].title',
      ]);

      const both = computeCompleteness(
        baseInput({
          learningLanguages: ['en-GB', 'zh-CN'],
          lessons: withLesson((lesson) => {
            lesson.exhibits = [bare];
            for (const loc of lesson.localizations) {
              loc.videoAssetId = 'video-1';
              loc.videoDurationSeconds = 600;
              loc.textHtml = '<h1 data-lp="T1">H</h1><p>b</p>';
            }
            lesson.learningPoints = ['en-GB', 'zh-CN'].map((language) => ({
              language,
              source: 'VIDEO',
              code: `V-${language}`,
              title: 'x',
              timeSeconds: 1,
            }));
          }),
        }),
      );
      expect(
        both.issues
          .filter((i) => i.field === 'exhibits[E001].title')
          .map((i) => i.language)
          .sort(),
      ).toEqual(['en-GB', 'zh-CN']);
    });
  });

  describe('Recommended reading', () => {
    it('makes Study Incomplete when the list is empty', () => {
      const result = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.readings = [];
          }),
        }),
      );
      expect(
        find(result.issues, {
          part: 'STUDY',
          field: 'readings',
          message: 'Required',
        }),
      ).toBeDefined();
      expect(result.steps.content.lessons[0].studyComplete).toBe(false);
    });

    it('flags a reading without an author, and one without a reason', () => {
      const result = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.readings = [
              reading(),
              reading({ author: '  ' }),
              reading({ whyRecommended: null }),
              reading({ type: '', title: '' }),
            ];
          }),
        }),
      );
      expect(result.issues.map((i) => i.field).sort()).toEqual([
        'readings[1].author',
        'readings[2].whyRecommended',
        'readings[3].title',
        'readings[3].type',
      ]);
    });

    it('still counts readings that an older version stored under another language', () => {
      const result = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.readings = [reading({ language: 'zh-CN' })];
          }),
        }),
      );
      expect(result.issues).toEqual([]);
    });

    it('reads the English list when the lesson has English rows next to others', () => {
      const result = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.readings = [
              reading(),
              reading({ language: 'zh-CN', author: '' }),
            ];
          }),
        }),
      );
      expect(result.issues).toEqual([]);
    });
  });

  describe('Understanding', () => {
    it('is Incomplete when the knowledge test is enabled and has no question (MB12)', () => {
      const result = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.knowledgeEnabled = true;
            lesson.questions = [];
          }),
        }),
      );
      expect(
        find(result.issues, {
          part: 'UNDERSTANDING',
          field: 'knowledge',
          message: 'Required',
        }),
      ).toBeDefined();
      expect(result.steps.content.lessons[0].understandingComplete).toBe(false);
      // Study is unaffected, so the course can still be published.
      expect(result.steps.content.lessons[0].studyComplete).toBe(true);
      expect(result.canPublish).toBe(true);
    });

    it('adds nothing for a disabled knowledge test', () => {
      const result = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.knowledgeEnabled = false;
            lesson.questions = [];
          }),
        }),
      );
      expect(result.issues).toEqual([]);
    });

    it('is Incomplete when the application test is enabled and missing', () => {
      const result = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.applicationEnabled = true;
            lesson.applicationTest = null;
          }),
        }),
      );
      expect(
        find(result.issues, { part: 'UNDERSTANDING', field: 'application' }),
      ).toBeDefined();
    });

    it('adds nothing for a disabled application test with empty fields', () => {
      const result = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.applicationTest = {
              scenario: '',
              referenceAnswer: '',
              enabled: false,
            };
          }),
        }),
      );
      expect(result.issues).toEqual([]);
    });

    it('says Required for an empty question and Reference answer missing for an empty answer', () => {
      const result = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.questions = [
              { code: 'K-0101', question: '', referenceAnswer: 'A' },
              { code: 'K-0102', question: 'Q', referenceAnswer: ' ' },
            ];
          }),
        }),
      );
      expect(
        find(result.issues, {
          field: 'knowledge[K-0101].question',
          message: 'Required',
        }),
      ).toBeDefined();
      expect(
        find(result.issues, {
          field: 'knowledge[K-0102].referenceAnswer',
          message: 'Reference answer missing',
        }),
      ).toBeDefined();
    });
  });

  describe('Broken files', () => {
    const broken = 'This file is missing or damaged. Upload it again.';

    it('flags a broken cover, which blocks publishing', () => {
      const result = computeCompleteness(
        baseInput({ brokenAssetIds: new Set(['cover-1']) }),
      );
      expect(
        find(result.issues, {
          step: 'COURSE_INFORMATION',
          code: 'FILE_BROKEN',
          field: 'cover',
          message: broken,
        }),
      ).toBeDefined();
      expect(result.canPublish).toBe(false);
    });

    it('flags a broken lesson video for the language it belongs to', () => {
      const result = computeCompleteness(
        baseInput({ brokenAssetIds: new Set(['video-1']) }),
      );
      expect(
        find(result.issues, {
          part: 'STUDY',
          code: 'FILE_BROKEN',
          field: 'video',
          language: 'en-GB',
          message: broken,
        }),
      ).toBeDefined();
      expect(result.steps.content.lessons[0].studyComplete).toBe(false);
    });

    it('flags a broken exhibit file and thumbnail', () => {
      const result = computeCompleteness(
        baseInput({
          brokenAssetIds: new Set(['media-1', 'thumb-1']),
          lessons: withLesson((lesson) => {
            lesson.exhibits = [exhibit()];
          }),
        }),
      );
      expect(result.issues.map((i) => i.field).sort()).toEqual([
        'exhibits[E001].media',
        'exhibits[E001].thumbnail',
      ]);
      expect(result.issues.every((i) => i.code === 'FILE_BROKEN')).toBe(true);
    });
  });

  describe('What the Publish dialog shows', () => {
    it('lists each lesson with something missing by its code and position', () => {
      const second = lessonOne();
      second.id = 'lesson-2';
      second.code = 'L002';
      second.sortOrder = 2;
      second.localizations[1].title = '';
      second.readings = [];
      const result = computeCompleteness(
        baseInput({ lessons: [lessonOne(), second] }),
      );
      expect(result.incompleteLessons).toEqual([
        {
          lessonId: 'lesson-2',
          code: 'L002',
          position: 2,
          parts: ['LESSON_INFO', 'STUDY'],
        },
      ]);
    });

    it('names the part of a lesson that only lacks Understanding', () => {
      const result = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.knowledgeEnabled = true;
            lesson.questions = [];
          }),
        }),
      );
      expect(result.incompleteLessons.map((l) => l.parts)).toEqual([
        ['UNDERSTANDING'],
      ]);
    });

    it('gives each publish blocker a stable code next to its text', () => {
      const none = computeCompleteness(baseInput());
      expect(none.publishBlockerCodes).toEqual([]);

      const info = computeCompleteness(baseInput({ coverAssetId: null }));
      expect(info.publishBlockers).toEqual([
        'Complete Course Information first.',
      ]);
      expect(info.publishBlockerCodes).toEqual(['COURSE_INFORMATION']);

      const both = computeCompleteness(
        baseInput({ coverAssetId: null, lessons: [] }),
      );
      expect(both.publishBlockerCodes).toEqual([
        'COURSE_INFORMATION',
        'LESSON_STUDY',
      ]);
      expect(both.publishBlockers).toEqual([
        'Complete Course Information first.',
        'Complete at least 1 lesson first.',
      ]);
    });
  });

  describe('Publish and steps', () => {
    it('allows publish with only one completed lesson study', () => {
      const result = computeCompleteness(
        baseInput({
          lessons: [
            lessonOne(),
            {
              id: 'lesson-2',
              code: 'L002',
              sortOrder: 2,
              localizations: [],
            },
          ],
        }),
      );
      expect(result.canPublish).toBe(true);
      expect(result.steps.content.complete).toBe(false);
      expect(
        result.issues.filter((i) => i.lessonCode === 'L002').length,
      ).toBeGreaterThan(0);
      expect(result.steps.content.missing).toContain(
        'Lesson L002: Study & Exploration is incomplete.',
      );
    });

    it('refuses to publish when no lesson is complete and says it in the PRD words', () => {
      const result = computeCompleteness(
        baseInput({
          lessons: withLesson((lesson) => {
            lesson.localizations[0].textHtml = '';
          }),
        }),
      );
      expect(result.canPublish).toBe(false);
      expect(result.publishBlockers).toEqual([
        'Complete at least 1 lesson first.',
      ]);
    });

    it('asks for a lesson when there is none', () => {
      const result = computeCompleteness(baseInput({ lessons: [] }));
      expect(result.steps.content.complete).toBe(false);
      expect(result.steps.content.missing).toContain('Add at least 1 lesson.');
      expect(find(result.issues, { step: 'COURSE_CONTENT' })).toBeDefined();
    });

    it('requires trial lessons to be consecutive', () => {
      const second = lessonOne();
      second.id = 'lesson-2';
      second.code = 'L002';
      second.sortOrder = 2;
      const result = computeCompleteness(
        baseInput({
          lessons: [lessonOne(), second],
          trialRows: [
            { lessonId: 'lesson-2', status: 'READY', videoCutoffSeconds: 60 },
          ],
        }),
      );
      expect(result.steps.trial.complete).toBe(false);
      expect(find(result.issues, { step: 'TRIAL' })).toBeDefined();
    });
  });
});
