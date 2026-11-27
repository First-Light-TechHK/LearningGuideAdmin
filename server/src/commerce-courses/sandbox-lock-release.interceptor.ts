import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { tap } from 'rxjs/operators';
import { SandboxLockLease } from './sandbox-write-lock';

export const SANDBOX_LOCK_LEASE = Symbol('sandbox-write-lease');
type RequestWithLease = { [SANDBOX_LOCK_LEASE]?: SandboxLockLease };

/** Release when the actual handler/interceptor chain completes, not on socket close. */
@Injectable()
export class SandboxLockReleaseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<RequestWithLease>();
    const release = () => { void request[SANDBOX_LOCK_LEASE]?.release().catch(() => undefined); };
    return next.handle().pipe(tap({ complete: release, error: release }));
  }
}
