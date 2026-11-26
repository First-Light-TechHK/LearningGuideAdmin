import { SANDBOX_LOCK_LEASE } from './sandbox-lock-release.interceptor';
import { SandboxMaintenanceGuard } from './sandbox-maintenance.guard';

describe('Sandbox maintenance guard', () => {
  const context = (request: object) => ({ switchToHttp: () => ({ getRequest: () => request }) }) as never;
  const originalEnv = process.env.APP_ENV;
  beforeEach(() => { process.env.APP_ENV = 'SANDBOX'; });
  afterEach(() => { if (originalEnv === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = originalEnv; });
  const lease = () => ({ release: jest.fn().mockResolvedValue(undefined) });
  it('holds a shared lock through the response and blocks queued/running jobs without stale cache', async () => {
    const count = jest.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const first = lease(), second = lease();
    const guard = new SandboxMaintenanceGuard({ sandboxResetJob: { count } } as never, {acquire: jest.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)} as never);
    const request = {method: 'POST'};
    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(first.release).not.toHaveBeenCalled();
    expect((request as Record<symbol, unknown>)[SANDBOX_LOCK_LEASE]).toBe(first);
    await expect(guard.canActivate(context({method:'POST'}))).rejects.toMatchObject({ code: 'SANDBOX_MAINTENANCE' });
    expect(second.release).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenLastCalledWith({ where: { status: { in: ['QUEUED', 'RUNNING'] } } });
  });
  it('does not add locks or maintenance queries outside Sandbox', async () => {
    process.env.APP_ENV = 'PROD';
    const count = jest.fn();
    const acquire = jest.fn();
    const guard = new SandboxMaintenanceGuard({ sandboxResetJob: {count} } as never, {acquire} as never);
    await expect(guard.canActivate(context({method: 'POST'}))).resolves.toBe(true);
    expect(acquire).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it('fails closed when reset state cannot be read and leaves reads available', async () => {
    const acquired = lease();
    const guard = new SandboxMaintenanceGuard({ sandboxResetJob: { count: jest.fn().mockRejectedValue(new Error('db unavailable')) } } as never, {acquire: jest.fn().mockResolvedValue(acquired)} as never);
    await expect(guard.canActivate(context({method:'POST'}))).rejects.toMatchObject({ code: 'SANDBOX_MAINTENANCE_UNAVAILABLE' });
    expect(acquired.release).toHaveBeenCalledTimes(1);
    await expect(guard.canActivate(context({method:'GET'}))).resolves.toBe(true);
  });
});
