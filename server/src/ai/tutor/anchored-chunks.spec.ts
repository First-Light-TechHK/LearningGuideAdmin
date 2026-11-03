import { buildAnchoredChunks } from './anchored-chunks';

const build = (contentMd: string) =>
  buildAnchoredChunks({
    courseId: 'c',
    releaseId: 'r',
    snapshot: { pages: [{ id: 'p', title: 'T', contentMd }] },
  });

describe('buildAnchoredChunks', () => {
  it('记录块起始标题层级，忽略围栏内伪标题并隔离页面', () => {
    const contentMd = `# Root\n## First\n\`\`\`md\n# Fake\n\`\`\`\n${'a'.repeat(3500)}\n## Second\n${'b'.repeat(5000)}`;
    const chunks = buildAnchoredChunks({
      courseId: 'c',
      releaseId: 'r',
      snapshot: {
        pages: [
          { id: 'one', title: 'One', contentMd },
          { id: 'two', title: 'Two', contentMd: '# Other\nSame' },
        ],
      },
    });
    const firstPage = chunks.filter((chunk) => chunk.anchor.pageId === 'one');
    expect(firstPage[0].anchor.headingPath).toEqual(['Root']);
    expect(
      firstPage
        .slice(1)
        .some((chunk) => chunk.anchor.headingPath.join('/') === 'Root/First'),
    ).toBe(true);
    expect(
      firstPage.some(
        (chunk) => chunk.anchor.headingPath.join('/') === 'Root/Second',
      ),
    ).toBe(true);
    expect(
      chunks.find((chunk) => chunk.anchor.pageId === 'two')?.anchor.headingPath,
    ).toEqual(['Other']);
    expect(
      chunks.every((chunk) => !chunk.anchor.headingPath.includes('Fake')),
    ).toBe(true);
  });
  it('保留 CRLF 的段落边界与原文位置', () => {
    const text = `${'a'.repeat(1800)}\r\n\r\n${'b'.repeat(3200)}`;
    const chunks = build(text);
    expect(chunks[0].anchor.end).toBe(1804);
    expect(chunks[0].content).toBe(text.slice(0, 1804));
    expect(chunks[1].anchor.start).toBe(1804 - 320);
  });

  it('窗口和重叠边界不拆分 surrogate pair', () => {
    for (const text of [
      `${'a'.repeat(3199)}😀${'b'.repeat(500)}`,
      `${'a'.repeat(2879)}😀${'b'.repeat(500)}`,
    ]) {
      for (const chunk of build(text)) {
        expect(chunk.content).toBe(
          text.slice(chunk.anchor.start, chunk.anchor.end),
        );
      }
    }
  });
  it('每一块精确指向原文，重复构建稳定并覆盖原文', () => {
    const text = `${'a'.repeat(1600)}\n\n${'重复 😀 '.repeat(700)}`;
    const chunks = build(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks).toEqual(build(text));
    expect(chunks[0].anchor.start).toBe(0);
    expect(chunks[chunks.length - 1].anchor.end).toBe(text.length);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      expect(chunk.content).toBe(
        text.slice(chunk.anchor.start, chunk.anchor.end),
      );
      expect(chunk.tokenCount).toBeLessThanOrEqual(800);
      if (i) expect(chunk.anchor.start).toBeLessThan(chunks[i - 1].anchor.end);
    }
  });
  it('快照或 Release 变化生成不同标识', () => {
    const page = { id: 'p', title: 'T', contentMd: 'abc' };
    const first = buildAnchoredChunks({
      courseId: 'c',
      releaseId: 'r',
      snapshot: { pages: [page] },
    })[0];
    expect(first.id).not.toBe(
      buildAnchoredChunks({
        courseId: 'c',
        releaseId: 'other',
        snapshot: { pages: [page] },
      })[0].id,
    );
    expect(first.id).not.toBe(build('abcd')[0].id);
  });
  it('空白页面无块，拒绝重复页面 ID', () => {
    expect(build('  \n')).toEqual([]);
    expect(() =>
      buildAnchoredChunks({
        courseId: 'c',
        releaseId: 'r',
        snapshot: {
          pages: [
            { id: 'p', title: 'T', contentMd: 'a' },
            { id: 'p', title: 'T', contentMd: 'b' },
          ],
        },
      }),
    ).toThrow();
  });
});
