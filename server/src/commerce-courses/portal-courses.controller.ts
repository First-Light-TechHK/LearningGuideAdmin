import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { contentTypeFor } from './content-type';
import { PortalProjectionService } from './portal-projection.service';
import { PortalPreviewService } from './portal-preview.service';

/**
 * Portal 只读投影（v1 形状）。服务令牌鉴权（/api 路由在 route-access 登记为 service）。
 * Portal 现有页面消费；v2 新契约另开 /api/portal/v2（P1b/后续）。
 */
@Controller('portal/v1')
export class PortalCoursesController {
  constructor(
    private readonly projection: PortalProjectionService,
    private readonly preview: PortalPreviewService,
  ) {}

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

  /** Portal 服务端用 preview token 取草稿/指定版本数据；仍需 X-API-Key 服务鉴权。 */
  @Get('preview/course')
  async previewCourse(@Query('token') token?: string) {
    const payload = this.preview.verifyToken(token ?? '');
    const course = await this.projection.getPreviewCourse(
      payload.courseId,
      payload.versionId ?? undefined,
    );
    if (!course)
      throw new NotFoundException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });
    return course;
  }

  @Get('media/:courseId/cover')
  async cover(
    @Param('courseId') courseId: string,
    @Res() res: Response,
  ) {
    const media = await this.projection.getCoverBytes(courseId);
    if (!media)
      throw new NotFoundException({
        code: 'COURSE_MEDIA_NOT_FOUND',
        message: 'Cover not found.',
      });
    res.setHeader('Content-Type', contentTypeFor(media.extension));
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(media.bytes);
  }

  @Get('media/:courseId/assets/:assetId')
  async asset(
    @Param('courseId') courseId: string,
    @Param('assetId') assetId: string,
    @Res() res: Response,
  ) {
    const media = await this.projection.getMediaBytes(courseId, assetId);
    if (!media)
      throw new NotFoundException({
        code: 'COURSE_MEDIA_NOT_FOUND',
        message: 'Media not found.',
      });
    res.setHeader('Content-Type', contentTypeFor(media.extension));
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(media.bytes);
  }
}
