import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiSuccessResponse } from '../interfaces/api-response.interface';

/**
 * 统一响应转换拦截器（开发文档 §5.3、§7 Phase 2 第 4 项）。
 * 在 AppModule 中通过 APP_INTERCEPTOR 全局注册，把所有成功响应包装为
 * { success: true, data, error: null, message: '操作成功' } 信封。
 *
 * 扩展点说明（Phase 5 实现，此处仅标注、不做实现）：
 * AI 流式对话接口 POST /api/ai/chat-stream 返回 SSE（Server-Sent Events）流，
 * 届时需在此拦截器中按响应 Content-Type（text/event-stream）或自定义元数据
 * 豁免该接口，避免把流式分块包装成 JSON 信封。
 */
@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<
  T,
  ApiSuccessResponse<T>
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiSuccessResponse<T>> {
    return next.handle().pipe(
      map((data) => ({
        success: true as const,
        data,
        error: null,
        message: '操作成功',
      })),
    );
  }
}
