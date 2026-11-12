import { buildTutorContext, loadTutorRelease } from './course-context';
import type {
  KnowledgeClient,
  KnowledgeRelease,
} from '../../ks/contract/knowledge-client';

const release: KnowledgeRelease = {
  id: 'r1',
  courseId: 'c1',
  versionTag: 'v1',
  pages: [
    { title: 'Lesson 1', contentMd: 'State variables describe a model.' },
    {
      title: '全书七章精华提炼',
      contentMd: 'Later chapters cover eigenvalues.',
    },
  ],
};

describe('母版式 Release 上下文', () => {
  it('Yong 小包按 Page 顺序使用完整 Wiki Markdown，Jack 保持结构化来源', async () => {
    const retrieveChunks = jest.fn();
    const knowledge = {
      retrieveChunks,
    } as unknown as KnowledgeClient;
    const yong = await buildTutorContext(
      knowledge,
      release,
      'state',
      [],
      'wiki',
    );
    const jack = await buildTutorContext(knowledge, release, 'state');
    expect(yong.text).toBe(
      '# Lesson 1\n\nState variables describe a model.\n\n# 全书七章精华提炼\n\nLater chapters cover eigenvalues.',
    );
    expect(jack.text).toContain('"sourceLevel":"lesson"');
    expect(retrieveChunks).not.toHaveBeenCalled();
  });
  it('小包包含全部正文及来源层级，不依赖 embedding 检索', async () => {
    const retrieveChunks = jest.fn();
    const result = await buildTutorContext(
      { retrieveChunks } as unknown as KnowledgeClient,
      release,
      'What is a state?',
    );
    expect(result.strategy).toBe('snapshot');
    expect(result.text).toContain('State variables');
    expect(result.text).toContain('Later chapters');
    expect(result.text).toContain('"sourceLevel":"lesson"');
    expect(result.text).toContain('"sourceLevel":"course_digest"');
    expect(retrieveChunks).not.toHaveBeenCalled();
  });

  it('空正文明确失败，大包使用受预算检索且不截取伪造的完整快照', async () => {
    const retrieveChunks = jest.fn();
    retrieveChunks.mockResolvedValue([
      {
        pageTitle: 'Lesson 1',
        heading: 'State',
        content: 'Selected evidence',
        score: 1,
        tokenCount: 20,
      },
    ]);
    const knowledge = { retrieveChunks } as unknown as KnowledgeClient;
    await expect(
      buildTutorContext(knowledge, { ...release, pages: [] }, 'state'),
    ).rejects.toThrow('没有可用正文');
    const large = {
      ...release,
      pages: [{ title: 'Lesson 1', contentMd: 'x'.repeat(25000) }],
    };
    const result = await buildTutorContext(knowledge, large, 'state');
    expect(result.strategy).toBe('retrieval');
    expect(result.text).toContain('Selected evidence');
    expect(retrieveChunks).toHaveBeenCalledWith('r1', 'state');
  });

  it('缺版本、跨课版本和服务失败均不降级为无知识回答', async () => {
    const getRelease = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...release, courseId: 'other' })
      .mockRejectedValueOnce(new Error('KS unavailable'));
    const knowledge = { getRelease } as unknown as KnowledgeClient;
    await expect(loadTutorRelease(knowledge, 'c1', 'r1')).rejects.toThrow(
      '不存在',
    );
    await expect(loadTutorRelease(knowledge, 'c1', 'r1')).rejects.toThrow(
      '不属于',
    );
    await expect(loadTutorRelease(knowledge, 'c1', 'r1')).rejects.toThrow(
      'KS unavailable',
    );
  });
});
