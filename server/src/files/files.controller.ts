import {
  BadRequestException,
  Controller,
  Post,
  Get,
  Param,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { FilesService, MAX_FILE_SIZE } from './files.service';
import type { Response } from 'express';

/**
 * 文档转换（§5.1.6）：multipart file → 本地转 Markdown 返回预览，不建页。
 * multer 内存存储（无 dest 即 memoryStorage），Buffer 直转不落盘（§10.2 第 4 步）。
 * 用户确认后由前端经 POST /api/courses/:courseId/pages（§5.1.2）建页。
 */
@Controller('files')
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @Post('convert')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE, files: 1 } }),
  )
  convert(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query('courseId') courseId?: string,
  ) {
    if (!file) {
      throw new BadRequestException('未选择文件（multipart 字段名须为 file）');
    }
    return this.filesService.convertFile(file, courseId);
  }

  @Post('images/:courseId')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    }),
  )
  uploadImage(
    @Param('courseId') courseId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) throw new BadRequestException('未选择图片');
    return this.filesService.storeImage(courseId, file);
  }

  @Get('images/:courseId/:assetId')
  async getImage(
    @Param('courseId') courseId: string,
    @Param('assetId') assetId: string,
    @Res() res: Response,
  ) {
    const image = await this.filesService.getImage(courseId, assetId);
    if (!image) throw new BadRequestException('图片不存在');
    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(image.bytes);
  }
}
