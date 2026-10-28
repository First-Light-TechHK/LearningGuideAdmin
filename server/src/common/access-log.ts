import type { NextFunction, Request, Response } from 'express';
import { Logger } from '@nestjs/common';

/**
 * 访问日志（2026-10-28 复盘 A4）。
 *
 * 背景：Portal 的 AI Tutor 入口依赖 Portal → KS 的 HTTP 调用，但 Admin 服务
 * 原先只有 Nest 启动日志与异常日志，**成功的请求完全不留痕**。事故排查时无法
 * 证明"Portal 到底有没有来查过 /api/user/ai-tutors"，只能靠 Portal 侧日志反推。
 *
 * 约定与 Portal 的 access log 保持一致，便于同一个 CloudWatch 查询过滤：
 *   {"type":"access","method":"GET","path":"/api/user/ai-tutors","status":200,
 *    "durationMs":12,"outcome":"finish","ua":"..."}
 *
 * 只记录路径、不含查询串（查询串可能带 email/token）与请求体，避免写入敏感数据。
 * 默认开启；`ACCESS_LOG=0` 可关闭（本地调试噪音太大时）。
 */
const logger = new Logger('AccessLog');

/** 健康检查每秒一次，记录它会淹没真正的业务请求。 */
const SILENT_PATHS = new Set(['/api/health', '/health']);

export function accessLog(req: Request, res: Response, next: NextFunction): void {
  if (process.env.ACCESS_LOG === '0') {
    next();
    return;
  }
  const startedAt = process.hrtime.bigint();
  // 在 finish 之前记录，避免覆盖业务代码写入的 status
  res.on('finish', () => {
    const elapsed = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    // req.path 不含查询串；express 在路由匹配后才有 route，这里用原始 path
    const path = req.path || req.url.split('?')[0] || '';
    if (SILENT_PATHS.has(path)) return;
    logger.log(
      JSON.stringify({
        type: 'access',
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(elapsed),
        outcome: res.writableFinished ? 'finish' : 'aborted',
        ua: String(req.headers['user-agent'] || '').slice(0, 80),
      }),
    );
  });
  next();
}
