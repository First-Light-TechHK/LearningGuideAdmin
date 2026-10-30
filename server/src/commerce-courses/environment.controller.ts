import { Controller, Get, Inject } from '@nestjs/common';
import { COMMERCE_CONFIG, type CommerceCourseConfig } from './commerce.config';

/** 环境信息：两套环境同一套代码，差异只在配置（PRD §3.1）。 */
@Controller('backoffice/environment')
export class EnvironmentController {
  constructor(
    @Inject(COMMERCE_CONFIG) private readonly config: CommerceCourseConfig,
  ) {}

  @Get()
  get() {
    return {
      label: this.config.environmentLabel,
      publicSiteUrl: this.config.publicSiteUrl,
      versionNumberingMode: this.config.versionNumberingMode,
      stripeConfigured: Boolean(this.config.stripeSecretKey),
    };
  }
}
