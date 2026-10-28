import { ConfigService } from '@nestjs/config';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AiConfigService } from './ai-config.service';
import type { KnowledgeClient } from '../ks/contract/knowledge-client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from './crypto.service';
import { DEFAULT_PROMPTS } from './prompt-defaults';

/**
 * AiConfigService 单元测试（§4.2.6 / §5.2，2026-10-27 重构：System Prompt 按模式，Welcome/Model 共享）。
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
      id: 'c1', title: '课程', externalId: null,
      currentReleaseId: null, aiTestReleaseId: null, aiTutorOnline: false,
    });
    mockKnowledge.setTutorOnline.mockResolvedValue({
      id: 'c1', title: '课程', externalId: null,
      currentReleaseId: null, aiTestReleaseId: null, aiTutorOnline: true,
    });
    const view = await service.setOnline('c1', true);
    expect(view.online).toBe(true);
    expect(mockKnowledge.setTutorOnline).toHaveBeenCalledWith('c1', true);
  });

  it('setOnline：课程不存在应 404', async () => {
    mockKnowledge.getCourse.mockResolvedValue(null);
    await expect(service.setOnline('x', true)).rejects.toThrow(NotFoundException);
    expect(mockKnowledge.setTutorOnline).not.toHaveBeenCalled();
  });

  it('listTutors：返回全部课程及 online 状态', async () => {
    mockKnowledge.listCourses.mockResolvedValue([
      { id: 'c1', title: 'A', aiTutorOnline: true, externalId: 'a', currentReleaseId: 'r1' },
      { id: 'c2', title: 'B', aiTutorOnline: false, externalId: 'b', currentReleaseId: 'r2' },
    ] as never);
    const list = await service.listTutors();
    expect(list).toEqual([
      { courseId: 'c1', title: 'A', online: true, externalId: 'a', hasLiveRelease: true, available: true, blockedReason: null },
      { courseId: 'c2', title: 'B', online: false, externalId: 'b', hasLiveRelease: true, available: false, blockedReason: 'not-online' },
    ]);
  });

  // 2026-10-28 复盘 A1：后台必须能解释"开了 Online 但学员端没入口"。
  it('listTutors：给出 blockedReason，区分未同步 / 无上线版本 / 未开启', async () => {
    mockKnowledge.listCourses.mockResolvedValue([
      { id: 'unsynced', title: 'Unsynced', aiTutorOnline: true, externalId: null, currentReleaseId: 'r1' },
      { id: 'norelease', title: 'NoRelease', aiTutorOnline: true, externalId: 'c', currentReleaseId: null },
      { id: 'off', title: 'Off', aiTutorOnline: false, externalId: 'd', currentReleaseId: 'r2' },
      { id: 'ok', title: 'Ok', aiTutorOnline: true, externalId: 'e', currentReleaseId: 'r3' },
    ] as never);
    const byId = Object.fromEntries(
      (await service.listTutors()).map((row) => [row.courseId, row]),
    );
    expect(byId.unsynced.blockedReason).toBe('not-synced');
    expect(byId.unsynced.available).toBe(false);
    expect(byId.norelease.blockedReason).toBe('no-live-release');
    expect(byId.norelease.hasLiveRelease).toBe(false);
    expect(byId.off.blockedReason).toBe('not-online');
    expect(byId.ok).toMatchObject({ available: true, blockedReason: null });
  });

  it('getConfig：回退 currentReleaseId，releaseId==currentReleaseId 时 isLive=true', async () => {
    mockKnowledge.getCourse.mockResolvedValue({
      id: 'c1', title: '课程', externalId: null,
      currentReleaseId: 'r1', aiTestReleaseId: null, aiTutorOnline: false,
    });
    mockPrisma.courseAiConfig.findUnique.mockResolvedValue(null);
    mockKnowledge.getReleaseMeta.mockResolvedValue({ id: 'r1', courseId: 'c1', versionTag: 'Course_20260101' });
    const view = await service.getConfig('c1');
    expect(view.releaseId).toBe('r1');
    expect(view.isLive).toBe(true);
    expect(view.welcomeMsg).toBeNull();
    expect(view.model).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('getConfig：测试所选 Release 非上线版本时 isLive=false', async () => {
    mockKnowledge.getCourse.mockResolvedValue({
      id: 'c1', title: '课程', externalId: null,
      currentReleaseId: 'r2', aiTestReleaseId: 'r1', aiTutorOnline: false,
    });
    mockPrisma.courseAiConfig.findUnique.mockResolvedValue(null);
    mockKnowledge.getReleaseMeta.mockResolvedValue({ id: 'r1', courseId: 'c1', versionTag: 'v1' });
    const view = await service.getConfig('c1');
    expect(view.releaseId).toBe('r1');
    expect(view.isLive).toBe(false);
  });

  it('getConfig：课程无任何 Release 时返回默认视图', async () => {
    mockKnowledge.getCourse.mockResolvedValue({
      id: 'c1', title: '课程', externalId: null,
      currentReleaseId: null, aiTestReleaseId: null, aiTutorOnline: false,
    });
    const view = await service.getConfig('c1');
    expect(view.releaseId).toBeNull();
    expect(view.isLive).toBe(false);
    expect(mockPrisma.courseAiConfig.findUnique).not.toHaveBeenCalled();
  });

  it('setActiveRelease：校验归属后持久化 aiTestReleaseId 并返回视图', async () => {
    mockKnowledge.getCourse.mockResolvedValue({
      id: 'c1', title: '课程', externalId: null,
      currentReleaseId: 'r2', aiTestReleaseId: null, aiTutorOnline: false,
    });
    mockKnowledge.getReleaseMeta.mockResolvedValue({ id: 'r1', courseId: 'c1', versionTag: 'v1' });
    mockKnowledge.setTestRelease.mockResolvedValue({
      id: 'c1', title: '课程', externalId: null,
      currentReleaseId: 'r2', aiTestReleaseId: 'r1', aiTutorOnline: false,
    });
    mockPrisma.courseAiConfig.findUnique.mockResolvedValue(null);
    const view = await service.setActiveRelease('c1', 'r1');
    expect(view.releaseId).toBe('r1');
    expect(view.isLive).toBe(false);
    expect(mockKnowledge.setTestRelease).toHaveBeenCalledWith('c1', 'r1');
  });

  it('setActiveRelease：Release 不属于该课程应 404', async () => {
    mockKnowledge.getCourse.mockResolvedValue({
      id: 'c1', title: '课程', externalId: null,
      currentReleaseId: null, aiTestReleaseId: null, aiTutorOnline: false,
    });
    mockKnowledge.getReleaseMeta.mockResolvedValue({ id: 'r9', courseId: 'other', versionTag: 'v1' });
    await expect(service.setActiveRelease('c1', 'r9')).rejects.toThrow(NotFoundException);
    expect(mockKnowledge.setTestRelease).not.toHaveBeenCalled();
  });

  it('saveConfig：无 Release 可绑定时应 400', async () => {
    mockKnowledge.getCourse.mockResolvedValue({
      id: 'c1', title: '课程', externalId: null,
      currentReleaseId: null, aiTestReleaseId: null, aiTutorOnline: false,
    });
    await expect(
      service.saveConfig({ courseId: 'c1', mode: 'LECTURE', llmProvider: 'openrouter', llmModel: 'm' }),
    ).rejects.toThrow(BadRequestException);
    expect(mockPrisma.courseAiConfig.upsert).not.toHaveBeenCalled();
  });

  it('saveConfig：LECTURE 只写 lectureSystemPrompt，Welcome/Model 写共享列', async () => {
    mockKnowledge.getCourse.mockResolvedValue({
      id: 'c1', title: '课程', externalId: null,
      currentReleaseId: 'r1', aiTestReleaseId: null, aiTutorOnline: false,
    });
    mockPrisma.courseAiConfig.findUnique.mockResolvedValue(null);
    mockPrisma.courseAiConfig.upsert.mockResolvedValue({
      lectureSystemPrompt: 'L', socraticSystemPrompt: null, assessmentSystemPrompt: null,
      welcomeMsg: 'W', model: 'deepseek/deepseek-v4.1-flash', llmProvider: 'openrouter', apiKey: null,
    });
    mockKnowledge.getReleaseMeta.mockResolvedValue({ id: 'r1', courseId: 'c1', versionTag: 'v1' });
    const view = await service.saveConfig({
      courseId: 'c1', mode: 'LECTURE', llmProvider: 'openrouter',
      llmModel: 'deepseek/deepseek-v4.1-flash', systemPrompt: 'L', welcomeMsg: 'W',
    });
    const upsertArgs = mockPrisma.courseAiConfig.upsert.mock.calls[0][0];
    expect(upsertArgs.update).toEqual({
      llmProvider: 'openrouter',
      welcomeMsg: 'W', model: 'deepseek/deepseek-v4.1-flash',
      lectureSystemPrompt: 'L',
    });
    expect(upsertArgs.update).not.toHaveProperty('socraticSystemPrompt');
    expect(upsertArgs.update).not.toHaveProperty('assessmentSystemPrompt');
    expect(view.model).toBe('deepseek/deepseek-v4.1-flash');
    expect(view.welcomeMsg).toBe('W');
  });

  it('saveConfig：ASSESSMENT 只写 assessmentSystemPrompt', async () => {
    mockKnowledge.getCourse.mockResolvedValue({
      id: 'c1', title: '课程', externalId: null,
      currentReleaseId: 'r1', aiTestReleaseId: null, aiTutorOnline: false,
    });
    mockPrisma.courseAiConfig.findUnique.mockResolvedValue(null);
    mockPrisma.courseAiConfig.upsert.mockResolvedValue({
      lectureSystemPrompt: null, socraticSystemPrompt: null, assessmentSystemPrompt: 'A',
      welcomeMsg: 'W', model: 'deepseek/deepseek-v4.1-flash', llmProvider: 'openrouter', apiKey: null,
    });
    mockKnowledge.getReleaseMeta.mockResolvedValue({ id: 'r1', courseId: 'c1', versionTag: 'v1' });
    await service.saveConfig({
      courseId: 'c1', mode: 'ASSESSMENT', llmProvider: 'openrouter',
      llmModel: 'deepseek/deepseek-v4.1-flash', systemPrompt: 'A', welcomeMsg: 'W',
    });
    const upsertArgs = mockPrisma.courseAiConfig.upsert.mock.calls[0][0];
    expect(upsertArgs.update).toEqual({
      llmProvider: 'openrouter',
      welcomeMsg: 'W', model: 'deepseek/deepseek-v4.1-flash',
      assessmentSystemPrompt: 'A',
    });
    expect(upsertArgs.update).not.toHaveProperty('lectureSystemPrompt');
    expect(upsertArgs.update).not.toHaveProperty('socraticSystemPrompt');
  });

  it('saveConfig：模型不在 AI_AVAILABLE_MODELS 内应 400（QA A10）', async () => {
    mockKnowledge.getCourse.mockResolvedValue({
      id: 'c1', title: '课程', externalId: null,
      currentReleaseId: 'r1', aiTestReleaseId: null, aiTutorOnline: false,
    });
    await expect(
      service.saveConfig({ courseId: 'c1', mode: 'LECTURE', llmProvider: 'openrouter', llmModel: 'anthropic/expensive' }),
    ).rejects.toThrow(BadRequestException);
    expect(mockPrisma.courseAiConfig.upsert).not.toHaveBeenCalled();
  });

  it('saveConfig：未传 apiKey 时不读旧值、不写 apiKey 列（QA A11）', async () => {
    mockKnowledge.getCourse.mockResolvedValue({
      id: 'c1', title: '课程', externalId: null,
      currentReleaseId: 'r1', aiTestReleaseId: null, aiTutorOnline: false,
    });
    mockPrisma.courseAiConfig.upsert.mockResolvedValue({ model: 'deepseek/deepseek-v4.1-flash', llmProvider: 'openrouter', apiKey: 'enc' });
    await service.saveConfig({ courseId: 'c1', mode: 'SOCRATIC', llmProvider: 'openrouter', llmModel: 'deepseek/deepseek-v4.1-flash' });
    expect(mockPrisma.courseAiConfig.findUnique).not.toHaveBeenCalled();
    const upsertArgs = mockPrisma.courseAiConfig.upsert.mock.calls[0][0];
    expect(upsertArgs.update).not.toHaveProperty('apiKey');
    expect(upsertArgs.update).not.toHaveProperty('welcomeMsg');
  });

  it('saveConfig：带 releaseId 时写入该 Release，而不是测试所选 Release（QA A5）', async () => {
    mockKnowledge.getCourse.mockResolvedValue({
      id: 'c1', title: '课程', externalId: null,
      currentReleaseId: 'r1', aiTestReleaseId: 'r2', aiTutorOnline: false,
    });
    mockKnowledge.getReleaseMeta.mockResolvedValue({ id: 'r3', courseId: 'c1', versionTag: 'v3' });
    mockPrisma.courseAiConfig.upsert.mockResolvedValue({ model: 'deepseek/deepseek-v4.1-flash', llmProvider: 'openrouter' });
    const view = await service.saveConfig({
      courseId: 'c1', releaseId: 'r3', mode: 'LECTURE', llmProvider: 'openrouter', llmModel: 'deepseek/deepseek-v4.1-flash',
    });
    expect(mockPrisma.courseAiConfig.upsert.mock.calls[0][0].where).toEqual({
      courseId_releaseId: { courseId: 'c1', releaseId: 'r3' },
    });
    expect(view.releaseId).toBe('r3');
  });

  it('saveConfig：releaseId 不属于该课程应 404（QA A5）', async () => {
    mockKnowledge.getCourse.mockResolvedValue({
      id: 'c1', title: '课程', externalId: null,
      currentReleaseId: 'r1', aiTestReleaseId: null, aiTutorOnline: false,
    });
    mockKnowledge.getReleaseMeta.mockResolvedValue({ id: 'rx', courseId: 'other', versionTag: 'vx' });
    await expect(
      service.saveConfig({ courseId: 'c1', releaseId: 'rx', mode: 'LECTURE', llmProvider: 'openrouter', llmModel: 'deepseek/deepseek-v4.1-flash' }),
    ).rejects.toThrow(NotFoundException);
    expect(mockPrisma.courseAiConfig.upsert).not.toHaveBeenCalled();
  });

  it('resetConfig：只清空该模式 System Prompt（不动共享 Welcome/Model）', async () => {
    mockKnowledge.getCourse.mockResolvedValue({
      id: 'c1', title: '课程', externalId: null,
      currentReleaseId: 'r1', aiTestReleaseId: null, aiTutorOnline: false,
    });
    mockPrisma.courseAiConfig.upsert.mockResolvedValue({
      lectureSystemPrompt: null, socraticSystemPrompt: 'keep', assessmentSystemPrompt: null,
      welcomeMsg: 'keep', model: 'm-soc', llmProvider: 'openrouter', apiKey: null,
    });
    mockKnowledge.getReleaseMeta.mockResolvedValue({ id: 'r1', courseId: 'c1', versionTag: 'v1' });
    const view = await service.resetConfig('c1', 'LECTURE');
    const upsertArgs = mockPrisma.courseAiConfig.upsert.mock.calls[0][0];
    expect(upsertArgs.update).toEqual({
      lectureSystemPrompt: null, lectureModeId: null,
    });
    expect(upsertArgs.update).not.toHaveProperty('socraticSystemPrompt');
    expect(upsertArgs.update).not.toHaveProperty('welcomeMsg');
    expect(upsertArgs.update).not.toHaveProperty('model');
    expect(view.model).toBe('m-soc');
    expect(view.welcomeMsg).toBe('keep');
  });

  it('resolvePrompts：System Prompt 按模式取，Welcome 为课程级共享', async () => {
    mockPrisma.courseAiConfig.findUnique.mockResolvedValue({
      lectureSystemPrompt: 'cust-L', socraticSystemPrompt: null, assessmentSystemPrompt: null,
      welcomeMsg: 'shared-wel',
    });
    mockPrisma.promptTemplate.findFirst.mockResolvedValue({ mode: 'SOCRATIC', systemPrompt: 'tpl-S', welcomeMsg: 'tpl-SW' });
    const lecture = await service.resolvePrompts('c1', 'r1', 'LECTURE');
    expect(lecture).toEqual({ systemPrompt: 'cust-L', welcomeMsg: 'shared-wel' });
    const socratic = await service.resolvePrompts('c1', 'r1', 'SOCRATIC');
    expect(socratic).toEqual({ systemPrompt: 'tpl-S', welcomeMsg: 'shared-wel' });
  });

  it('listPrompts：库中无默认行时按文件默认值合成（含 ASSESSMENT）', async () => {
    mockPrisma.promptTemplate.findMany.mockResolvedValue([]);
    const list = await service.listPrompts();
    expect(list.map((t) => t.id)).toEqual(['assessment-default', 'lecture-default', 'socratic-default']);
    expect(list.find((t) => t.mode === 'ASSESSMENT')?.systemPrompt).toBe(DEFAULT_PROMPTS.ASSESSMENT.systemPrompt);
  });

  it('listPrompts：忽略非法 mode 的库行', async () => {
    mockPrisma.promptTemplate.findMany.mockResolvedValue([
      { id: 'legacy', mode: 'legacy', systemPrompt: 'X', welcomeMsg: 'X', isDefault: true },
    ]);
    const list = await service.listPrompts();
    expect(list.map((t) => t.mode)).toEqual(['ASSESSMENT', 'LECTURE', 'SOCRATIC']);
  });

  it('resolvePrompts：库中无模板时回退文件默认值', async () => {
    mockPrisma.courseAiConfig.findUnique.mockResolvedValue(null);
    mockPrisma.promptTemplate.findFirst.mockResolvedValue(null);
    const view = await service.resolvePrompts('c1', 'r1', 'LECTURE');
    expect(view.systemPrompt).toBe(DEFAULT_PROMPTS.LECTURE.systemPrompt);
    expect(view.welcomeMsg).toBe(DEFAULT_PROMPTS.LECTURE.welcome['zh-CN']);
  });

  it('resolveLearnerWelcome：返回课程级统一 welcome', async () => {
    mockKnowledge.getCourseByExternalId.mockResolvedValue({ id: 'c1', title: '课程', externalId: 'portal-slug', currentReleaseId: 'r1', aiTestReleaseId: null, aiTutorOnline: true });
    mockPrisma.courseAiConfig.findUnique.mockResolvedValue({ welcomeMsg: 'shared-wel' });
    const view = await service.resolveLearnerWelcome('portal-slug');
    expect(view).toEqual({ welcome: 'shared-wel' });
  });

  it('resolveLearnerWelcome：默认按 locale 取文件欢迎语', async () => {
    mockKnowledge.getCourseByExternalId.mockResolvedValue({ id: 'c1', currentReleaseId: 'r1', aiTutorOnline: true });
    mockPrisma.courseAiConfig.findUnique.mockResolvedValue(null);
    const zh = await service.resolveLearnerWelcome('portal-slug', 'zh-CN');
    const en = await service.resolveLearnerWelcome('portal-slug', 'en-GB');
    expect(zh.welcome).not.toContain('选择课程');
    expect(en.welcome).toMatch(/AI Tutor/);
    expect(zh.welcome).not.toBe(en.welcome);
  });

  it('resolveLearnerWelcome：课程不存在 / 未开放 / 无上线版本分别 404 / 403 / 409', async () => {
    mockKnowledge.getCourseByExternalId.mockResolvedValueOnce(null);
    await expect(service.resolveLearnerWelcome('missing')).rejects.toBeInstanceOf(NotFoundException);
    mockKnowledge.getCourseByExternalId.mockResolvedValueOnce({ id: 'c1', currentReleaseId: 'r1', aiTutorOnline: false });
    await expect(service.resolveLearnerWelcome('offline')).rejects.toBeInstanceOf(ForbiddenException);
    mockKnowledge.getCourseByExternalId.mockResolvedValueOnce({ id: 'c1', currentReleaseId: null, aiTutorOnline: true });
    await expect(service.resolveLearnerWelcome('unpublished')).rejects.toBeInstanceOf(ConflictException);
  });

  it('resolveRuntime：model 为课程级共享', async () => {
    mockPrisma.courseAiConfig.findUnique.mockResolvedValue({
      llmProvider: 'openrouter', apiKey: null, model: 'm-shared',
    });
    const lecture = await service.resolveRuntime('c1', 'r1', 'LECTURE');
    expect(lecture.model).toBe('m-shared');
    const socratic = await service.resolveRuntime('c1', 'r1', 'SOCRATIC');
    expect(socratic.model).toBe('m-shared');
  });

  it('listOnlineTutorsForUser：available = online && 有上线版本', async () => {
    mockKnowledge.listCourses.mockResolvedValue([
      { id: 'c1', externalId: 'epicureanism', title: 'A', aiTutorOnline: true, currentReleaseId: 'r1' },
      { id: 'c2', externalId: 'stoicism', title: 'B', aiTutorOnline: true, currentReleaseId: null },
      { id: 'c3', externalId: 'calculus', title: 'C', aiTutorOnline: false, currentReleaseId: 'r2' },
    ] as never);
    const list = await service.listOnlineTutorsForUser();
    expect(list).toEqual([
      { externalId: 'epicureanism', courseId: 'c1', title: 'A', online: true, available: true },
      { externalId: 'stoicism', courseId: 'c2', title: 'B', online: true, available: false },
      { externalId: 'calculus', courseId: 'c3', title: 'C', online: false, available: false },
    ]);
    expect(mockKnowledge.listCourses).toHaveBeenCalledWith({ mappedOnly: true });
  });
});
