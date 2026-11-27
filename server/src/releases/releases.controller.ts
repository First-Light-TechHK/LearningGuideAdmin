import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  ParseIntPipe,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  BadRequestException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ReleasePackagesService } from './release-packages.service';
import { PACKAGE_BYTES } from './release-package';
import type { Request, Response } from 'express';
import { ReleasesService } from './releases.service';
import { CreateReleaseDto } from './dto/create-release.dto';
import { ActivateReleaseDto } from './dto/activate-release.dto';
import { TeachingCardsService } from './teaching-cards.service';

type TeachingCardRequest = Request & { employee?: { employeeId: string } };

function employeeId(request: TeachingCardRequest): string {
  if (!request.employee?.employeeId) throw new UnauthorizedException();
  return request.employee.employeeId;
}

/**
 * §5.1.4 发布与版本。
 * 路由跨 courses 与 releases 两组，故用空前缀 + 完整相对路径声明。
 */
@Controller()
export class ReleasesController {
  constructor(
    private readonly releasesService: ReleasesService,
    private readonly teachingCards: TeachingCardsService,
    private readonly packages: ReleasePackagesService,
  ) {}

  @Get('releases/:releaseId/package')
  async downloadPackage(@Param('releaseId') id: string, @Res() res: Response) {
    const { buffer, filename } = await this.packages.download(id);
    res.setHeader(
      'Content-Disposition',
      "attachment; filename*=UTF-8''" + encodeURIComponent(filename),
    );
    res.type('application/zip').send(buffer);
  }

  @Post('courses/:id/release-package/:action')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: PACKAGE_BYTES + 1, files: 1 },
    }),
  )
  async importPackage(
    @Param('id') id: string,
    @Param('action') action: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file || !['preview', 'apply'].includes(action))
      throw new BadRequestException('请选择知识版本 ZIP');
    return this.packages.import(id, file.buffer, action === 'apply');
  }

  @Get('courses/:id/teaching-cards')
  async listTeachingCards(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { stamp, entries } = await this.teachingCards.listWithStamp(id);
    res.setHeader('X-Workspace-Stamp', stamp);
    return entries;
  }

  @Get('courses/:id/teaching-cards/import/deleted-codes')
  deletedReferenceCodes(@Param('id') id: string) {
    return this.teachingCards.deletedReferenceCodes(id);
  }

  @Post('courses/:id/teaching-cards/import/references')
  importReferences(
    @Param('id') id: string,
    @Body('items') items: unknown,
    @Req() request: TeachingCardRequest,
  ) {
    return this.teachingCards.importReferences(
      id,
      items,
      false,
      employeeId(request),
    );
  }

  @Patch('courses/:id/teaching-cards/import/references')
  updateReferences(
    @Param('id') id: string,
    @Body('items') items: unknown,
    @Req() request: TeachingCardRequest,
  ) {
    return this.teachingCards.importReferences(
      id,
      items,
      true,
      employeeId(request),
    );
  }

  @Post('courses/:id/teaching-cards/deletion-preview')
  previewTeachingCardDeletion(
    @Param('id') id: string,
    @Body('items') items: unknown,
    @Headers('x-workspace-stamp') stamp?: string,
  ) {
    return this.teachingCards.deleteSelection(id, items, true, stamp);
  }

  @Delete('courses/:id/teaching-cards')
  deleteTeachingCards(
    @Param('id') id: string,
    @Body('items') items: unknown,
    @Headers('x-workspace-stamp') stamp?: string,
  ) {
    return this.teachingCards.deleteSelection(id, items, false, stamp);
  }

  @Get('courses/:id/teaching-references')
  listTeachingReferences(@Param('id') id: string) {
    return this.teachingCards.listReferences(id);
  }

  @Post('courses/:id/teaching-cards')
  createTeachingCard(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: TeachingCardRequest,
  ) {
    return this.teachingCards.save(
      id,
      undefined,
      undefined,
      body,
      employeeId(request),
      request.get('X-Workspace-Stamp'),
    );
  }

  @Patch('courses/:id/teaching-cards/:cardId')
  updateTeachingCard(
    @Param('id') id: string,
    @Param('cardId') cardId: string,
    @Body('revision', ParseIntPipe) revision: number,
    @Body('draft') draft: unknown,
    @Req() request: TeachingCardRequest,
  ) {
    return this.teachingCards.save(
      id,
      cardId,
      revision,
      draft,
      employeeId(request),
      request.get('X-Workspace-Stamp'),
    );
  }

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

  @Post('releases/:releaseId/rebuild-index')
  @HttpCode(HttpStatus.ACCEPTED)
  rebuildIndex(@Param('releaseId') releaseId: string) {
    return this.releasesService.rebuildIndex(releaseId);
  }

  /**
   * 导出 Release 快照为 ZIP（方案 B，2026-10-30 新增）。
   * VIEW 权限即可；纯读，不改动任何 Release / Course 状态。
   * ZIP 根目录每页一个文件；有图片的页面为 DOCX，其余为 MD。
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
