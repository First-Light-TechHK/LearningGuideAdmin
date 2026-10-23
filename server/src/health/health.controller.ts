import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * App Runner 健康检查（DEV 栈 scripts/provision-admin-dev.mjs）。
 * 进程只有在 DATABASE_URL 校验通过、Prisma 连接建立后才会监听端口，
 * 因此这里只汇报进程已就绪，不对每个健康检查请求重复压数据库。
 */
@Controller('health')
export class HealthController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  check() {
    return {
      status: 'ok',
      service: 'learning-guide-admin',
      environment: this.config.get<string>('APP_ENV') ?? 'DEV',
    };
  }
}
