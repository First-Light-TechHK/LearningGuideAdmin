import { DynamicModule, Module, Provider } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { AiChatLogger } from './ai-chat-logger';
import { AiChatService } from './ai-chat.service';
import { AiConfigService } from './ai-config.service';
import { AiController, UserAiController } from './ai.controller';
import { CryptoService } from './crypto.service';
import { HELPDESK_QA_SOURCE } from '../contracts/helpdesk-qa';
import { HelpdeskSuggestController } from './helpdesk/helpdesk-suggest.controller';
import { HelpdeskSuggestService } from './helpdesk/helpdesk-suggest.service';
import { PrismaHelpdeskSuggestionStore } from './helpdesk/helpdesk-suggestion.store';
import { OpenRouterProvider } from './providers/openrouter.provider';
import { ProviderRegistry } from './providers/provider.registry';
import { PrismaRateLimitStore, RateLimitService } from './rate-limit.service';

/**
 * AI Tutor 后端模块（§7 Phase 5）：
 * PromptTemplate/配置接口 + AI Gateway Proxy（策略模式）+ SSE 流式对话 + 限流。
 * 课程与 Release 经 KNOWLEDGE_CLIENT 读取，由组装方（AppModule）决定同进程还是走 HTTP。
 * RAG 检索经 KnowledgeClient.retrieveChunks() 由 KS 侧完成，本模块不直接访问向量数据。
 * Helpdesk 推荐（agent 角色，2026-10-28）：候选经契约 HELPDESK_QA_SOURCE 读 BackOffice 的已发布问答，
 * 模型走 ProviderRegistry（OpenRouter），限流共用 ai_rate_limit_hits，日志写 helpdesk_suggestions。
 *
 * 2026-10-26 修复：同进程模式下 `KNOWLEDGE_CLIENT` 用 `useClass: PrismaKnowledgeClient` 注册在
 * 本模块上下文，而 `PrismaKnowledgeClient` 依赖 `EmbeddingService`；`EmbeddingService` 由
 * `KnowledgeModule` 提供并导出，因此这里必须导入 `KnowledgeModule`，否则启动即报
 * `Nest can't resolve dependencies of the PrismaKnowledgeClient (PrismaService, ?)`。
 */
@Module({})
export class AiModule {
  static register(options: {
    /** 员工侧：配置接口与后台测试对话（/api/ai/**） */
    adminApi: boolean;
    /** 学员侧：Portal 与学习小组调用的对话（/api/user/**） */
    learnerApi: boolean;
    /** KNOWLEDGE_CLIENT 的提供方 */
    knowledge: Provider;
    /**
     * Helpdesk 推荐（Figma addendum §C，agent 角色）：已发布问答的候选来源
     * （HELPDESK_QA_SOURCE，实现归 BackOffice，由 AppModule 组装）。不给则不挂推荐接口。
     */
    helpdeskQa?: Provider;
  }): DynamicModule {
    const helpdesk = options.learnerApi && options.helpdeskQa !== undefined;
    return {
      module: AiModule,
      // 提供 EmbeddingService（PrismaKnowledgeClient 的构造依赖）
      imports: [KnowledgeModule],
      controllers: [
        ...(options.adminApi ? [AiController] : []),
        ...(options.learnerApi ? [UserAiController] : []),
        ...(helpdesk ? [HelpdeskSuggestController] : []),
      ],
      providers: [
        OpenRouterProvider,
        ProviderRegistry,
        CryptoService,
        PrismaRateLimitStore,
        {
          provide: RateLimitService,
          useFactory: (store: PrismaRateLimitStore) =>
            new RateLimitService(store),
          inject: [PrismaRateLimitStore],
        },
        AiConfigService,
        AiChatLogger,
        AiChatService,
        options.knowledge,
        ...(helpdesk && options.helpdeskQa
          ? [
              options.helpdeskQa,
              PrismaHelpdeskSuggestionStore,
              {
                provide: HelpdeskSuggestService,
                useFactory: (
                  qa: ConstructorParameters<
                    typeof HelpdeskSuggestService
                  >[0]['qa'],
                  providers: ProviderRegistry,
                  rateLimit: PrismaRateLimitStore,
                  log: PrismaHelpdeskSuggestionStore,
                ) =>
                  new HelpdeskSuggestService({ qa, providers, rateLimit, log }),
                inject: [
                  HELPDESK_QA_SOURCE,
                  ProviderRegistry,
                  PrismaRateLimitStore,
                  PrismaHelpdeskSuggestionStore,
                ],
              },
            ]
          : []),
      ],
    };
  }
}
