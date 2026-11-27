import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { PagesService } from './pages.service';
import { ClearCoursePagesDto } from './dto/clear-course-pages.dto';
import { CreatePageDto } from './dto/create-page.dto';
import { ReorderPagesDto } from './dto/reorder-pages.dto';
import { UpdatePageDto } from './dto/update-page.dto';

/**
 * §5.1.2 页面 CRUD（2026-10-16 扁平化）。
 * 路由：POST|DELETE /api/courses/:courseId/pages、PUT /api/courses/:courseId/pages/reorder、
 *       GET|PUT|DELETE /api/pages/:id
 */
@Controller()
export class PagesController {
  constructor(private readonly pagesService: PagesService) {}

  @Post('courses/:courseId/pages')
  create(@Param('courseId') courseId: string, @Body() dto: CreatePageDto) {
    return this.pagesService.create(courseId, dto);
  }

  @Delete('courses/:courseId/pages')
  clearCoursePages(
    @Param('courseId') courseId: string,
    @Body() dto: ClearCoursePagesDto,
  ) {
    return this.pagesService.clearCoursePages(courseId, dto.expectedPageIds);
  }

  /** 批量重排 Course 下 Page 顺序（§5.1.2，2026-10-19 新增，左侧树拖拽排序用） */
  @Put('courses/:courseId/pages/reorder')
  reorder(@Param('courseId') courseId: string, @Body() dto: ReorderPagesDto) {
    return this.pagesService.reorder(courseId, dto.orderedIds);
  }

  @Get('pages/:id')
  findOne(@Param('id') id: string) {
    return this.pagesService.findOne(id);
  }

  @Put('pages/:id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePageDto,
    @Headers('x-workspace-stamp') stamp?: string,
  ) {
    return this.pagesService.update(id, dto, stamp);
  }

  @Delete('pages/:id')
  remove(@Param('id') id: string) {
    return this.pagesService.remove(id);
  }
}
