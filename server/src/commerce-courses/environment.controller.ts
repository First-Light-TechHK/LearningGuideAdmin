import { Controller, Get, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  CAPABILITY_IDS,
  parseEnabledCapabilities,
} from '../common/capabilities';
import { COMMERCE_CONFIG, type CommerceCourseConfig } from './commerce.config';

/** 环境信息：两套环境同一套代码，差异只在配置（PRD §3.1）。 */
@Controller('backoffice/environment')
export class EnvironmentController {
  constructor(
    @Inject(COMMERCE_CONFIG) private readonly config: CommerceCourseConfig,
    private readonly env: ConfigService,
  ) {}

  @Get()
  get() {
    const enabled = parseEnabledCapabilities(
      this.env.get<string>('ADMIN_CAPABILITIES'),
    );
    return {
      label: this.config.environmentLabel,
      publicSiteUrl: this.config.publicSiteUrl,
      versionNumberingMode: this.config.versionNumberingMode,
      stripeConfigured: Boolean(this.config.stripeSecretKey),
      // 前端能力门（ADMIN_CAPABILITIES）：未配置时返回全部能力，行为与旧版一致；
      // 旧前端忽略该字段（字段缺失 = 全开），保持向后兼容。
      capabilities: CAPABILITY_IDS.filter((id) => enabled.has(id)),
      // 预览入口（PREVIEW_ENTRY）：learner（缺省，旧前端忽略该字段）/ portal（生产投影渲染草稿）。
      // 缺省字段兜底 learner，端点始终返回明确值。
      previewEntry: this.config.previewEntry ?? 'learner',
    };
  }
}
