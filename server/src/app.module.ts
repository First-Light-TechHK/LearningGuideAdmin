import { Logger, Module, ModuleMetadata, Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AiModule } from './ai/ai.module';
import { HttpKnowledgeClient } from './ai/knowledge/http-knowledge.client';
import { HealthController } from './health/health.controller';
import { validateEnv } from './config/env.validation';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { BackofficeModule } from './backoffice/nest/backoffice.module';
import { CommerceCoursesModule } from './commerce-courses/commerce-courses.module';
import { BackofficeAccessGuard } from './backoffice/nest/backoffice-access.guard';
import { ALL_ROLES, type AppRole } from './app-roles';
import { KNOWLEDGE_CLIENT } from './ks/contract/knowledge-client';
import { KsModule } from './ks/ks.module';
import { PrismaKnowledgeClient } from './ks/prisma-knowledge.client';
import { HELPDESK_QA_SOURCE } from './contracts/helpdesk-qa';
import { HELPDESK_TRACE_SOURCE } from './contracts/helpdesk-trace';
import { PrismaAgentEventLog } from './ai/helpdesk/trace/agent-event.store';
import { createTraceSource } from './ai/helpdesk/trace/trace-query';
import { PrismaService } from './prisma/prisma.service';
import { createPgHelpdeskQaSource } from './backoffice/modules/helpdesk/faqs/faqRepository';

/**
 * Agent 读 KS 的方式：同进程起了 ks 角色、或没配 KS_BASE_URL 时直接读库；
 * 否则经 HTTP 调独立部署的 KS（docs/Engine_Split_Implementation.md）。
 */
function knowledgeProvider(roles: readonly AppRole[]): Provider {
  const baseUrl = process.env.KS_BASE_URL?.trim();
  if (roles.includes('ks') || !baseUrl) {
    return { provide: KNOWLEDGE_CLIENT, useClass: PrismaKnowledgeClient };
  }
  return {
    provide: KNOWLEDGE_CLIENT,
    useFactory: (config: ConfigService) => {
      new Logger('AppModule').log(`Agent 经 HTTP 读取 KS：${baseUrl}`);
      return new HttpKnowledgeClient({
        baseUrl,
        token: config.get<string>('KS_SERVICE_TOKEN')?.trim(),
        timeoutMs: Number(config.get<string>('KS_TIMEOUT_MS')) || undefined,
      });
    },
    inject: [ConfigService],
  };
}

function appModuleMetadata(roles: readonly AppRole[]): ModuleMetadata {
  const admin = roles.includes('admin');
  const agent = roles.includes('agent');
  const ks = roles.includes('ks');
  return {
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
      // Knowledge System：员工编写（admin 角色）+ 给 Agent 的内部接口（ks 角色）
      // KsModule 内部导入 KnowledgeModule，提供 RAG 索引与向量检索能力
      KsModule.register({ authoring: admin, internalApi: ks }),
      // AI Tutor：员工配置与测试（admin 角色）+ 学员对话运行时（agent 角色）
      ...(admin || agent
        ? [
            AiModule.register({
              adminApi: admin,
              learnerApi: agent,
              knowledge: knowledgeProvider(roles),
              // Helpdesk 推荐的候选：读 BackOffice 的已发布 FAQ（同库直读，契约见 src/contracts）
              helpdeskQa: {
                provide: HELPDESK_QA_SOURCE,
                useFactory: () => createPgHelpdeskQaSource(),
              },
            }),
          ]
        : []),
      // BackOffice 员工登录、账号与菜单级权限（PRD v1.1）；HelpDesk 工单与 FAQ 库
      // 「查看链路」读 Agent 的事件日志（同库直读，契约见 src/contracts/helpdesk-trace.ts）
      ...(admin
        ? [
            BackofficeModule.register({
              helpdeskTrace: {
                provide: HELPDESK_TRACE_SOURCE,
                useFactory: (prisma: PrismaService) =>
                  createTraceSource(new PrismaAgentEventLog(prisma)),
                inject: [PrismaService],
              },
            }),
          ]
        : []),
      // 商品课程 v2：课程管理 + 课程包导入导出 + Portal v1 投影（P1a）
      ...(admin ? [CommerceCoursesModule] : []),
    ],
    controllers: [AppController, HealthController],
    providers: [
      AppService,
      // 统一响应格式（§5.3、§7 Phase 2 第 4 项），SSE 流式接口豁免点见拦截器注释
      { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
      // 全局错误处理（§5.3、§7 Phase 2 第 5 项）
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
      // 员工会话 + 菜单级权限；Portal 学员端 /api/user/** 仍走 X-API-Key（ApiKeyGuard 规则），
      // KS 内部接口 /api/ks/** 走 KS_SERVICE_TOKEN；Portal Helpdesk 集成 /api/integration/helpdesk/**
      // 走 ADMIN_HELPDESK_TOKEN
      { provide: APP_GUARD, useClass: BackofficeAccessGuard },
    ],
  };
}

/** 按角色组装的根模块；main.ts 依据 APP_ROLES 调用 */
export function createAppModule(roles: readonly AppRole[]) {
  @Module(appModuleMetadata(roles))
  class RoleScopedAppModule {}
  return RoleScopedAppModule;
}

/** 三个角色全开（拆分前的行为）；e2e 与默认部署使用 */
@Module(appModuleMetadata(ALL_ROLES))
export class AppModule {}
