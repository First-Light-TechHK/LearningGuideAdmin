import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createAppModule } from './app.module';
import { parseAppRoles } from './app-roles';
import { configureApp } from './common/app-setup';

async function bootstrap() {
  // 同一镜像按 APP_ROLES 只起需要的部分（admin / agent / ks），不设时全部启动
  const roles = parseAppRoles(process.env.APP_ROLES);
  const app = await NestFactory.create<NestExpressApplication>(
    createAppModule(roles),
  );
  Logger.log(`启动角色：${roles.join(', ')}`, 'Bootstrap');
  // App Runner 前有一层代理：只信任最近一跳的 X-Forwarded-For，限流与审计用的 IP 不可被客户端伪造
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));
  // /api 全局前缀 + 输入校验（§5.1、§9.3），与 e2e 共用同一设置
  configureApp(app);
  // PORT 经 ConfigService 读取，缺省 3000（开发文档 §7 Phase 2 第 6 项、§8）
  const configService = app.get(ConfigService);
  const port = Number(configService.get<string>('PORT') ?? 3000);
  await app.listen(port);
}

// 启动失败（如 DATABASE_URL 缺失）时明确报错并退出进程
bootstrap().catch((err: unknown) => {
  Logger.error(
    `服务启动失败: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
