import {
  DynamicModule,
  Logger,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
  Provider,
} from '@nestjs/common';

import {
  HELPDESK_SUGGESTION_STATS,
  type HelpdeskSuggestionStats,
} from '../../contracts/helpdesk-qa';
import { closePool } from '../lib/db';
import { createHelpdeskService } from '../modules/helpdesk/helpdeskService';
import { createQuestionService } from '../modules/helpdesk/questions/questionService';
import {
  bootstrapAdminFromEnv,
  initialiseSessionSecret,
} from '../modules/user-authentication/services/bootstrap';
import { BackofficeAuthController } from './auth.controller';
import { BackofficeEmployeesController } from './employees.controller';
import {
  BackofficeHelpdeskController,
  HELPDESK_SERVICE,
} from './helpdesk.controller';
import {
  BackofficeHelpdeskQuestionsController,
  HELPDESK_QUESTION_SERVICE,
  HelpdeskIntegrationQuestionsController,
} from './helpdesk-questions.controller';

/**
 * BackOffice Portal（PRD v1.1）：员工登录、员工账号、六角色菜单权限、语言偏好；
 * HelpDesk 工单（设计文档 §4A，经 Portal 集成接口读写）；
 * Common Questions 问答库（§4A.7，本模块是唯一写入方；Portal 经集成接口读已发布的）。
 * 全局守卫 BackofficeAccessGuard 在 AppModule 注册。
 */
@Module({
  controllers: [
    BackofficeAuthController,
    BackofficeEmployeesController,
    BackofficeHelpdeskController,
    BackofficeHelpdeskQuestionsController,
    HelpdeskIntegrationQuestionsController,
  ],
  providers: [
    { provide: HELPDESK_SERVICE, useFactory: () => createHelpdeskService() },
    {
      provide: HELPDESK_QUESTION_SERVICE,
      // 推荐计数来自 Agent 的 helpdesk_suggestions，经契约注入；没注入时计数为 0
      useFactory: (stats?: HelpdeskSuggestionStats) =>
        createQuestionService({ stats }),
      inject: [{ token: HELPDESK_SUGGESTION_STATS, optional: true }],
    },
  ],
})
export class BackofficeModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(BackofficeModule.name);

  /**
   * 由 AppModule 组装：Common Questions 的推荐计数实现（HELPDESK_SUGGESTION_STATS）
   * 归 Agent，BackOffice 不 import 它（docs/Engine_Split_Implementation.md）。
   */
  static register(options: {
    helpdeskSuggestionStats?: Provider;
  }): DynamicModule {
    return {
      module: BackofficeModule,
      providers: options.helpdeskSuggestionStats
        ? [options.helpdeskSuggestionStats]
        : [],
    };
  }

  async onModuleInit(): Promise<void> {
    await initialiseSessionSecret();
    if ((await bootstrapAdminFromEnv()) === 'CREATED') {
      this.logger.log('Bootstrap admin created from BOOTSTRAP_ADMIN_EMAIL');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await closePool();
  }
}
