import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { appEnvName } from '../backoffice/lib/env';
import { SANDBOX_LOCK_LEASE } from './sandbox-lock-release.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { SandboxResetError } from './sandbox-reset.service';
import { SandboxWriteLock } from './sandbox-write-lock';

/** Course writes retain a shared database lock through the HTTP response. */
@Injectable()
export class SandboxMaintenanceGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService, private readonly locks: SandboxWriteLock) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const method = (request.method ?? 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS' || appEnvName() !== 'SANDBOX') return true;
    let lease;
    try {
      lease = await this.locks.acquire('shared');
      if (!lease) throw new SandboxResetError('SANDBOX_MAINTENANCE', 409, 'A sandbox reset is running; course changes are temporarily blocked.');
      const active = await this.prisma.sandboxResetJob.count({where: {status: {in: ['QUEUED', 'RUNNING']}}});
      if (active) throw new SandboxResetError('SANDBOX_MAINTENANCE', 409, 'A sandbox reset is active; course changes are temporarily blocked.');
      (request as Request & { [SANDBOX_LOCK_LEASE]?: typeof lease })[SANDBOX_LOCK_LEASE] = lease;

      return true;
    } catch (error) {
      if (lease) await lease.release().catch(() => undefined);
      if (error instanceof SandboxResetError) throw error;
      throw new SandboxResetError('SANDBOX_MAINTENANCE_UNAVAILABLE', 503, 'Unable to verify whether sandbox maintenance is active. Please retry.');
    }
  }
}
