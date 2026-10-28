import {
  BadRequestException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';

/**
 * JSON 请求体上限（2026-10-27 修复，设计文档 §10.1）：
 * 上传解析的 Import 会把整份文档 Markdown 放进 `POST /courses/:courseId/pages`
 * 的 `contentMd`（JSON），body-parser 默认仅 100KB；大文档（如 500 页 PDF）
 * 会在进入控制器前被拒（413 → 曾对外误报 500）。取 25MB 覆盖 15MB 原文件的
 * Markdown 膨胀与 JSON 转义开销。
 */
export const JSON_BODY_LIMIT = '25mb';

export const INVALID_JSON_MESSAGE = '请求体不是合法的 JSON';

/**
 * 应用级公共设置（开发文档 §5.1：全部接口挂 /api 前缀；§9.3：输入校验）。
 * main.ts 与 e2e 测试共用，保证运行与测试行为一致。
 */
export function configureApp(app: INestApplication): void {
  // §5.1 所有知识库/AI 接口路径均以 /api 开头
  app.setGlobalPrefix('api');
  // §9 安全：不对外暴露服务端框架（X-Powered-By: Express）
  const adapter = (
    app as Partial<Pick<INestApplication, 'getHttpAdapter'>>
  ).getHttpAdapter?.();
  const instance: unknown = adapter?.getInstance?.();
  (
    instance as { disable?: (setting: string) => unknown } | undefined
  )?.disable?.('x-powered-by');
  // §10.1 Import 大文档：放宽 JSON 上限。必须在 app.init() 前调用，
  // 使本 parser 先于 Nest 默认（100KB）parser 注册，避免请求被默认 parser 提前拒绝。
  const bodyParserApp = app as INestApplication & {
    useBodyParser?: (type: 'json', options: { limit: string }) => unknown;
  };
  bodyParserApp.useBodyParser?.('json', { limit: JSON_BODY_LIMIT });
  // body-parser 的 JSON 语法错误默认被 Nest 转成带原文（解析位置等）的 400；
  // 紧跟在 parser 后面换成通用提示，再交给全局异常过滤器输出统一信封。
  (
    app as INestApplication & {
      use?: (handler: (...args: unknown[]) => void) => unknown;
    }
  ).use?.((error: unknown, _req: unknown, _res: unknown, next: unknown) => {
    const parseFailed =
      typeof error === 'object' &&
      error !== null &&
      (error as { type?: unknown }).type === 'entity.parse.failed';
    (next as (err: unknown) => void)(
      parseFailed ? new BadRequestException(INVALID_JSON_MESSAGE) : error,
    );
  });
  // §9.3 输入校验：DTO 白名单过滤 + 类型转换，未通过校验由全局过滤器输出 400 VALIDATION_ERROR
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );
}
