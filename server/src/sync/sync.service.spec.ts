import { NotFoundException } from '@nestjs/common';
import { SyncService } from './sync.service';
import { CatalogueSourceService } from './catalogue-source.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * SyncService 单元测试（2026-10-26 改数据源后）。
 * 覆盖：映射表课程 + 本地独有课程的合并列表、按 courseID 建课、映射表外课程不报错。
 */
describe('SyncService — 课程 ID 映射表同步（2026-10-26）', () => {
  const mockPrisma = {
    course: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    page: {
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  let service: SyncService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.page.findMany.mockResolvedValue([]);
    mockPrisma.course.update.mockResolvedValue({});
    mockPrisma.page.create.mockResolvedValue({});
    mockPrisma.page.update.mockResolvedValue({});
    // 事务直接以同一 mock 作为 tx 执行回调
    mockPrisma.$transaction.mockImplementation(
      (cb: (tx: typeof mockPrisma) => unknown) => cb(mockPrisma),
    );
    service = new SyncService(
      mockPrisma as unknown as PrismaService,
      new CatalogueSourceService(),
    );
  });

  it('listExternalCourses：映射表 4 门课 + 本地独有课程一起返回', async () => {
    mockPrisma.course.findMany.mockResolvedValue([
      { id: 'c1', title: 'Epicureanism', externalId: 'epicureanism' },
      {
        id: 'c9',
        title: 'Population Growth',
        externalId: 'ext-population-001',
      },
    ]);

    const list = await service.listExternalCourses();

    const byId = new Map(list.map((item) => [item.externalId, item]));
    // 映射表课程：本地已存在的 epicureanism 为 synced，未导入的为 not_synced
    expect(byId.get('epicureanism')).toEqual(
      expect.objectContaining({ localCourseId: 'c1', status: 'synced' }),
    );
    expect(byId.get('modeling-life')).toEqual(
      expect.objectContaining({ localCourseId: null, status: 'not_synced' }),
    );
    // 本地独有课程不被隐藏
    expect(byId.get('ext-population-001')).toEqual(
      expect.objectContaining({ localCourseId: 'c9', status: 'synced' }),
    );
    expect(list).toHaveLength(5);
  });

  it('sync：映射表课程本地不存在时按 courseID + 标题建课，且报告课程新建', async () => {
    mockPrisma.course.findFirst.mockResolvedValue(null);
    mockPrisma.course.create.mockResolvedValue({ id: 'new-course' });

    const summary = await service.sync('modeling-life', 'structure');

    expect(mockPrisma.course.create).toHaveBeenCalledWith({
      data: { title: 'Modeling life', externalId: 'modeling-life' },
      select: { id: true },
    });
    // 首次导入必须让前端感知到「有变更」，否则会误提示「无变更」
    expect(summary).toEqual({
      created: 0,
      courseCreated: 1,
      updated: 0,
      staleMarked: 0,
      unchanged: false,
    });
  });

  it('sync：映射表课程已存在且标题一致时不更新', async () => {
    mockPrisma.course.findFirst.mockResolvedValue({
      id: 'c1',
      title: 'Epicureanism',
    });

    const summary = await service.sync('epicureanism', 'structure');

    expect(mockPrisma.course.update).not.toHaveBeenCalled();
    expect(summary.unchanged).toBe(true);
  });

  it('sync：映射表外但本地存在的课程返回无变更（不建课、不报错）', async () => {
    mockPrisma.course.findFirst.mockResolvedValue({ id: 'c9' });

    const summary = await service.sync('ext-population-001', 'structure');

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(summary).toEqual({
      created: 0,
      courseCreated: 0,
      updated: 0,
      staleMarked: 0,
      unchanged: true,
    });
  });

  it('sync：映射表与本地都没有该课程时 404', async () => {
    mockPrisma.course.findFirst.mockResolvedValue(null);

    await expect(service.sync('not-exist', 'structure')).rejects.toThrow(
      NotFoundException,
    );
  });
});
