import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  COMMERCE_CONFIG,
  commerceConfig,
} from '../commerce-courses/commerce.config';
import { CourseStorageService } from '../commerce-courses/storage.service';
import { TUTOR_IMAGE_SOURCE } from '../contracts/tutor-image';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';

/** 文档转换（§3.2.3/§5.1.6）：仅转换返回预览，建页走 §5.1.3 页面创建接口 */
@Module({
  exports: [FilesService, TUTOR_IMAGE_SOURCE],
  providers: [
    FilesService,
    { provide: TUTOR_IMAGE_SOURCE, useExisting: FilesService },
    {
      provide: COMMERCE_CONFIG,
      inject: [ConfigService],
      useFactory: commerceConfig,
    },
    CourseStorageService,
  ],
})
export class FilesModule {
  static register(options: { authoring: boolean }): DynamicModule {
    return {
      module: FilesModule,
      controllers: options.authoring ? [FilesController] : [],
    };
  }
}
