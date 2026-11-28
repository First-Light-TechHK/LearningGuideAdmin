import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { lockCourseRow } from '../prisma/course-lock';
import { CreatePageDto } from './dto/create-page.dto';
import { UpdatePageDto } from './dto/update-page.dto';

/** Page CRUD（开发文档 §5.1.2） */
@Injectable()
export class PagesService {
  constructor(private readonly prisma: PrismaService) {}

  /** 在指定 Course 下创建 Page；courseId 不存在时 404（2026-10-16 扁平化：原 lessonId → courseId） */
  async create(courseId: string, dto: CreatePageDto) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { id: true },
    });
    if (!course) {
      throw new NotFoundException('所属课程不存在');
    }
    const sortOrder =
      dto.sortOrder ?? (await this.prisma.page.count({ where: { courseId } }));
    try {
      return await this.prisma.page.create({
        data: {
          ...(dto.requestId && { id: dto.requestId }),
          courseId,
          title: dto.title,
          contentMd: dto.contentMd,
          sectionTags: dto.sectionTags,
          sortOrder,
        },
      });
    } catch (error) {
      if (
        !dto.requestId ||
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== 'P2002'
      )
        throw error;
      const page = await this.prisma.page.findUnique({
        where: { id: dto.requestId },
      });
      if (
        !page ||
        page.courseId !== courseId ||
        page.title !== dto.title ||
        page.contentMd !== dto.contentMd
      )
        throw new ConflictException('页面创建请求已被使用');
      return page;
    }
  }

  /** 单个 Page，含 contentMd、sectionTags（§5.1.2） */
  async findOne(id: string) {
    const page = await this.prisma.page.findUnique({ where: { id } });
    if (!page) {
      throw new NotFoundException('页面不存在');
    }
    return page;
  }

  async update(id: string, dto: UpdatePageDto, stamp?: string) {
    if (stamp !== undefined) {
      return this.prisma.$transaction(async (tx) => {
        const page = await tx.page.findUniqueOrThrow({
          where: { id },
          select: { courseId: true },
        });
        await lockCourseRow(tx, page.courseId);
        const course = await tx.course.findUniqueOrThrow({
          where: { id: page.courseId },
          select: { updatedAt: true },
        });
        if (course.updatedAt.toISOString() !== stamp)
          throw new ConflictException('工作区版本已变化，请重新加载后编辑');
        return tx.page.update({ where: { id }, data: dto });
      });
    }
    await this.ensureExists(id);
    return this.prisma.page.update({ where: { id }, data: dto });
  }

  /**
   * 批量重排 Course 下 Page 顺序（§5.1.2，2026-10-19 新增）。
   * orderedIds 必须为该 Course 全部 Page id 的无重复完整排列，否则 400。
   * 事务内按数组下标重写 sortOrder，保证一次拖拽原子生效。
   */
  async reorder(courseId: string, orderedIds: string[]) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { id: true },
    });
    if (!course) {
      throw new NotFoundException('所属课程不存在');
    }
    const pages = await this.prisma.page.findMany({
      where: { courseId },
      select: { id: true },
    });
    const existing = new Set(pages.map((p) => p.id));
    const isCompletePermutation =
      orderedIds.length === existing.size &&
      new Set(orderedIds).size === orderedIds.length &&
      orderedIds.every((id) => existing.has(id));
    if (!isCompletePermutation) {
      throw new BadRequestException('排序列表必须为该课程全部页面的完整排列');
    }
    await this.prisma.$transaction(
      orderedIds.map((id, index) =>
        this.prisma.page.update({ where: { id }, data: { sortOrder: index } }),
      ),
    );
    return { orderedIds };
  }

  async remove(id: string) {
    await this.ensureExists(id);
    await this.prisma.page.delete({ where: { id } });
    return { id };
  }

  async clearCoursePages(courseId: string, expectedPageIds: string[]) {
    return this.prisma.$transaction(async (tx) => {
      await lockCourseRow(tx, courseId);
      const course = await tx.course.findUnique({
        where: { id: courseId },
        select: { id: true },
      });
      if (!course) throw new NotFoundException('所属课程不存在');

      const pages = await tx.page.findMany({
        where: { courseId },
        select: { id: true },
      });
      const expected = new Set(expectedPageIds);
      const conflictMessage = '课程页面已变化，请重新确认后再清除';
      if (
        pages.length !== expected.size ||
        pages.some(({ id }) => !expected.has(id))
      ) {
        throw new ConflictException(conflictMessage);
      }

      const deletedPageIds = pages.map(({ id }) => id);
      const { count } = await tx.page.deleteMany({
        where: { courseId, id: { in: deletedPageIds } },
      });
      if (count !== deletedPageIds.length) {
        throw new ConflictException(conflictMessage);
      }
      return { deletedPageIds };
    });
  }

  private async ensureExists(id: string): Promise<void> {
    const exists = await this.prisma.page.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundException('页面不存在');
    }
  }
}
