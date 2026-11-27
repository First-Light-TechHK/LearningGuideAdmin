import { ConflictException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { PagesService } from './pages.service';

describe('PagesService.clearCoursePages', () => {
  const tx = {
    $executeRaw: jest.fn(),
    course: { findUnique: jest.fn() },
    page: { findMany: jest.fn(), deleteMany: jest.fn() },
  };
  const prisma = {
    $transaction: (run: (client: typeof tx) => Promise<unknown>) => run(tx),
  };
  const service = new PagesService(prisma as unknown as PrismaService);

  beforeEach(() => {
    jest.resetAllMocks();
    tx.course.findUnique.mockResolvedValue({ id: 'c1' });
    tx.page.findMany.mockResolvedValue([{ id: 'markdown' }, { id: 'empty' }]);
    tx.page.deleteMany.mockResolvedValue({ count: 2 });
  });

  it('仅批量删除该课程的全部已确认页面，包括空白课时', async () => {
    await expect(
      service.clearCoursePages('c1', ['empty', 'markdown']),
    ).resolves.toEqual({ deletedPageIds: ['markdown', 'empty'] });
    expect(tx.page.findMany).toHaveBeenCalledWith({
      where: { courseId: 'c1' },
      select: { id: true },
    });
    expect(tx.page.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.page.deleteMany).toHaveBeenCalledWith({
      where: { courseId: 'c1', id: { in: ['markdown', 'empty'] } },
    });
  });

  it.each([['markdown'], ['markdown', 'other-course']])(
    '页面集合已变化时拒绝清除（已确认页面：%j）',
    async (...expected) => {
      await expect(service.clearCoursePages('c1', expected)).rejects.toThrow(
        ConflictException,
      );
      expect(tx.page.deleteMany).not.toHaveBeenCalled();
    },
  );

  it('并发删除导致实际删除数量不一致时抛出冲突以回滚事务', async () => {
    tx.page.deleteMany.mockResolvedValue({ count: 1 });
    await expect(
      service.clearCoursePages('c1', ['markdown', 'empty']),
    ).rejects.toThrow(ConflictException);
  });

  it('课程不存在时返回 404', async () => {
    tx.course.findUnique.mockResolvedValue(null);
    await expect(
      service.clearCoursePages('missing', ['markdown']),
    ).rejects.toThrow(NotFoundException);
    expect(tx.page.deleteMany).not.toHaveBeenCalled();
  });
});
