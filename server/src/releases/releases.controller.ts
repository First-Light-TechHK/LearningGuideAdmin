import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ReleasesService } from './releases.service';
import { CreateReleaseDto } from './dto/create-release.dto';
import { ActivateReleaseDto } from './dto/activate-release.dto';

/**
 * §5.1.4 发布与版本。
 * 路由跨 courses 与 releases 两组，故用空前缀 + 完整相对路径声明。
 */
@Controller()
export class ReleasesController {
  constructor(private readonly releasesService: ReleasesService) {}

  @Post('courses/:id/release')
  publish(@Param('id') id: string, @Body() dto: CreateReleaseDto) {
    return this.releasesService.publish(id, dto);
  }

  @Post('courses/:id/activate-release')
  activate(@Param('id') id: string, @Body() dto: ActivateReleaseDto) {
    return this.releasesService.activate(id, dto);
  }

  /** Set Live（§3.4.4，2026-10-20 新增）：轻量切换上线指针，不重建草稿 */
  @Post('courses/:id/set-live')
  setLive(@Param('id') id: string, @Body() dto: ActivateReleaseDto) {
    return this.releasesService.setLive(id, dto);
  }

  @Get('courses/:id/releases')
  findAllByCourse(@Param('id') id: string) {
    return this.releasesService.findAllByCourse(id);
  }

  @Get('releases/:releaseId')
  findOne(@Param('releaseId') releaseId: string) {
    return this.releasesService.findByReleaseId(releaseId);
  }

  /**
   * 导出 Release 快照为 ZIP（方案 B，2026-10-30 新增）。
   * VIEW 权限即可；纯读，不改动任何 Release / Course 状态。
   * ZIP 内含 manifest.json + pages/{NNN}_{title}.md（每页一个文件）。
   */
  @Get('releases/:releaseId/export')
  @Header('Content-Type', 'application/zip')
  async exportZip(@Param('releaseId') releaseId: string, @Res() res: Response) {
    const { buffer, filename } =
      await this.releasesService.exportZip(releaseId);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  }

  /** 删除版本（§3.4.5，2026-10-20 新增）：Live / 后台测试所选版本返回 409 */
  @Delete('releases/:releaseId')
  remove(@Param('releaseId') releaseId: string) {
    return this.releasesService.remove(releaseId);
  }
}
