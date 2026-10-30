import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { COMMERCE_CONFIG, commerceConfig } from './commerce.config';
import { CourseStorageService } from './storage.service';
import { CommerceCoursesService } from './commerce-courses.service';
import { CommerceCoursesController } from './commerce-courses.controller';
import { PackageInspector } from './package-inspector';
import { PackageImporter } from './package-importer';
import { PackageJobsService } from './package-jobs.service';
import { PackageWorker } from './package-worker';
import { PortalProjectionService } from './portal-projection.service';
import { PortalCoursesController } from './portal-courses.controller';
import { PublishingService } from './publishing.service';
import { TrialService } from './trial.service';
import { PricingService } from './pricing.service';
import { PreviewService } from './preview.service';
import { OperationsService } from './operations.service';
import { OperationsController } from './operations.controller';
import { EnvironmentController } from './environment.controller';

/**
 * 商品课程 v2（Commerce Course）：课程管理、课程包导入/导出、Portal v1 投影。
 * P1b：Draft → Publish → Version、History、Operations、Stripe、学员预览。
 */
@Module({
  controllers: [
    CommerceCoursesController,
    PortalCoursesController,
    OperationsController,
    EnvironmentController,
  ],
  providers: [
    {
      provide: COMMERCE_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => commerceConfig(config),
    },
    CourseStorageService,
    {
      provide: PackageInspector,
      inject: [COMMERCE_CONFIG, CourseStorageService],
      useFactory: (config, storage) => new PackageInspector(config, storage),
    },
    PackageImporter,
    PublishingService,
    PricingService,
    TrialService,
    PreviewService,
    OperationsService,
    PackageJobsService,
    PackageWorker,
    CommerceCoursesService,
    PortalProjectionService,
  ],
})
export class CommerceCoursesModule {}
