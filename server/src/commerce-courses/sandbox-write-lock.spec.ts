import { SandboxWriteLock } from './sandbox-write-lock';

describe('Sandbox write lock', () => {
  it('takes a shared lock and releases its own connection', async () => {
    const client = { query: jest.fn().mockResolvedValueOnce({rows:[{locked:true}]}).mockResolvedValue({rows:[]}), release: jest.fn() };
    const lock = new SandboxWriteLock({ connect: jest.fn().mockResolvedValue(client) } as never);
    const lease = await lock.acquire('shared');
    expect(lease).not.toBeNull();
    await lease!.release();
    expect(client.query.mock.calls[0][0]).toContain('pg_try_advisory_lock_shared');
    expect(client.query.mock.calls[1][0]).toContain('pg_advisory_unlock_shared');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
  it('releases the connection immediately if the lock is unavailable', async () => {
    const client = {query: jest.fn().mockResolvedValue({rows:[{locked:false}]}), release: jest.fn()};
    const lock = new SandboxWriteLock({connect: jest.fn().mockResolvedValue(client)} as never);
    expect(await lock.acquire('exclusive')).toBeNull();
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
