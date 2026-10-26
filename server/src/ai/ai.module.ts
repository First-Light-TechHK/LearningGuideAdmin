import { Module } from '@nestjs/common';
import { AiChatLogger } from './ai-chat-logger';
import { AiChatService } from './ai-chat.service';
import { AiConfigService } from './ai-config.service';
import { AiController, UserAiController } from './ai.controller';
import { CryptoService } from './crypto.service';
import { EmbeddingService } from './embedding/embedding.service';
import { OpenRouterProvider } from './providers/openrouter.provider';
import { ProviderRegistry } from './providers/provider.registry';
import { RateLimitService } from './rate-limit.service';

/**
 * AI Tutor 后端模块（§7 Phase 5）：
 * PromptTemplate/配置接口 + AI Gateway Proxy（策略模式）+ SSE 流式对话 + 限流。
 * 2026-10-26 新增 EmbeddingService（RAG 向量化），导出供 Knowledge 模块建索引使用。
 */
@Module({
  controllers: [AiController, UserAiController],
  providers: [
    OpenRouterProvider,
    ProviderRegistry,
    CryptoService,
    RateLimitService,
    AiConfigService,
    AiChatLogger,
    AiChatService,
    EmbeddingService,
  ],
  exports: [EmbeddingService],
})
export class AiModule {}
