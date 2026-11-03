import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  COMMERCE_CONFIG,
  commerceConfig,
} from '../commerce-courses/commerce.config';
import { CourseStorageService } from '../commerce-courses/storage.service';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';

/** 文档转换（§3.2.3/§5.1.6）：仅转换返回预览，建页走 §5.1.3 页面创建接口 */
@Module({
  controllers: [FilesController],
  providers: [
    FilesService,
    {
      provide: COMMERCE_CONFIG,
      inject: [ConfigService],
      useFactory: commerceConfig,
    },
    CourseStorageService,
  ],
})
export class FilesModule {}
