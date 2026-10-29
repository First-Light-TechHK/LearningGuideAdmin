import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TagsService, pickColor } from './tags.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * TagsService 单元测试（§3.3.3 方案 B 轻量版 / §5.1.6）。
 * 覆盖：
 * - findAll 透传 prisma.tag.findMany
 * - create：空 name 抛 400；已存在幂等返回；新 tag 不传 color 走 pickColor；传 color 用指定值
 * - remove：调 prisma.tag.deleteMany 并返回 success
 * - update：不存在抛 404；存在则更新 color
 * - pickColor：同名同色（确定性），结果属于色板
 */
describe('TagsService', () => {
  const mockPrisma = {
    tag: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
  };

  let service: TagsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new TagsService(mockPrisma as unknown as PrismaService);
  });

  describe('findAll', () => {
    it('应透传 prisma.tag.findMany 并按 name 排序', async () => {
      const rows = [{ id: '1', name: 'A', color: 'blue' }];
      mockPrisma.tag.findMany.mockResolvedValue(rows);
      const result = await service.findAll();
      expect(mockPrisma.tag.findMany).toHaveBeenCalledWith({
        orderBy: { name: 'asc' },
      });
      expect(result).toEqual(rows);
    });
  });

  describe('create', () => {
    it('空 name 应抛 BadRequestException', async () => {
      await expect(service.create({ name: '   ' })).rejects.toThrow(
        BadRequestException,
      );
      expect(mockPrisma.tag.create).not.toHaveBeenCalled();
    });

    it('已存在的 name 应幂等返回已有记录（不调用 create）', async () => {
      const existing = { id: '1', name: 'Core', color: 'blue' };
      mockPrisma.tag.findUnique.mockResolvedValue(existing);
      const result = await service.create({ name: 'Core' });
      expect(result).toEqual(existing);
      expect(mockPrisma.tag.create).not.toHaveBeenCalled();
    });

    it('新 tag 不传 color 时应使用 pickColor 自动分配', async () => {
      mockPrisma.tag.findUnique.mockResolvedValue(null);
      mockPrisma.tag.create.mockResolvedValue({
        id: '2',
        name: 'NewTag',
        color: 'orange',
      });
      await service.create({ name: 'NewTag' });
      expect(mockPrisma.tag.create).toHaveBeenCalledWith({
        data: { name: 'NewTag', color: pickColor('NewTag') },
      });
    });

    it('新 tag 传 color 时应使用指定颜色', async () => {
      mockPrisma.tag.findUnique.mockResolvedValue(null);
      mockPrisma.tag.create.mockResolvedValue({
        id: '3',
        name: 'Custom',
        color: 'red',
      });
      await service.create({ name: 'Custom', color: 'red' });
      expect(mockPrisma.tag.create).toHaveBeenCalledWith({
        data: { name: 'Custom', color: 'red' },
      });
    });

    it('name 前后空白应被 trim', async () => {
      mockPrisma.tag.findUnique.mockResolvedValue(null);
      mockPrisma.tag.create.mockResolvedValue({
        id: '4',
        name: 'Trimmed',
        color: 'blue',
      });
      await service.create({ name: '  Trimmed  ' });
      expect(mockPrisma.tag.findUnique).toHaveBeenCalledWith({
        where: { name: 'Trimmed' },
      });
      expect(mockPrisma.tag.create).toHaveBeenCalledWith({
        data: { name: 'Trimmed', color: expect.any(String) },
      });
    });
  });

  describe('remove', () => {
    it('应调用 prisma.tag.deleteMany 并返回 { success: true }', async () => {
      mockPrisma.tag.deleteMany.mockResolvedValue({ count: 1 });
      const result = await service.remove('Core');
      expect(mockPrisma.tag.deleteMany).toHaveBeenCalledWith({
        where: { name: 'Core' },
      });
      expect(result).toEqual({ success: true });
    });

    it('name 不存在时也返回 success（幂等删除）', async () => {
      mockPrisma.tag.deleteMany.mockResolvedValue({ count: 0 });
      const result = await service.remove('NotExist');
      expect(result).toEqual({ success: true });
    });
  });

  describe('update', () => {
    it('tag 不存在应抛 NotFoundException 且不调用 update', async () => {
      mockPrisma.tag.findUnique.mockResolvedValue(null);
      await expect(service.update('Missing', { color: 'red' })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPrisma.tag.update).not.toHaveBeenCalled();
    });

    it('tag 存在应更新 color', async () => {
      mockPrisma.tag.findUnique.mockResolvedValue({
        id: '1',
        name: 'Core',
        color: 'blue',
      });
      mockPrisma.tag.update.mockResolvedValue({
        id: '1',
        name: 'Core',
        color: 'red',
      });
      const result = await service.update('Core', { color: 'red' });
      expect(mockPrisma.tag.update).toHaveBeenCalledWith({
        where: { name: 'Core' },
        data: { color: 'red' },
      });
      expect(result).toEqual({ id: '1', name: 'Core', color: 'red' });
    });
  });

  describe('pickColor', () => {
    const PALETTE = [
      'blue',
      'green',
      'orange',
      'purple',
      'red',
      'cyan',
      'gold',
      'magenta',
    ];

    it('同名 tag 应返回相同颜色（确定性）', () => {
      expect(pickColor('Core Knowledge')).toBe(pickColor('Core Knowledge'));
      expect(pickColor('Assessment')).toBe(pickColor('Assessment'));
    });

    it('返回值必须属于预设色板', () => {
      for (const name of ['A', 'B', 'Core Knowledge', '中文标签', '123']) {
        expect(PALETTE).toContain(pickColor(name));
      }
    });

    it('不同 name 可能返回不同颜色（非全部相同）', () => {
      const colors = new Set(
        ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map(pickColor),
      );
      expect(colors.size).toBeGreaterThan(1);
    });
  });
});
