import { createSnapshotSourceAnchor } from './source-anchor';

const input = {
  courseId: 'c',
  releaseId: 'r',
  pageId: 'p',
  content: '标题\n学生😀知识',
  start: 3,
  end: 7,
};

describe('createSnapshotSourceAnchor', () => {
  it('标题路径参与锚点身份，且不共享调用方数组', () => {
    const path = ['章节'];
    const anchor = createSnapshotSourceAnchor({ ...input, headingPath: path });
    expect(anchor.id).not.toBe(createSnapshotSourceAnchor(input).id);
    path.push('子标题');
    expect(anchor.headingPath).toEqual(['章节']);
  });
  it('返回稳定的快照范围，并绑定课程、版本和内容', () => {
    const anchor = createSnapshotSourceAnchor(input);
    expect(anchor).toEqual(createSnapshotSourceAnchor({ ...input }));
    expect(anchor.id).not.toBe(
      createSnapshotSourceAnchor({ ...input, releaseId: 'other' }).id,
    );
    expect(anchor.id).not.toBe(
      createSnapshotSourceAnchor({ ...input, content: '标题\n教师😀知识' }).id,
    );
  });
  it('拒绝空标识、空或越界范围及拆分表情字符', () => {
    expect(() =>
      createSnapshotSourceAnchor({ ...input, pageId: ' ' }),
    ).toThrow();
    expect(() => createSnapshotSourceAnchor({ ...input, end: 100 })).toThrow();
    expect(() =>
      createSnapshotSourceAnchor({ ...input, end: input.start }),
    ).toThrow();
    expect(() => createSnapshotSourceAnchor({ ...input, end: 6 })).toThrow(
      'surrogate',
    );
  });
  it('未配对 surrogate 与替换字符产生不同的片段哈希', () => {
    const first = createSnapshotSourceAnchor({
      ...input,
      content: '\ud800',
      start: 0,
      end: 1,
    });
    const second = createSnapshotSourceAnchor({
      ...input,
      content: '\ufffd',
      start: 0,
      end: 1,
    });
    expect(first.excerptHash).not.toBe(second.excerptHash);
  });
});
