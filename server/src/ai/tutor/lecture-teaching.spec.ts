import { prepareReviewedLecture } from './lecture-teaching';
import { classifyLectureTopic } from './lecture-topic-classifier';
import {
  exhibitsForAnswer,
  exhibitDisplay,
  matchExhibits,
  linkedExhibitPassage,
  type LectureExhibit,
} from './lecture-exhibits';
import { compileTeachingPackage } from './teaching-package-publication';
import type { KnowledgeRelease } from '../../ks/contract/knowledge-client';

const excerpt =
  'Epicurus distinguishes freedom from bodily pain and mental disturbance from excessive indulgence.';
const conceptLabel = { en: 'Epicurean pleasure', zh: '伊壁鸠鲁的快乐观' };
const summary = {
  en: 'Read pleasure in its historical context.',
  zh: '在历史语境中理解快乐。',
};

function epicurusRelease(): KnowledgeRelease {
  const pages = [{ id: 'page', title: 'Epicurus', contentMd: excerpt }];
  const card = (
    cardId: string,
    type: string,
    triggers: string[],
    approvedPayload = {},
  ) => ({
    cardId,
    type,
    conceptId: 'pleasure',
    topic: 'epicurus',
    canonicalPoint: summary.en,
    approvedPayload,
    bilingual: { conceptLabel, summary, triggers: { en: triggers, zh: [] } },
    evidence: [excerpt],
    useWhen: ['*'],
    doNotUseWhen: [],
    links: [],
    priority: 10,
    reviewerId: 'fixture-review',
  });
  const version = {
    id: 'epicurus-release',
    courseId: 'epicurus-course',
    versionTag: 'preflight',
    pages,
  };
  return {
    ...version,
    teachingPackage: compileTeachingPackage({
      courseId: version.courseId,
      releaseId: version.id,
      snapshot: { pages },
      authored: {
        glossary: [
          {
            conceptId: 'pleasure',
            label: conceptLabel,
            aliases: { en: ['Epicurus', 'pleasure'], zh: [] },
          },
        ],
        cards: [
          card('historical-lens', 'lens', [], {
            defaultForTopic: true,
            interpretation: 'Historical context',
          }),
          card('modern-reading', 'frame', ['enjoy life'], {
            explanation: 'A possible modern reading.',
          }),
          card('indulgence', 'misreading', ['enjoy life'], {
            correction: 'Avoid confusing pleasure with excessive indulgence.',
          }),
          card('course-concept', 'concept', ['Epicurus'], {
            explanation: excerpt,
          }),
        ],
      },
    }),
  };
}

describe('reviewed Lecture selection', () => {
  it('prioritizes the full definition name while keeping independently mentioned concepts', () => {
    const version = {
      id: 'r',
      courseId: 'c',
      versionTag: 'test',
      pages: [{ id: 'p', title: 'Lesson', contentMd: 'Script.' }],
    };
    const cards = [
      ['a', '状态'],
      ['z', '状态变量'],
    ].map(([cardId, name]) => ({
      cardId,
      conceptId: cardId,
      topic: '*',
      type: 'concept',
      canonicalPoint: name + '的教学解释。',
      evidence: [],
      useWhen: ['*'],
      doNotUseWhen: [],
      priority: 10,
      links: [],
      reviewerId: 'fixture',
      bilingual: {
        conceptLabel: { en: name, zh: '' },
        summary: { en: name, zh: '' },
        triggers: { en: [], zh: [] },
      },
      approvedPayload: {
        definitionName: name,
        answerMd:
          name +
          '的教学解释。' +
          (cardId === 'z' ? '进一步阐述。'.repeat(440) + '尾段证据。' : ''),
      },
    }));
    const release = {
      ...version,
      teachingPackage: compileTeachingPackage({
        courseId: version.courseId,
        releaseId: version.id,
        snapshot: { pages: version.pages },
        authored: {
          cards,
          glossary: cards.map((card) => ({
            conceptId: card.conceptId,
            label: card.bilingual.conceptLabel,
            aliases: { en: [], zh: [] },
          })),
        },
      }),
    };
    const select = (
      message: string,
      rankedCards: string[] = [],
      rankedParts?: ReadonlyMap<string, number>,
    ) =>
      prepareReviewedLecture(
        release,
        message,
        undefined,
        undefined,
        [],
        'zh-CN',
        { rankedCards, rankedParts },
      );
    expect(select('状态变量是什么？').trace.selectedCardIds).toEqual(['z']);
    expect(select('状态变量是什么？', ['a']).trace.selectedCardIds).toEqual([
      'z',
    ]);
    expect(select('状态和状态变量有什么区别？').trace.selectedCardIds).toEqual([
      'a',
      'z',
    ]);
    expect(
      select('用于描述系统变化的量叫什么？', ['z']).trace.selectedCardIds,
    ).toEqual(['z']);
    const semantic = select(
      '用于描述系统变化的量叫什么？',
      ['z'],
      new Map([['z', 2]]),
    );
    expect(semantic.kind === 'reviewed' && semantic.knowledge).toContain(
      '尾段证据。',
    );
    expect(semantic.kind === 'reviewed' && semantic.knowledge).toContain(
      '状态变量的教学解释。',
    );
  });

  it('uses a ranked same-release concept for a Spanish paraphrase and ignores an unknown card', () => {
    const release = epicurusRelease();
    const question = '¿Cómo se entiende el bienestar en su contexto histórico?';
    const select = (rankedCards: string[]) =>
      prepareReviewedLecture(
        release,
        question,
        undefined,
        undefined,
        [],
        'zh-CN',
        { rankedCards },
      );
    expect(select(['unknown-card']).kind).toBe('clarify');
    const selected = select(['course-concept']);
    expect(selected.kind).toBe('reviewed');
    expect(selected.trace.selectedCardIds).toContain('course-concept');
    if (selected.kind === 'reviewed')
      expect(selected.planner.currentTurnContract.responseLanguage).toBe('es');
  });
  it('selects a time-dependent column and a matching worked norm without relying on course IDs', () => {
    const make = (
      name: string,
      value: string,
      summary: string,
    ): LectureExhibit => ({
      cardId: name,
      names: [name],
      ref: { id: name, kind: 'latex', label: name, value, requires: [] },
      summary: { en: summary, zh: '' },
    });
    const column = make(
      'population vector',
      String.raw`x(t)=\begin{bmatrix}S(t)\\T(t)\\P(t)\end{bmatrix}`,
      'shark tuna plankton 鲨鱼、金枪鱼、浮游生物',
    );
    const tangent = make(
      '变化向量',
      String.raw`\begin{bmatrix}4\\-1.5\end{bmatrix}`,
      'rate of change',
    );
    const norm = make(
      'Magnitude of tangent vector',
      String.raw`|v|=\sqrt{(-1.5)^2+4^2}`,
      '欧氏长度',
    );
    for (const q of [
      '三行列向量，鲨鱼和金枪鱼等，保留时间参数',
      'Write the three-row shark column vector with the time argument',
    ])
      expect(matchExhibits([column, tangent, norm], q)).toEqual([column]);
    for (const q of ['变化向量 (4,−1.5) 的欧氏长度', 'Magnitude of (4,-1.5)'])
      expect(matchExhibits([column, tangent, norm], q)).toEqual([norm]);
    expect(matchExhibits([norm], 'Magnitude of (3,4)')).toEqual([]);
    expect(matchExhibits([norm], 'Magnitude of (4,+1.5)')).toEqual([]);
  });
  it('uses image-specific evidence across languages and does not confuse an addition diagram with the formula', () => {
    const make = (
      id: string,
      kind: 'latex' | 'image',
      names: string[],
      zh: string,
      en: string,
    ): LectureExhibit => ({
      cardId: id,
      ref: { id, kind, value: id, label: names[0], requires: [] },
      names,
      summary: { zh, en },
    });
    const items = [
      make(
        'sum',
        'latex',
        ['向量加法', 'Vector addition'],
        '对应分量相加',
        'Add components',
      ),
      make(
        'arrows',
        'image',
        ['向量加法', 'Vector addition'],
        '绿色和蓝色箭头相加，得到红色箭头。',
        'Green and blue arrows add to the red arrow.',
      ),
      make(
        'vector',
        'image',
        ['三维状态向量', 'State vector'],
        '箭头端点表示 S、T、P 三轴上的种群数量。',
        'The arrow tip on axes S, T and P gives population counts.',
      ),
      make(
        'series',
        'image',
        ['种群时间序列', 'Time series'],
        '横轴是时间，比较波峰先后。',
        'Horizontal axis is time; compare peaks.',
      ),
    ];
    for (const [question, target] of [
      ['请展示向量加法的课程图，根据绿色和蓝色箭头解释红色箭头。', 'arrows'],
      [
        'Show the lesson figure with axes S, T and P. What does the arrow tip represent?',
        'vector',
      ],
      ['请展示鲨鱼和金枪鱼的课程图，比较波峰先后。', 'series'],
    ]) {
      expect(exhibitDisplay(question)).toBe('image');
      expect(
        matchExhibits(
          items.filter((item) => item.ref.kind === 'image'),
          question,
        ).map((item) => item.ref.id),
      ).toEqual([target]);
    }
    expect(exhibitDisplay('不用配图，请写出算式。')).toBe('no-image');
  });
  it('attaches a uniquely linked object from a cited passage and ignores uncited sources', () => {
    const item: LectureExhibit = {
      cardId: 'range',
      names: ['一维取值范围'],
      summary: { en: '', zh: '允许非负数。' },
      ref: {
        id: 'range',
        kind: 'image',
        label: '范围',
        requires: [],
        value: '11111111-1111-4111-8111-111111111111.png',
      },
    };
    const passages = ['其他内容', '比较三个坐标轴。[范围](refobj:range)'];
    expect(exhibitsForAnswer([item], '见课文 [2]。', passages)).toEqual([item]);
    expect(
      exhibitsForAnswer(
        [item],
        '见课文 [1]。\n来源\n[2] 一维取值范围',
        passages,
      ),
    ).toEqual([]);
    const linked = linkedExhibitPassage(
      [{ title: 'Lesson', contentMd: passages.join('\n\n') }],
      item.ref.id,
    );
    expect(linked).toContain('比较三个坐标轴');
    expect(linked).not.toContain('refobj:range');
  });
  it('keeps the D7 lens, frame and evidence stable and treats a question as a hypothesis', () => {
    const release = epicurusRelease();
    const question = 'Does Epicurus just say enjoy life?';
    const first = prepareReviewedLecture(release, question);
    expect(first).toEqual(prepareReviewedLecture(release, question));
    expect(first.trace.selectedCardIds).toEqual([
      'historical-lens',
      'modern-reading',
      'course-concept',
    ]);
    expect(first.trace.sourceIds).toHaveLength(1);
    expect(first.kind === 'reviewed' && first.planner.likelyIssue).toBeNull();
    expect('knowledge' in first && first.knowledge).toContain(excerpt);
  });

  it('limits semantic fallback to approved course topics and never enables exact QA', async () => {
    const release = epicurusRelease();
    const question = 'What did the Greek thinker mean about mental peace?';
    const unresolved = prepareReviewedLecture(release, question);
    expect(unresolved.trace.outcome).toBe('no_applicable_evidence');
    expect(
      'topicHints' in unresolved
        ? unresolved.topicHints.map(({ id }) => id)
        : [],
    ).toEqual(['epicurus']);
    const inferred = prepareReviewedLecture(
      release,
      question,
      undefined,
      'epicurus',
    );
    expect(inferred.trace.outcome).toBe('selected_after_topic_classification');
    expect(inferred.trace.qaId).toBeUndefined();
    const provider = {
      name: 'fake',
      async *stream() {
        yield await Promise.resolve(
          '{"topic":"other-course","confidence":0.99}',
        );
      },
    };
    await expect(
      classifyLectureTopic(
        provider,
        {
          model: 'test',
          apiKey: 'unused',
          baseUrl: 'https://example.invalid',
        },
        question,
        [{ id: 'epicurus', concepts: ['Epicurus'] }],
      ),
    ).resolves.toBeUndefined();
  });
});
