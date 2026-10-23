import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { CoursesModule } from './courses/courses.module';
import { PagesModule } from './pages/pages.module';
import { ReleasesModule } from './releases/releases.module';
import { SyncModule } from './sync/sync.module';
import { FilesModule } from './files/files.module';
import { AiModule } from './ai/ai.module';
import { TagsModule } from './tags/tags.module';
import { HealthController } from './health/health.controller';
import { validateEnv } from './config/env.validation';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ApiKeyGuard } from './common/guards/api-key.guard';

@Module({
  imports: [
    // 环境变量配置（开发文档 §7 Phase 2 第 6 项、§8）：全局可用，启动时校验 DATABASE_URL
    // 注：envFilePath 相对进程 cwd，须从 server/ 目录启动（npm run start / start:dev / start:prod）
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnv,
    }),
    // Prisma 客户端单例（§7 Phase 2 第 3 项）
    PrismaModule,
    // Knowledge System 后端模块（§7 Phase 3、§5.1）
    CoursesModule,
    PagesModule,
    ReleasesModule,
    SyncModule,
    // 文件上传转 Markdown（§3.2.3/§5.1.6/§10）
    FilesModule,
    // AI Tutor 后端模块（§7 Phase 5、§5.2）
    AiModule,
    // 全局 Tag 词库（§3.3.3 方案 B、§5.1.6）
    TagsModule,
  ],
  controllers: [AppController, HealthController],
  providers: [
    AppService,
    // 统一响应格式（§5.3、§7 Phase 2 第 4 项），SSE 流式接口豁免点见拦截器注释
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    // 全局错误处理（§5.3、§7 Phase 2 第 5 项）
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // 接口鉴权骨架（§7 Phase 3 第 6 项注记：AUTH_ENABLED 默认 false，不拦截）
    { provide: APP_GUARD, useClass: ApiKeyGuard },
  ],
})
export class AppModule {}
