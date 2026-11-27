import { of, throwError, Subject } from 'rxjs';
import { SandboxLockReleaseInterceptor, SANDBOX_LOCK_LEASE } from './sandbox-lock-release.interceptor';

describe('Sandbox write lease lifecycle', () => {
  it('releases only after the wrapped handler completes or errors', async () => {
    for (const observable of [of('ok'), throwError(() => new Error('failed'))]) {
      const release = jest.fn().mockResolvedValue(undefined);
      const request = {[SANDBOX_LOCK_LEASE]: {release}};
      const ctx = {switchToHttp: () => ({getRequest: () => request})} as never;
      new SandboxLockReleaseInterceptor().intercept(ctx, {handle: () => observable} as never).subscribe({error: () => undefined});
      await Promise.resolve();
      expect(release).toHaveBeenCalledTimes(1);
    }
  });
  it('does not release merely because a subscriber aborts while the handler may still run', () => {
    const release = jest.fn().mockResolvedValue(undefined);
    const ctx = {switchToHttp: () => ({getRequest: () => ({[SANDBOX_LOCK_LEASE]: {release}})})} as never;
    const source = new Subject();
    const subscription = new SandboxLockReleaseInterceptor().intercept(ctx, {handle: () => source} as never).subscribe();
    subscription.unsubscribe();
    expect(release).not.toHaveBeenCalled();
  });
});
