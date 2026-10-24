import { DynamicModule, Module, Provider } from '@nestjs/common';
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
