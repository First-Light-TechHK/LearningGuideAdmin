import {
  Logger,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';

import { closePool } from '../lib/db';
import {
  bootstrapAdminFromEnv,
  initialiseSessionSecret,
} from '../modules/user-authentication/services/bootstrap';
import { BackofficeAuthController } from './auth.controller';
import { BackofficeEmployeesController } from './employees.controller';

/**
 * BackOffice Portal（PRD v1.1）：员工登录、员工账号、六角色菜单权限、语言偏好。
 * 全局守卫 BackofficeAccessGuard 在 AppModule 注册。
 */
@Module({
  controllers: [BackofficeAuthController, BackofficeEmployeesController],
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
