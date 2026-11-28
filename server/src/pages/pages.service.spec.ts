import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { PagesService } from './pages.service';

describe('PagesService.create', () => {
  const requestId = '07983c97-0d51-4022-a973-ef2dd1a0492c';
  const dto = { title: 'Lesson', contentMd: 'Markdown', requestId };
  const existing = { ...dto, id: requestId, courseId: 'c1', sortOrder: 0 };
  const duplicate = new Prisma.PrismaClientKnownRequestError('duplicate', {
    code: 'P2002',
    clientVersion: 'test',
  });

  it('returns the same page on a replay after the first response was lost', async () => {
    const page = {
      count: jest.fn().mockResolvedValue(0),
      create: jest
        .fn()
        .mockResolvedValueOnce(existing)
        .mockRejectedValueOnce(duplicate),
      findUnique: jest.fn().mockResolvedValue(existing),
    };
    const service = new PagesService({
      course: { findUnique: jest.fn().mockResolvedValue({ id: 'c1' }) },
      page,
    } as unknown as PrismaService);
    await expect(service.create('c1', dto)).resolves.toEqual(existing);
    await expect(service.create('c1', dto)).resolves.toEqual(existing);
    expect(page.create).toHaveBeenNthCalledWith(2, {
      data: {
        id: requestId,
        courseId: 'c1',
        title: dto.title,
        contentMd: dto.contentMd,
        sectionTags: undefined,
        sortOrder: 0,
      },
    });
    expect(page.findUnique).toHaveBeenCalledWith({ where: { id: requestId } });
  });

  it('rejects a key previously used with different page content', async () => {
    const service = new PagesService({
      course: { findUnique: jest.fn().mockResolvedValue({ id: 'c1' }) },
      page: {
        count: jest.fn().mockResolvedValue(1),
        create: jest.fn().mockRejectedValue(duplicate),
        findUnique: jest.fn().mockResolvedValue(existing),
      },
    } as unknown as PrismaService);
    await expect(
      service.create('c1', { ...dto, contentMd: 'Different' }),
    ).rejects.toThrow(ConflictException);
  });
});

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
