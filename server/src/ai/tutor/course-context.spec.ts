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

  it('大包保留课程摘要中的积分定义及课时边界，不再被 1100 预算挤掉', async () => {
    const retrieveChunks = jest.fn().mockResolvedValue([
      {
        pageTitle: 'Lesson 1',
        heading: 'Scope',
        content:
          'Lesson 1 covers vectors; integration is developed in Chapter 2.',
        score: 0.4,
        tokenCount: 800,
      },
      {
        pageTitle: '全书七章精华提炼',
        heading: '第二章：导数与积分',
        content: '积分把小块累积起来；已知变化率可以还原总量。',
        score: 0.2,
        tokenCount: 380,
      },
      {
        pageTitle: 'Too large',
        heading: null,
        content: 'This oversized chunk must not displace complete evidence.',
        score: 0.9,
        tokenCount: 8001,
      },
    ]);
    const result = await buildTutorContext(
      { retrieveChunks } as unknown as KnowledgeClient,
      {
        ...release,
        pages: [{ title: 'Lesson 1', contentMd: 'x'.repeat(25000) }],
      },
      '什么是积分？',
    );
    expect(result.text).toContain('Lesson 1 covers vectors');
    expect(result.text).toContain('积分把小块累积起来');
    expect(result.text).toContain('"sourceLevel":"course_digest"');
    expect(result.text).not.toContain('oversized chunk');
  });
});
