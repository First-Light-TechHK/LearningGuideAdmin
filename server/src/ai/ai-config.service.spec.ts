import { ConfigService } from '@nestjs/config';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AiConfigService } from './ai-config.service';
import type { KnowledgeClient } from '../ks/contract/knowledge-client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from './crypto.service';
import { DEFAULT_PROMPTS } from './prompt-defaults';

/**
 * AiConfigService 单元测试（§4.2.6 / §5.2，2026-10-20 按 Release 维度改拍）：
 * mock Prisma，聚焦 setOnline / listTutors / setActiveRelease / 无 Release 边界 / 预留钩子。
 */
describe('AiConfigService — Online & Release（§4.2.6/§5.2）', () => {
  const mockPrisma = {
    course: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    courseAiConfig: { findUnique: jest.fn(), upsert: jest.fn() },
    release: { findUnique: jest.fn() },
    promptTemplate: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn() },
  };
  const mockCrypto = { encrypt: jest.fn(), decrypt: jest.fn() };
  const mockConfig = { get: jest.fn() };
  const mockKnowledge = {
    getCourse: jest.fn(),
    getCourseByExternalId: jest.fn(),
    listCourses: jest.fn(),
    getReleaseMeta: jest.fn(),
    setTestRelease: jest.fn(),
    setTutorOnline: jest.fn(),
  };

  let service: AiConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig.get.mockReturnValue('deepseek/deepseek-v4.1-flash');
    mockKnowledge.getCourse.mockResolvedValue({
      id: 'c1',
      title: '课程',
      externalId: null,
      currentReleaseId: null,
      aiTestReleaseId: null,
      aiTutorOnline: false,
    });
    mockKnowledge.listCourses.mockResolvedValue([]);
    mockKnowledge.getReleaseMeta.mockResolvedValue({
      id: 'r1',
      courseId: 'c1',
      versionTag: 'v1',
    });
    mockKnowledge.setTestRelease.mockResolvedValue({
      id: 'c1',
      title: '课程',
      externalId: null,
      currentReleaseId: null,
      aiTestReleaseId: 'r1',
      aiTutorOnline: false,
    });
    mockKnowledge.setTutorOnline.mockResolvedValue({
      id: 'c1',
      title: '课程',
      externalId: null,
      currentReleaseId: null,
      aiTestReleaseId: null,
      aiTutorOnline: true,
    });
    service = new AiConfigService(
      mockPrisma as unknown as PrismaService,
      mockCrypto as unknown as CryptoService,
      mockConfig as unknown as ConfigService,
      mockKnowledge as unknown as KnowledgeClient,
    );
  });

  it('setOnline：写 Course.aiTutorOnline 并返回含 online 的视图', async () => {
    mockKnowledge.getCourse.mockResolvedValue({
      id: 'c1',
      title: '课程',
      externalId: null,
      currentReleaseId: null,
      aiTestReleaseId: null,
      aiTutorOnline: false,
    });
    mockKnowledge.setTutorOnline.mockResolvedValue({
      id: 'c1',
      title: '课程',
      externalId: null,
      currentReleaseId: null,
      aiTestReleaseId: null,
      aiTutorOnline: true,
    });
    const view = await service.setOnline('c1', true);
    expect(view.online).toBe(true);
    expect(mockKnowledge.setTutorOnline).toHaveBeenCalledWith('c1', true);
  });

  it('setOnline：课程不存在应 404', async () => {
    mockKnowledge.getCourse.mockResolvedValue(null);
    await expect(service.setOnline('x', true)).rejects.toThrow(
      NotFoundException,
    );
    expect(mockKnowledge.setTutorOnline).not.toHaveBeenCalled();
  });

  it('listTutors：返回全部课程及 online 状态（读 Course.aiTutorOnline）', async () => {
    mockKnowledge.listCourses.mockResolvedValue([
      { id: 'c1', title: 'A', aiTutorOnline: true },
      { id: 'c2', title: 'B', aiTutorOnline: false },
    ] as never);
    const list = await service.listTutors();
    expect(list).toEqual([
      { courseId: 'c1', title: 'A', online: true },
      { courseId: 'c2', title: 'B', online: false },
    ]);
  });

  it('getConfig：回退 currentReleaseId，releaseId==currentReleaseId 时 isLive=true', async () => {
    mockKnowledge.getCourse.mockResolvedValue({
      id: 'c1',
      title: '课程',
      externalId: null,
      currentReleaseId: 'r1',
      aiTestReleaseId: null,
      aiTutorOnline: false,
    });
    mockPrisma.courseAiConfig.findUnique.mockResolvedValue(null);
    mockKnowledge.getReleaseMeta.mockResolvedValue({
      id: 'r1',
      courseId: 'c1',
      versionTag: 'Course_20260101',
    });
    const view = await service.getConfig('c1');
    expect(view.releaseId).toBe('r1');
    expect(view.releaseTag).toBe('Course_20260101');
    expect(view.isLive).toBe(true);
  });

  it('getConfig：测试所选 Release 非上线版本时 isLive=false', async () => {
    mockKnowledge.getCourse.mockResolvedValue({
      id: 'c1',
      title: '课程',
      externalId: null,
      currentReleaseId: 'r2',
      aiTestReleaseId: 'r1',
      aiTutorOnline: false,
    });
    mockPrisma.courseAiConfig.findUnique.mockResolvedValue(null);
    mockKnowledge.getReleaseMeta.mockResolvedValue({
      id: 'r1',
      courseId: 'c1',
      versionTag: 'Course_20260101',
    });
    const view = await service.getConfig('c1');
    expect(view.releaseId).toBe('r1');
    expect(view.isLive).toBe(false);
  });

  it('getConfig：课程无任何 Release 时返回默认视图（releaseId/releaseTag=null、isLive=false）', async () => {
    mockKnowledge.getCourse.mockResolvedValue({
      id: 'c1',
      title: '课程',
      externalId: null,
      currentReleaseId: null,
      aiTestReleaseId: null,
      aiTutorOnline: false,
    });
    const view = await service.getConfig('c1');
    expect(view.releaseId).toBeNull();
    expect(view.releaseTag).toBeNull();
    expect(view.isLive).toBe(false);
    expect(mockPrisma.courseAiConfig.findUnique).not.toHaveBeenCalled();
  });

  it('setActiveRelease：校验归属后持久化 aiTestReleaseId 并返回视图', async () => {
    mockKnowledge.getCourse.mockResolvedValue({
      id: 'c1',
      title: '课程',
      externalId: null,
      currentReleaseId: 'r2',
      aiTestReleaseId: null,
      aiTutorOnline: false,
    });
    mockKnowledge.getReleaseMeta.mockResolvedValue({
      id: 'r1',
      courseId: 'c1',
      versionTag: 'v1',
    });
    mockKnowledge.setTestRelease.mockResolvedValue({
      id: 'c1',
      title: '课程',
      externalId: null,
      currentReleaseId: 'r2',
      aiTestReleaseId: 'r1',
      aiTutorOnline: false,
    });
    mockPrisma.courseAiConfig.findUnique.mockResolvedValue(null);
    const view = await service.setActiveRelease('c1', 'r1');
    expect(view.releaseId).toBe('r1');
    expect(view.isLive).toBe(false);
    expect(mockKnowledge.setTestRelease).toHaveBeenCalledWith('c1', 'r1');
  });

  it('setActiveRelease：Release 不属于该课程应 404', async () => {
    mockKnowledge.getCourse.mockResolvedValue({
      id: 'c1',
      title: '课程',
      externalId: null,
      currentReleaseId: null,
      aiTestReleaseId: null,
      aiTutorOnline: false,
    });
    mockKnowledge.getReleaseMeta.mockResolvedValue({
      id: 'r9',
      courseId: 'other',
      versionTag: 'v1',
    });
    await expect(service.setActiveRelease('c1', 'r9')).rejects.toThrow(
      NotFoundException,
    );
    expect(mockKnowledge.setTestRelease).not.toHaveBeenCalled();
  });

  it('saveConfig：无 Release 可绑定时应 400', async () => {
    mockKnowledge.getCourse.mockResolvedValue({
      id: 'c1',
      title: '课程',
      externalId: null,
      currentReleaseId: null,
      aiTestReleaseId: null,
      aiTutorOnline: false,
    });
    await expect(
      service.saveConfig({
        courseId: 'c1',
        mode: 'LECTURE',
        llmProvider: 'openrouter',
        llmModel: 'deepseek/deepseek-v4.1-flash',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(mockPrisma.courseAiConfig.upsert).not.toHaveBeenCalled();
  });

  it('saveConfig：按模式只写该模式三列（LECTURE 不触碰 socratic）', async () => {
    mockKnowledge.getCourse.mockResolvedValue({
      id: 'c1',
      title: '课程',
      externalId: null,
      currentReleaseId: 'r1',
      aiTestReleaseId: null,
      aiTutorOnline: false,
    });
    mockPrisma.courseAiConfig.findUnique.mockResolvedValue(null);
    mockPrisma.courseAiConfig.upsert.mockResolvedValue({
      lectureSystemPrompt: 'L',
      lectureWelcomeMsg: 'LW',
      lectureModel: 'm-lect',
      socraticSystemPrompt: null,
      socraticWelcomeMsg: null,
      socraticModel: null,
      llmProvider: 'openrouter',
      apiKey: null,
    });
    mockKnowledge.getReleaseMeta.mockResolvedValue({ id: 'r1', courseId: 'c1', versionTag: 'v1' });
    const view = await service.saveConfig({
      courseId: 'c1',
      mode: 'LECTURE',
      llmProvider: 'openrouter',
      llmModel: 'm-lect',
      systemPrompt: 'L',
      welcomeMsg: 'LW',
    });
    const upsertArgs = mockPrisma.courseAiConfig.upsert.mock.calls[0][0];
    expect(upsertArgs.update).toEqual({
      llmProvider: 'openrouter',
      apiKey: null,
      lectureSystemPrompt: 'L',
      lectureWelcomeMsg: 'LW',
      lectureModel: 'm-lect',
    });
    expect(upsertArgs.update).not.toHaveProperty('socraticSystemPrompt');
    expect(view.lecture.model).toBe('m-lect');
    expect(view.socratic.model).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('saveConfig：SOCRATIC 模式只写 socratic 三列', async () => {
    mockKnowledge.getCourse.mockResolvedValue({
      id: 'c1',
      title: '课程',
      externalId: null,
      currentReleaseId: 'r1',
      aiTestReleaseId: null,
      aiTutorOnline: false,
    });
    mockPrisma.courseAiConfig.findUnique.mockResolvedValue(null);
    mockPrisma.courseAiConfig.upsert.mockResolvedValue({
      lectureSystemPrompt: null,
      lectureWelcomeMsg: null,
      lectureModel: null,
      socraticSystemPrompt: 'S',
      socraticWelcomeMsg: 'SW',
      socraticModel: 'm-soc',
      llmProvider: 'openrouter',
      apiKey: null,
    });
    mockKnowledge.getReleaseMeta.mockResolvedValue({ id: 'r1', courseId: 'c1', versionTag: 'v1' });
    await service.saveConfig({
      courseId: 'c1',
      mode: 'SOCRATIC',
      llmProvider: 'openrouter',
      llmModel: 'm-soc',
      systemPrompt: 'S',
      welcomeMsg: 'SW',
    });
    const upsertArgs = mockPrisma.courseAiConfig.upsert.mock.calls[0][0];
    expect(upsertArgs.update).toEqual({
      llmProvider: 'openrouter',
      apiKey: null,
      socraticSystemPrompt: 'S',
      socraticWelcomeMsg: 'SW',
      socraticModel: 'm-soc',
    });
    expect(upsertArgs.update).not.toHaveProperty('lectureSystemPrompt');
  });

  it('resetConfig：只清空该模式覆盖（LECTURE）', async () => {
    mockKnowledge.getCourse.mockResolvedValue({
      id: 'c1',
      title: '课程',
      externalId: null,
      currentReleaseId: 'r1',
      aiTestReleaseId: null,
      aiTutorOnline: false,
    });
    mockPrisma.courseAiConfig.upsert.mockResolvedValue({
      lectureSystemPrompt: null,
      lectureWelcomeMsg: null,
      lectureModel: null,
      socraticSystemPrompt: 'keep',
      socraticWelcomeMsg: 'keep',
      socraticModel: 'm-soc',
      llmProvider: 'openrouter',
      apiKey: null,
    });
    mockKnowledge.getReleaseMeta.mockResolvedValue({ id: 'r1', courseId: 'c1', versionTag: 'v1' });
    const view = await service.resetConfig('c1', 'LECTURE');
    const upsertArgs = mockPrisma.courseAiConfig.upsert.mock.calls[0][0];
    expect(upsertArgs.update).toEqual({
      lectureSystemPrompt: null,
      lectureWelcomeMsg: null,
      lectureModel: null,
      lectureModeId: null,
    });
    expect(upsertArgs.update).not.toHaveProperty('socraticSystemPrompt');
    expect(view.lecture.model).toBe('deepseek/deepseek-v4.1-flash');
    expect(view.socratic.model).toBe('m-soc');
  });

  it('resolvePrompts：按模式取对应自定义覆盖（优先于模板）', async () => {
    mockPrisma.courseAiConfig.findUnique.mockResolvedValue({
      lectureSystemPrompt: 'cust-L',
      lectureWelcomeMsg: 'wel-L',
      socraticSystemPrompt: null,
      socraticWelcomeMsg: null,
    });
    mockPrisma.promptTemplate.findFirst.mockResolvedValue({
      mode: 'SOCRATIC',
      systemPrompt: 'tpl-S',
      welcomeMsg: 'tpl-SW',
    });
    const lecture = await service.resolvePrompts('c1', 'r1', 'LECTURE');
    expect(lecture).toEqual({ systemPrompt: 'cust-L', welcomeMsg: 'wel-L' });
    const socratic = await service.resolvePrompts('c1', 'r1', 'SOCRATIC');
    expect(socratic).toEqual({ systemPrompt: 'tpl-S', welcomeMsg: 'tpl-SW' });
  });

  it('listPrompts：库中无默认行时按文件默认值合成（只读不写库）', async () => {
    mockPrisma.promptTemplate.findMany.mockResolvedValue([]);
    const list = await service.listPrompts();
    expect(list.map((t) => t.id)).toEqual([
      'lecture-default',
      'socratic-default',
    ]);
    expect(list[0].systemPrompt).toBe(DEFAULT_PROMPTS.LECTURE.systemPrompt);
    expect(list[0].welcomeMsg).toBe(DEFAULT_PROMPTS.LECTURE.welcome['zh-CN']);
    expect(list[1].systemPrompt).toBe(DEFAULT_PROMPTS.SOCRATIC.systemPrompt);
  });

  it('listPrompts：库中已有某模式默认行时保留库值，只补缺失模式', async () => {
    mockPrisma.promptTemplate.findMany.mockResolvedValue([
      {
        id: 'lecture-default',
        mode: 'LECTURE',
        systemPrompt: 'DB-L',
        welcomeMsg: 'DB-LW',
        isDefault: true,
      },
    ]);
    const list = await service.listPrompts();
    expect(list.map((t) => t.id)).toEqual([
      'lecture-default',
      'socratic-default',
    ]);
    expect(list[0].systemPrompt).toBe('DB-L');
    expect(list[0].welcomeMsg).toBe('DB-LW');
    expect(list[1].systemPrompt).toBe(DEFAULT_PROMPTS.SOCRATIC.systemPrompt);
  });

  it('listPrompts：库内默认行字段为空串时仍按文件默认值补齐', async () => {
    mockPrisma.promptTemplate.findMany.mockResolvedValue([
      {
        id: 'lecture-default',
        mode: 'LECTURE',
        systemPrompt: '',
        welcomeMsg: '',
        isDefault: true,
      },
    ]);
    const list = await service.listPrompts();
    expect(list[0].systemPrompt).toBe(DEFAULT_PROMPTS.LECTURE.systemPrompt);
    expect(list[0].welcomeMsg).toBe(DEFAULT_PROMPTS.LECTURE.welcome['zh-CN']);
  });

  it('listPrompts：忽略非法 mode 的库行', async () => {
    mockPrisma.promptTemplate.findMany.mockResolvedValue([
      {
        id: 'legacy',
        mode: 'legacy',
        systemPrompt: 'X',
        welcomeMsg: 'X',
        isDefault: true,
      },
    ]);
    const list = await service.listPrompts();
    expect(list.map((t) => t.mode)).toEqual(['LECTURE', 'SOCRATIC']);
  });

  it('resolvePrompts：库中无模板时回退文件默认值（云端空库不空白）', async () => {
    mockPrisma.courseAiConfig.findUnique.mockResolvedValue(null);
    mockPrisma.promptTemplate.findFirst.mockResolvedValue(null);
    const view = await service.resolvePrompts('c1', 'r1', 'LECTURE');
    expect(view.systemPrompt).toBe(DEFAULT_PROMPTS.LECTURE.systemPrompt);
    expect(view.welcomeMsg).toBe(DEFAULT_PROMPTS.LECTURE.welcome['zh-CN']);
  });

  it('resolvePrompts：课程绑定的模板 id 已失效时回退文件默认值', async () => {
    mockPrisma.courseAiConfig.findUnique.mockResolvedValue({
      lectureModeId: 'missing-template',
      lectureSystemPrompt: null,
      lectureWelcomeMsg: null,
    });
    mockPrisma.promptTemplate.findUnique.mockResolvedValue(null);
    const view = await service.resolvePrompts('c1', 'r1', 'LECTURE');
    expect(view.systemPrompt).toBe(DEFAULT_PROMPTS.LECTURE.systemPrompt);
    expect(view.welcomeMsg).toBe(DEFAULT_PROMPTS.LECTURE.welcome['zh-CN']);
  });

  it('resolveLearnerWelcome：按 externalId 返回两种模式生效的 welcome（自定义优先、模板兜底）', async () => {
    mockKnowledge.getCourseByExternalId.mockResolvedValue({ id: 'c1', title: '课程', externalId: 'portal-slug', currentReleaseId: 'r1', aiTestReleaseId: null, aiTutorOnline: true });
    mockPrisma.courseAiConfig.findUnique.mockResolvedValue({
      lectureWelcomeMsg: 'wel-L',
      socraticWelcomeMsg: null,
    });
    mockPrisma.promptTemplate.findFirst.mockImplementation(({ where }: { where: { mode: string } }) =>
      Promise.resolve(where.mode === 'LECTURE' ? { welcomeMsg: 'tpl-L' } : { welcomeMsg: 'tpl-SW' }),
    );
    const view = await service.resolveLearnerWelcome('portal-slug');
    expect(view).toEqual({ lecture: 'wel-L', socratic: 'tpl-SW' });
    expect(mockKnowledge.getCourseByExternalId).toHaveBeenCalledWith('portal-slug');
  });

  it('resolveLearnerWelcome：默认模板（isDefault）按 locale 取文件欢迎语，且不含“选择课程”口径', async () => {
    mockKnowledge.getCourseByExternalId.mockResolvedValue({ id: 'c1', currentReleaseId: 'r1', aiTutorOnline: true });
    mockPrisma.courseAiConfig.findUnique.mockResolvedValue(null);
    mockPrisma.promptTemplate.findFirst.mockResolvedValue({ id: 'lecture-default', isDefault: true, welcomeMsg: 'DB-zh' });
    const zh = await service.resolveLearnerWelcome('portal-slug', 'zh-CN');
    const en = await service.resolveLearnerWelcome('portal-slug', 'en-GB');
    expect(zh.lecture).not.toBe('DB-zh');
    expect(zh.lecture).not.toContain('选择课程');
    expect(en.lecture).toMatch(/AI Tutor/);
    expect(zh.lecture).not.toBe(en.lecture);
    expect(zh.socratic).toMatch(/AI 导师/);
  });

  it('resolveLearnerWelcome：课程绑定非默认模板时使用模板自身的 welcomeMsg', async () => {
    mockKnowledge.getCourseByExternalId.mockResolvedValue({ id: 'c1', currentReleaseId: 'r1', aiTutorOnline: true });
    mockPrisma.courseAiConfig.findUnique.mockResolvedValue({
      lectureModeId: 'custom-lecture',
      lectureWelcomeMsg: null,
      socraticWelcomeMsg: null,
    });
    mockPrisma.promptTemplate.findUnique.mockResolvedValue({
      id: 'custom-lecture',
      isDefault: false,
      welcomeMsg: 'Custom template welcome',
    });
    mockPrisma.promptTemplate.findFirst.mockResolvedValue({ id: 'socratic-default', isDefault: true, welcomeMsg: 'DB-zh' });
    const view = await service.resolveLearnerWelcome('portal-slug', 'en-GB');
    expect(view.lecture).toBe('Custom template welcome');
    expect(view.socratic).toMatch(/AI Tutor/);
  });

  it('resolveLearnerWelcome：课程自定义 welcome 优先于模板与文件默认值', async () => {
    mockKnowledge.getCourseByExternalId.mockResolvedValue({ id: 'c1', currentReleaseId: 'r1', aiTutorOnline: true });
    mockPrisma.courseAiConfig.findUnique.mockResolvedValue({
      lectureWelcomeMsg: 'Course override L',
      socraticWelcomeMsg: 'Course override S',
    });
    mockPrisma.promptTemplate.findFirst.mockResolvedValue({ id: 'lecture-default', isDefault: true, welcomeMsg: 'DB-zh' });
    const view = await service.resolveLearnerWelcome('portal-slug', 'en-GB');
    expect(view).toEqual({ lecture: 'Course override L', socratic: 'Course override S' });
  });

  it('resolveLearnerWelcome：课程不存在 / 未开放 / 无上线版本分别 404 / 403 / 409', async () => {
    mockKnowledge.getCourseByExternalId.mockResolvedValueOnce(null);
    await expect(service.resolveLearnerWelcome('missing')).rejects.toBeInstanceOf(NotFoundException);
    mockKnowledge.getCourseByExternalId.mockResolvedValueOnce({ id: 'c1', currentReleaseId: 'r1', aiTutorOnline: false });
    await expect(service.resolveLearnerWelcome('offline')).rejects.toBeInstanceOf(ForbiddenException);
    mockKnowledge.getCourseByExternalId.mockResolvedValueOnce({ id: 'c1', currentReleaseId: null, aiTutorOnline: true });
    await expect(service.resolveLearnerWelcome('unpublished')).rejects.toBeInstanceOf(ConflictException);
  });

  it('resolveRuntime：按模式取模型（缺省回退默认）', async () => {
    mockPrisma.courseAiConfig.findUnique.mockResolvedValue({
      llmProvider: 'openrouter',
      apiKey: null,
      lectureModel: 'm-lect',
      socraticModel: null,
    });
    const lecture = await service.resolveRuntime('c1', 'r1', 'LECTURE');
    expect(lecture.model).toBe('m-lect');
    const socratic = await service.resolveRuntime('c1', 'r1', 'SOCRATIC');
    expect(socratic.model).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('listOnlineTutorsForUser：返回 externalId 映射，available = online && 有上线版本', async () => {
    mockKnowledge.listCourses.mockResolvedValue([
      {
        id: 'c1',
        externalId: 'epicureanism',
        title: 'A',
        aiTutorOnline: true,
        currentReleaseId: 'r1',
      },
      {
        id: 'c2',
        externalId: 'stoicism',
        title: 'B',
        aiTutorOnline: true,
        currentReleaseId: null,
      },
      {
        id: 'c3',
        externalId: 'calculus',
        title: 'C',
        aiTutorOnline: false,
        currentReleaseId: 'r2',
      },
    ] as never);
    const list = await service.listOnlineTutorsForUser();
    expect(list).toEqual([
      {
        externalId: 'epicureanism',
        courseId: 'c1',
        title: 'A',
        online: true,
        available: true,
      },
      {
        externalId: 'stoicism',
        courseId: 'c2',
        title: 'B',
        online: true,
        available: false,
      },
      {
        externalId: 'calculus',
        courseId: 'c3',
        title: 'C',
        online: false,
        available: false,
      },
    ]);
    expect(mockKnowledge.listCourses).toHaveBeenCalledWith({ mappedOnly: true });
  });
});
