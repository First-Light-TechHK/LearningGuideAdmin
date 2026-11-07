import { imageAfterParagraph, selectKnowledgeImages } from './knowledge-images';

const courseId = '11111111-1111-4111-8111-111111111111';
const imageId = '22222222-2222-4222-8222-222222222222';
const url = `/api/files/images/${courseId}/${imageId}.png`;
const evidence = (content: string) =>
  JSON.stringify({ reference: 'S1', evidence: content });

describe('Knowledge 图片引用', () => {
  it('仅从当前课程的本轮证据选图，不要求用户说图片', () => {
    const context = evidence(
      `状态变量与状态空间的关系。![状态变量图](${url}) ![别的课程](/api/files/images/other/${imageId}.png)`,
    );
    expect(
      selectKnowledgeImages(context, courseId, '解释状态变量与状态空间'),
    ).toEqual([expect.objectContaining({ alt: '状态变量图', url })]);
    expect(
      selectKnowledgeImages(context, 'other-course', '解释状态变量与状态空间'),
    ).toEqual([]);
    expect(
      selectKnowledgeImages(evidence('没有图片'), courseId, '解释状态变量'),
    ).toEqual([]);
    expect(selectKnowledgeImages(context, courseId, '解释欧拉方法')).toEqual(
      [],
    );
  });

  it('相关段落后插入图片，无关段落不插入', () => {
    const [image] = selectKnowledgeImages(
      evidence(`状态变量。![状态变量图](${url})`),
      courseId,
      '状态变量是什么',
    );
    expect(imageAfterParagraph('状态变量描述系统此刻的数值。', image)).toBe(
      `\n\n![状态变量图](${url})`,
    );
    expect(imageAfterParagraph('这是无关的课程管理说明。', image)).toBe('');
  });
});
