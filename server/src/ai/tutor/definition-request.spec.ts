import {
  asksForDefinition,
  definitionFollowUp,
  partitionDefinitionRequests,
} from './definition-request';

describe('Lecture definition requests', () => {
  it.each([
    '什么是 trajectory（轨迹）？',
    '什么是轨迹（trajectory）？',
    'What is a trajectory?',
    'What does trajectory mean?',
  ])('recognizes an explicit name in %s', (request) => {
    expect(asksForDefinition(request, 'Trajectory')).toBe(true);
  });

  it('separates requested definitions from operational questions', () => {
    expect(
      partitionDefinitionRequests(
        '什么是 trajectory（轨迹）？能从形状判断速度吗？',
        [['Trajectory']],
      ),
    ).toEqual({
      covered: ['什么是 trajectory（轨迹）'],
      remaining: ['能从形状判断速度吗'],
    });
    expect(
      asksForDefinition('What is the speed along a trajectory?', 'Trajectory'),
    ).toBe(false);
    expect(
      partitionDefinitionRequests('什么是 trajectory（轨迹）？', [
        ['Trajectory'],
        ['轨迹'],
      ]).covered,
    ).toEqual([]);
  });

  it('classifies short continuations without claiming an explicitly named subject', () => {
    expect(definitionFollowUp('可以解释一下吗？')).toBe('explain');
    expect(definitionFollowUp('再举个例子呢？')).toBe('example');
    expect(definitionFollowUp('讲稿里是怎么说的？')).toBe('quotation');
    expect(definitionFollowUp('可以解释一下状态空间吗？')).toBeUndefined();
  });
});
