import { SandboxResetController } from './sandbox-reset.controller';

describe('Sandbox recovery endpoint', () => {
  it('requires a confirmation phrase and a string reason', () => {
    const resets = { assertAvailable: jest.fn() };
    const packages = { recoverInvalidLiveImport: jest.fn() };
    const controller = new SandboxResetController(resets as never, packages as never);
    for (const body of [{}, {confirm: 'RECOVER COURSE', reason: 7}, {confirm: 'RECOVER COURSE', reason: ' '}]) {
      expect(() => controller.recoverLive('job1', body as never, {} as never)).toThrow();
    }
    expect(packages.recoverInvalidLiveImport).not.toHaveBeenCalled();
  });
  it('passes the explicit reason and authenticated employee to the recovery service', () => {
    const packages = { recoverInvalidLiveImport: jest.fn() };
    const controller = new SandboxResetController({ assertAvailable: jest.fn() } as never, packages as never);
    controller.recoverLive('job1', {confirm: 'RECOVER COURSE', reason: 'verified package'}, {employee:{employeeId:'admin'}} as never);
    expect(packages.recoverInvalidLiveImport).toHaveBeenCalledWith('job1', 'verified package', 'admin');
  });
});

describe('Sandbox recovery route authorization', () => {
  it('is registered as employee-admin only', async () => {
    const { routeAccess } = await import('../backoffice/nest/route-access');
    expect(routeAccess('POST', '/api/backoffice/sandbox/reset/recover-live/job1')).toEqual({kind: 'employeeAdmin'});
  });
});
