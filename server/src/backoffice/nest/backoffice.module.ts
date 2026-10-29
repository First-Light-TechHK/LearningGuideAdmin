import {
  DynamicModule,
  Logger,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
  Provider,
} from '@nestjs/common';

import { closePool } from '../lib/db';
import { createPgFaqGraphRepository } from '../modules/helpdesk/faqs/faqGraphRepository';
import { createFaqGraphService } from '../modules/helpdesk/faqs/faqGraphService';
import { HELPDESK_FAQ_RELEASE_SOURCE } from '../modules/helpdesk/faqs/faqRelease';
import {
  createFaqReleaseService,
  createPgFaqReleaseSource,
} from '../modules/helpdesk/faqs/faqReleaseService';
import { createFaqService } from '../modules/helpdesk/faqs/faqService';
import { createHelpdeskService } from '../modules/helpdesk/helpdeskService';
import {
  bootstrapAdminFromEnv,
  initialiseSessionSecret,
} from '../modules/user-authentication/services/bootstrap';
import { BackofficeAuthController } from './auth.controller';
import { BackofficeEmployeesController } from './employees.controller';
import { BackofficeHelpdeskAgentRunsController } from './helpdesk-agent-runs.controller';
import {
  BackofficeHelpdeskFaqGraphController,
  HELPDESK_FAQ_GRAPH_SERVICE,
  HELPDESK_FAQ_RELEASE_SERVICE,
} from './helpdesk-faq-graph.controller';
import { HelpdeskIntegrationFaqReleaseController } from './helpdesk-faq-release.controller';
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
 * HelpdeskQaSource 读候选）；「查看链路」经契约 HelpdeskTraceSource 读 Agent 的事件日志。
 * 全局守卫 BackofficeAccessGuard 在 AppModule 注册。
 */
export type BackofficeModuleOptions = {
  /** HELPDESK_TRACE_SOURCE 的提供者（AppModule 组装：Agent 的事件日志 → 导出副本）。 */
  helpdeskTrace: Provider;
};

@Module({})
export class BackofficeModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(BackofficeModule.name);

  static register(options: BackofficeModuleOptions): DynamicModule {
    // v5 问题树：同一个仓库与发布来源（快照按版本缓存）给 FAQ、问题树、发布与 Portal 的 faq-release/current
    const graph = createPgFaqGraphRepository();
    const releaseSource = createPgFaqReleaseSource(graph);
    return {
      module: BackofficeModule,
      controllers: [
        BackofficeAuthController,
        BackofficeEmployeesController,
        BackofficeHelpdeskController,
        BackofficeHelpdeskFaqsController,
        BackofficeHelpdeskFaqGraphController,
        HelpdeskIntegrationFaqsController,
        HelpdeskIntegrationFaqReleaseController,
        BackofficeHelpdeskAgentRunsController,
      ],
      providers: [
        {
          provide: HELPDESK_SERVICE,
          useFactory: () => createHelpdeskService(),
        },
        {
          provide: HELPDESK_FAQ_SERVICE,
          // 第一版发布之后 Portal 读的 FAQ 只来自那一版快照；归档前查还在用它的父节点
          useFactory: () =>
            createFaqService({
              releaseVersion: () => releaseSource.publishedVersion(),
              liveParents: (id) => graph.liveParents(id),
            }),
        },
        {
          provide: HELPDESK_FAQ_GRAPH_SERVICE,
          useFactory: () => createFaqGraphService({ graph }),
        },
        {
          provide: HELPDESK_FAQ_RELEASE_SERVICE,
          useFactory: () => createFaqReleaseService({ graph }),
        },
        // 已发布快照：还没有任何发布版本时 current() 为 null（Portal 收到 404 no_release，照旧读逐条发布的 FAQ）
        { provide: HELPDESK_FAQ_RELEASE_SOURCE, useValue: releaseSource },
        options.helpdeskTrace,
      ],
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
