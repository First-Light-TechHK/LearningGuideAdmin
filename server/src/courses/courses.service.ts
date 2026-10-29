import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCourseDto } from './dto/create-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';

/** Course CRUD（开发文档 §5.1.1） */
@Injectable()
export class CoursesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.course.findMany({ orderBy: { createdAt: 'desc' } });
  }

  /** 单个 Course，含下属 Pages（§5.1.1，按 sortOrder 升序；2026-10-16 扁平化：lessons → pages） */
  async findOne(id: string) {
    const course = await this.prisma.course.findUnique({
      where: { id },
      include: {
        pages: { orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!course) {
      throw new NotFoundException('课程不存在');
    }
    return course;
  }

  create(dto: CreateCourseDto) {
    return this.prisma.course.create({ data: dto });
  }

  async update(id: string, dto: UpdateCourseDto) {
    await this.ensureExists(id);
    return this.prisma.course.update({ where: { id }, data: dto });
  }

  /**
   * 删除 Course：级联删除 Page（schema onDelete: Cascade）。
   * 删除保护（§5.1.1）：存在 Release 历史时拒删，409 CONFLICT。
   */
  async remove(id: string) {
    await this.ensureExists(id);
    const releaseCount = await this.prisma.release.count({
      where: { courseId: id },
    });
    if (releaseCount > 0) {
      throw new ConflictException(
        '该课程已存在发布历史版本，拒绝删除；如需删除请先处理历史版本',
      );
    }
    await this.prisma.course.delete({ where: { id } });
    return { id };
  }

  private async ensureExists(id: string): Promise<void> {
    const exists = await this.prisma.course.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundException('课程不存在');
    }
  }
}
