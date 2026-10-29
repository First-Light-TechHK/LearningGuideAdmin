import { DynamicModule, Module, Provider } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { AiChatLogger } from './ai-chat-logger';
import { AiChatService } from './ai-chat.service';
import { AiConfigService } from './ai-config.service';
import { AiController, UserAiController } from './ai.controller';
import { CryptoService } from './crypto.service';
import { OpenRouterProvider } from './providers/openrouter.provider';
import { ProviderRegistry } from './providers/provider.registry';
import { PrismaRateLimitStore, RateLimitService } from './rate-limit.service';

/**
 * AI Tutor 后端模块（§7 Phase 5）：
 * PromptTemplate/配置接口 + AI Gateway Proxy（策略模式）+ SSE 流式对话 + 限流。
 * 课程与 Release 经 KNOWLEDGE_CLIENT 读取，由组装方（AppModule）决定同进程还是走 HTTP。
 * RAG 检索经 KnowledgeClient.retrieveChunks() 由 KS 侧完成，本模块不直接访问向量数据。
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
  }): DynamicModule {
    return {
      module: AiModule,
      // 提供 EmbeddingService（PrismaKnowledgeClient 的构造依赖）
      imports: [KnowledgeModule],
      controllers: [
        ...(options.adminApi ? [AiController] : []),
        ...(options.learnerApi ? [UserAiController] : []),
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
      ],
    };
  }
}
