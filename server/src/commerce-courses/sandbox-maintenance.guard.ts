import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { PrismaService } from '../prisma/prisma.service';
import { SandboxResetError } from './sandbox-reset.service';

/**
 * 重置维护守卫：Sandbox 重置作业 RUNNING 期间，课程写请求返回 409 SANDBOX_MAINTENANCE，
 * 避免重置与编辑/导入并发（plan §5.5）。只作用于课程控制器；只读请求放行。
 * 作业只可能在 Sandbox 创建（服务层三层守卫），因此其它环境不会命中。
 * 结果缓存 1 秒，避免每个写请求都查库。
 */
@Injectable()
export class SandboxMaintenanceGuard implements CanActivate {
  private checkedAt = 0;
  private active = false;

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const method = (request.method ?? 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return true;
    }
    if (!(await this.isActive())) return true;
    throw new SandboxResetError(
      'SANDBOX_MAINTENANCE',
      409,
      'A sandbox reset is running; course changes are temporarily blocked.',
    );
  }

  private async isActive(): Promise<boolean> {
    const now = Date.now();
    if (now - this.checkedAt < 1000) return this.active;
    this.checkedAt = now;
    try {
      this.active =
        (await this.prisma.sandboxResetJob.count({
          where: { status: 'RUNNING' },
        })) > 0;
    } catch {
      // 查询失败时不阻断正常写请求（fail-open）：重置本身有单活约束，
      // 这里的守卫只是防并发，不应让数据库抖动变成写请求全挂。
      this.active = false;
    }
    return this.active;
  }
}
