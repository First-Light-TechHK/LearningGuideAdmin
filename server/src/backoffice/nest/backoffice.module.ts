import {
  Logger,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';

import { closePool } from '../lib/db';
import { createFaqService } from '../modules/helpdesk/faqs/faqService';
import { createHelpdeskService } from '../modules/helpdesk/helpdeskService';
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
  BackofficeHelpdeskFaqsController,
  HELPDESK_FAQ_SERVICE,
  HelpdeskIntegrationFaqsController,
} from './helpdesk-faqs.controller';

/**
 * BackOffice Portal（PRD v1.1）：员工登录、员工账号、六角色菜单权限、语言偏好；
 * HelpDesk 工单（设计文档 §4A，经 Portal 集成接口读写）；
 * FAQ 库（Tickets v2 §1–§3，本模块是唯一写入方；Portal 经集成接口读已发布的，Agent 经契约
 * HelpdeskQaSource 读候选）。
 * 全局守卫 BackofficeAccessGuard 在 AppModule 注册。
 */
@Module({
  controllers: [
    BackofficeAuthController,
    BackofficeEmployeesController,
    BackofficeHelpdeskController,
    BackofficeHelpdeskFaqsController,
    HelpdeskIntegrationFaqsController,
  ],
  providers: [
    { provide: HELPDESK_SERVICE, useFactory: () => createHelpdeskService() },
    { provide: HELPDESK_FAQ_SERVICE, useFactory: () => createFaqService() },
  ],
})
export class BackofficeModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(BackofficeModule.name);

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
