import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { PortalProjectionService } from './portal-projection.service';

/**
 * Portal 只读投影（v1 形状）。服务令牌鉴权（/api 路由在 route-access 登记为 service）。
 * Portal 现有页面消费；v2 新契约另开 /api/portal/v2（P1b/后续）。
 */
@Controller('portal/v1')
export class PortalCoursesController {
  constructor(private readonly projection: PortalProjectionService) {}

  @Get('courses')
  list(@Query('limit') limit?: string) {
    return this.projection.listCourses(limit ? Number(limit) : undefined);
  }

  @Get('courses/:id')
  async detail(@Param('id') id: string) {
    const course = await this.projection.getCourseById(id);
    if (!course)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });
    return course;
  }
}
