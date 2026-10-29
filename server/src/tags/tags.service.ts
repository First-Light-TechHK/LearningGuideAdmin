import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';

/**
 * 全局 Tag 词库（开发文档 §3.3.3 方案 B 轻量版）。
 * - list: 供前端 TagManager AutoComplete 联想
 * - create: 用户输入新 tag 时调用；name 已存在则返回已有记录；
 *   新 tag 颜色由后端按 name 哈希自动分配（同名 tag 颜色稳定）。
 */

/** 预设色板（antd preset color names），新 tag 按 name 哈希取模分配 */
const COLOR_PALETTE = [
  'blue',
  'green',
  'orange',
  'purple',
  'red',
  'cyan',
  'gold',
  'magenta',
];

/** 对字符串做简单稳定哈希，返回非负整数 */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** 按 tag name 分配稳定颜色 */
export function pickColor(name: string): string {
  return COLOR_PALETTE[hashString(name) % COLOR_PALETTE.length];
}

@Injectable()
export class TagsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 列出全部 tag（按 name 排序） */
  async findAll() {
    return this.prisma.tag.findMany({ orderBy: { name: 'asc' } });
  }

  /**
   * 创建 tag：name 已存在则返回已有记录（幂等），
   * 否则按 name 哈希分配颜色并写入。
   */
  async create(dto: CreateTagDto) {
    const name = dto.name.trim();
    if (!name) {
      throw new BadRequestException('标签名称不能为空');
    }
    const existing = await this.prisma.tag.findUnique({ where: { name } });
    if (existing) return existing;
    return this.prisma.tag.create({
      data: { name, color: dto.color ?? pickColor(name) },
    });
  }

  /** 删除 tag（仅从词库移除；已被 sectionTags 引用的 tag 保留名称，配色回退 default） */
  async remove(name: string) {
    await this.prisma.tag.deleteMany({ where: { name } });
    return { success: true };
  }

  /** 更新 tag 颜色 */
  async update(name: string, dto: UpdateTagDto) {
    const existing = await this.prisma.tag.findUnique({ where: { name } });
    if (!existing) {
      throw new NotFoundException(`Tag "${name}" 不存在`);
    }
    return this.prisma.tag.update({
      where: { name },
      data: { color: dto.color },
    });
  }
}
