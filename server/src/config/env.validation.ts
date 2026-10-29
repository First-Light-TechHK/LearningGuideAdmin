/**
 * 环境变量启动校验（开发文档 §7 Phase 2 第 6 项、§8）。
 * 由 ConfigModule.forRoot 的 validate 钩子调用：缺失关键变量时抛出明确错误，
 * 使进程在启动阶段即失败退出，避免运行期出现难以定位的连接错误。
 */
export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (!config.DATABASE_URL) {
    throw new Error(
      '环境变量 DATABASE_URL 缺失：请在 server/.env 中配置 PostgreSQL 连接串（可参考 .env.example）',
    );
  }
  return config;
}
