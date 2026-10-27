import { ConflictException, NotFoundException } from '@nestjs/common';
import { ReleasesService } from './releases.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * ReleasesService 单元测试（2026-10-16 扁平化：lessons → pages）。
 * 快照结构、versionTag 格式、**纯快照（不改 Live 指针）**、切换激活版本（重建 Page 草稿）、
 * isActive/isTestSelected 标注与删除版本（双保护）。
 */
describe('ReleasesService', () => {
  const mockTx = {
    $executeRaw: jest.fn(),
    course: { findUnique: jest.fn(), update: jest.fn() },
    courseAiConfig: { findUnique: jest.fn(), create: jest.fn() },
    release: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      delete: jest.fn(),
    },
    page: { deleteMany: jest.fn(), create: jest.fn() },
  };
  const mockPrisma = {
    course: { findUnique: jest.fn() },
    release: { findMany: jest.fn(), findUnique: jest.fn() },
    $transaction: jest.fn((fn: (tx: typeof mockTx) => Promise<unknown>) =>
      fn(mockTx),
    ),
  };

  let service: ReleasesService;
  let mockIndexing: { indexRelease: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    mockIndexing = {
      indexRelease: jest.fn().mockResolvedValue(undefined),
    };
    service = new ReleasesService(
      mockPrisma as unknown as PrismaService,
      mockIndexing as never,
    );
  });

  it('publish：快照应含 pages 内容，versionTag 匹配 CourseName_YYYYMMDDHHmm，纯快照不改 Live 指针，且置 editingReleaseId（§3.4.3）', async () => {
    mockTx.course.findUnique.mockResolvedValue({
      id: 'c1',
      title: '数学基础',
      pages: [
        { id: 'p1', title: '第一章', contentMd: '# hi', sectionTags: null },
      ],
    });
    mockTx.release.create.mockImplementation(({ data }: { data: unknown }) =>
      Promise.resolve({ id: 'r1', ...(data as object) }),
    );

    const result = (await service.publish('c1', {
      revisionNotes: '首发',
    })) as { versionTag: string; snapshotData: unknown; revisionNotes: string };

    expect(result.versionTag).toMatch(/^数学基础_\d{12}$/);
    expect(result.snapshotData).toEqual({
      pages: [
        { id: 'p1', title: '第一章', contentMd: '# hi', sectionTags: null },
      ],
    });
    expect(result.revisionNotes).toBe('首发');
    // 纯快照：不改动 currentReleaseId；但置当前编辑版本指针 = 新 Release（2026-10-20 三次改拍）；
    // 课程尚无测试 / Live 版本时，首个 Release 同时成为测试所选版本（QA A6）
    expect(mockTx.course.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { editingReleaseId: 'r1', aiTestReleaseId: 'r1' },
    });
    expect(mockTx.courseAiConfig.create).not.toHaveBeenCalled();
    // 快照仅收录 SYNCED 节点：事务内查询条件应带 syncState 过滤
    const courseQuery = mockTx.course.findUnique.mock
      .calls[0][0] as Record<string, never>;
    expect(JSON.stringify(courseQuery)).toContain('SYNCED');
  });

  it('publish：沿用 Live 版本的 AI 配置，且不改动已有测试所选版本（QA A3/A6）', async () => {
    mockTx.course.findUnique.mockResolvedValue({
      id: 'c1',
      title: '数学基础',
      currentReleaseId: 'live',
      aiTestReleaseId: 'test',
      pages: [],
    });
    mockTx.release.create.mockResolvedValue({ id: 'r9' });
    const source = { lectureSystemPrompt: 'L', welcomeMsg: 'W', model: 'm', llmProvider: 'openrouter' };
    mockTx.courseAiConfig.findUnique.mockResolvedValue(source);

    await service.publish('c1', { revisionNotes: 'v2' });

    expect(mockTx.courseAiConfig.findUnique.mock.calls[0][0].where).toEqual({
      courseId_releaseId: { courseId: 'c1', releaseId: 'live' },
    });
    expect(mockTx.courseAiConfig.create).toHaveBeenCalledWith({
      data: { ...source, courseId: 'c1', releaseId: 'r9' },
    });
    expect(mockTx.course.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { editingReleaseId: 'r9' },
    });
  });

  it('setLive / remove：校验前先锁 Course 行（QA A7）', async () => {
    mockTx.course.findUnique.mockResolvedValue({ id: 'c1', currentReleaseId: null, aiTestReleaseId: null });
    mockTx.release.findUnique.mockResolvedValue({ id: 'r1', courseId: 'c1', versionTag: 'v1' });
    await service.setLive('c1', { releaseId: 'r1' });
    expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
    await service.remove('r1');
    expect(mockTx.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('publish：短时间内同说明、同快照的重复提交返回刚发布的版本（幂等）', async () => {
    mockTx.course.findUnique.mockResolvedValue({
      id: 'c1',
      title: 'Course',
      currentReleaseId: 'r1',
      aiTestReleaseId: 'r1',
      pages: [{ id: 'p1', title: 'L1', contentMd: 'x', sectionTags: [] }],
    });
    // jsonb 读回后的键顺序与写入时不同
    const previous = {
      id: 'r2',
      courseId: 'c1',
      revisionNotes: 'v2',
      createdAt: new Date(),
      snapshotData: {
        pages: [{ sectionTags: [], contentMd: 'x', title: 'L1', id: 'p1' }],
      },
    };
    mockTx.release.findFirst.mockResolvedValue(previous);

    const result = await service.publish('c1', { revisionNotes: 'v2' });

    expect(result).toBe(previous);
    expect(mockTx.$executeRaw).toHaveBeenCalled();
    expect(mockTx.release.create).not.toHaveBeenCalled();
    expect(mockTx.course.update).not.toHaveBeenCalled();
    expect(mockIndexing.indexRelease).not.toHaveBeenCalled();

    mockTx.release.findFirst.mockResolvedValue({
      ...previous,
      revisionNotes: 'other',
    });
    mockTx.release.create.mockResolvedValue({ id: 'r3' });
    await service.publish('c1', { revisionNotes: 'v2' });
    expect(mockTx.release.create).toHaveBeenCalledTimes(1);
  });

  it('publish：课程不存在时 404', async () => {
    mockTx.course.findUnique.mockResolvedValue(null);
    await expect(
      service.publish('missing', { revisionNotes: 'x' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('findAllByCourse：列表不含 snapshotData，且标注 isActive / isTestSelected / isEditing', async () => {
    mockPrisma.course.findUnique.mockResolvedValue({
      id: 'c1',
      currentReleaseId: 'r1',
      aiTestReleaseId: 'r2',
      editingReleaseId: 'r2',
    });
    mockPrisma.release.findMany.mockResolvedValue([
      { id: 'r1', versionTag: 'v1', revisionNotes: 'a', createdAt: 't1' },
      { id: 'r2', versionTag: 'v2', revisionNotes: 'b', createdAt: 't2' },
    ]);
    const list = await service.findAllByCourse('c1');
    expect(list.map((r) => r.isActive)).toEqual([true, false]);
    expect(list.map((r) => r.isTestSelected)).toEqual([false, true]);
    expect(list.map((r) => r.isEditing)).toEqual([false, true]);
    const select = mockPrisma.release.findMany.mock.calls[0][0] as {
      select: { snapshotData?: unknown };
    };
    expect(select.select.snapshotData).toBeUndefined();
  });

  it('remove：Live 版本拒绝删除 409（§3.4.5 双保护）', async () => {
    mockTx.release.findUnique.mockResolvedValue({
      id: 'r1',
      courseId: 'c1',
      versionTag: 'v1',
    });
    mockTx.course.findUnique.mockResolvedValue({
      currentReleaseId: 'r1',
      aiTestReleaseId: null,
    });
    await expect(service.remove('r1')).rejects.toThrow(ConflictException);
    expect(mockTx.release.delete).not.toHaveBeenCalled();
  });

  it('remove：后台测试所选版本拒绝删除 409（§3.4.5 双保护）', async () => {
    mockTx.release.findUnique.mockResolvedValue({
      id: 'r2',
      courseId: 'c1',
      versionTag: 'v2',
    });
    mockTx.course.findUnique.mockResolvedValue({
      currentReleaseId: 'r1',
      aiTestReleaseId: 'r2',
    });
    await expect(service.remove('r2')).rejects.toThrow(ConflictException);
    expect(mockTx.release.delete).not.toHaveBeenCalled();
  });

  it('remove：普通版本正常删除', async () => {
    mockTx.release.findUnique.mockResolvedValue({
      id: 'r3',
      courseId: 'c1',
      versionTag: 'v3',
    });
    mockTx.course.findUnique.mockResolvedValue({
      currentReleaseId: 'r1',
      aiTestReleaseId: 'r2',
    });
    const result = await service.remove('r3');
    expect(result).toEqual({ id: 'r3', versionTag: 'v3' });
    expect(mockTx.release.delete).toHaveBeenCalledWith({ where: { id: 'r3' } });
    // 非 editing 版本：不清空指针
    expect(mockTx.course.update).not.toHaveBeenCalled();
  });

  it('remove：删除当前编辑版本时清空 editingReleaseId 指针（§3.4.5 三次改拍）', async () => {
    mockTx.release.findUnique.mockResolvedValue({
      id: 'r3',
      courseId: 'c1',
      versionTag: 'v3',
    });
    mockTx.course.findUnique.mockResolvedValue({
      currentReleaseId: 'r1',
      aiTestReleaseId: 'r2',
      editingReleaseId: 'r3',
    });
    const result = await service.remove('r3');
    expect(result).toEqual({ id: 'r3', versionTag: 'v3' });
    expect(mockTx.course.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { editingReleaseId: null },
    });
  });

  it('remove：版本不存在 404', async () => {
    mockTx.release.findUnique.mockResolvedValue(null);
    await expect(service.remove('missing')).rejects.toThrow(NotFoundException);
  });

  it('activate：事务内重建 Page 草稿并置 editingReleaseId，不改动 currentReleaseId（§3.4.2 二次/三次改拍）', async () => {
    mockPrisma.course.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.release.findUnique.mockResolvedValue({
      id: 'r2',
      courseId: 'c1',
      versionTag: '数学基础_202610150000',
      snapshotData: {
        pages: [
          { id: 'p1', title: '第一章', contentMd: '# old', sectionTags: null },
          { id: 'p2', title: '第二章', contentMd: '# keep', sectionTags: { 'h1-sec': ['tag'] } },
        ],
      },
    });

    const result = await service.activate('c1', { releaseId: 'r2' });

    expect(result).toEqual({
      id: 'r2',
      versionTag: '数学基础_202610150000',
    });
    // 删除当前所有 Page
    expect(mockTx.page.deleteMany).toHaveBeenCalledWith({
      where: { courseId: 'c1' },
    });
    // 快照节点重建：2 pages，sortOrder 按快照顺序
    expect(mockTx.page.create).toHaveBeenCalledTimes(2);
    expect(mockTx.page.create.mock.calls[1][0].data).toMatchObject({
      title: '第二章',
      contentMd: '# keep',
      sortOrder: 1,
    });
    // 仅恢复草稿并置当前编辑版本指针 = 该 Release；不改动 currentReleaseId（Live 只由 Set Live 变更）
    expect(mockTx.course.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { editingReleaseId: 'r2' },
    });
  });

  it('activate：releaseId 不属于该课程时 404，且不触碰事务', async () => {
    mockPrisma.course.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.release.findUnique.mockResolvedValue({
      id: 'r9',
      courseId: 'other',
    });
    await expect(
      service.activate('c1', { releaseId: 'r9' }),
    ).rejects.toThrow(NotFoundException);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});
