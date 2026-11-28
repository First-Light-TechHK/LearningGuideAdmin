import {
  followUpEvidenceMatches,
  resolveLectureFollowUp,
} from './lecture-follow-up';

const anchor = '为什么状态变量要有数值和单位？';
const user = (content: string) => ({ role: 'user', content });

describe('Lecture follow-up goal', () => {
  it('keeps the full question across languages and consecutive examples', () => {
    const goal = resolveLectureFollowUp('Can you give an example?', [
      user(anchor),
      user('可以解释一下吗？'),
    ]);
    expect(goal).toMatchObject({ kind: 'example', anchor, ambiguous: false });
    expect(goal?.target).toContain(anchor);
    expect(
      resolveLectureFollowUp('再举一个，换成动物种群', [
        user(anchor),
        user('可以举个例子吗？'),
      ]),
    ).toMatchObject({ kind: 'example', anchor, anotherExample: true });
  });

  it('starts a new topic when the user asks a complete question and clarifies multiple anchors', () => {
    expect(
      resolveLectureFollowUp('那轨迹是什么？', [user(anchor)]),
    ).toBeUndefined();
    expect(
      resolveLectureFollowUp('可以解释一下吗？', [
        user('什么是轨迹？什么是状态空间？'),
      ]),
    ).toMatchObject({ ambiguous: true });
    expect(resolveLectureFollowUp('这个呢？', [user(anchor)])).toMatchObject({
      kind: 'explain',
      ambiguous: false,
    });
  });

  it('carries forward the latest replacement unit without inheriting an earlier topic', () => {
    const question = '如果改用华氏度呢？';
    const goal = resolveLectureFollowUp(question, [user(anchor)])!;
    expect(goal.kind).toBe('condition');
    expect(followUpEvidenceMatches(goal, question, ['The room is 30°C.'])).toBe(
      false,
    );
    expect(
      followUpEvidenceMatches(goal, question, [
        '86°F is the same temperature as 30°C.',
      ]),
    ).toBe(true);
    const next = resolveLectureFollowUp('可以举个例子吗？', [
      user(anchor),
      user(question),
    ])!;
    expect(
      followUpEvidenceMatches(next, '可以举个例子吗？', ['The room is 30°C.']),
    ).toBe(false);
    expect(
      resolveLectureFollowUp('可以举个例子吗？', [
        user(anchor),
        user(question),
        user('什么是轨迹？'),
      ])?.changes,
    ).toEqual([]);
  });

  it('requires a measurement example for the anchored quantitative question', () => {
    const goal = resolveLectureFollowUp('可以举个例子吗？', [user(anchor)])!;
    expect(
      followUpEvidenceMatches(goal, '可以举个例子吗？', [
        'Sharks and tuna form a state space.',
      ]),
    ).toBe(false);
    expect(
      followUpEvidenceMatches(goal, '可以举个例子吗？', [
        '30°C describes the measured temperature.',
      ]),
    ).toBe(true);
  });

  it('distinguishes a request for the lecture wording from one for the professor QA', () => {
    expect(
      resolveLectureFollowUp('你刚才说的那句话，讲稿里怎么写？', [user(anchor)])
        ?.quotationSource,
    ).toBe('course_context');
    expect(
      resolveLectureFollowUp('可以引用教授的问答原文吗？', [user(anchor)])
        ?.quotationSource,
    ).toBe('professor_qa');
  });
});
