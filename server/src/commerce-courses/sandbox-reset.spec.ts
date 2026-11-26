/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */
import type { CommerceCourseConfig } from './commerce.config';
import {
  DEFAULT_SANDBOX_RESET_SCOPE,
  normalizeSandboxResetScope,
  SandboxResetService,
  sandboxResetScopeIsEmpty,
} from './sandbox-reset.service';

jest.mock('../backoffice/repositories/auditRepository', () => ({
  tryRecordAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

type AnyPrisma = Record<string, any>;

function makePrisma(): AnyPrisma {
  const prisma: AnyPrisma = {
    sandboxResetJob: {
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    coursePackageJob: {
      count: jest.fn().mockResolvedValue(0),
      deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
    commerceCourse: {
      count: jest.fn().mockResolvedValue(0),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    courseVersion: { count: jest.fn().mockResolvedValue(3) },
    courseMediaAsset: {
      count: jest.fn().mockResolvedValue(4),
      aggregate: jest.fn().mockResolvedValue({ _sum: { size: 1024 } }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    popularCourseEntry: {
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    discoveryBanner: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    coursePlan: { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) },
    courseCodeCounter: {
      deleteMany: jest.fn().mockResolvedValue({ count: 5 }),
    },
    $transaction: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([
      {
        id: 'job-1',
        liveVersionIds: 0n,
        planCourseIds: 0n,
        popularCourseIds: 0n,
        bannerCourseIds: 0n,
      },
    ]),
  };
  prisma.$transaction = jest.fn((callback: (tx: AnyPrisma) => unknown) =>
    callback(prisma),
  );
  return prisma;
}

function makeLock(prisma: AnyPrisma) {
  return { acquire: jest.fn().mockResolvedValue({
    finishReset: jest.fn((id: string, status: string, report: unknown, error: unknown) => prisma.sandboxResetJob.update({where: {id}, data: {status, report, error}})),
    release: jest.fn().mockResolvedValue(undefined),
  }) };
}

function makeStorage(): {
  assertStagingRootSafe: jest.Mock;
  clearStagingRoot: jest.Mock;
  removeMedia: jest.Mock;
  clearCourseMediaRoot: jest.Mock;
} {
  return {
    assertStagingRootSafe: jest.fn(),
    clearStagingRoot: jest.fn().mockResolvedValue(undefined),
    removeMedia: jest.fn().mockResolvedValue(undefined),
    clearCourseMediaRoot: jest.fn().mockResolvedValue(undefined),
  };
}

function makeConfig(
  patch: Partial<CommerceCourseConfig> = {},
): CommerceCourseConfig {
  return {
    environmentLabel: 'Sandbox',
    publicSiteUrl: '',
    versionNumberingMode: 'sandbox',
    mediaRoot: '',
    packageStagingRoot: '',
    maxImageBytes: 0,
    maxVideoBytes: 0,
    maxAudioBytes: 0,
    maxPdfBytes: 0,
    maxModelBytes: 0,
    packageMaxBytes: 0,
    packageDirectUploadBytes: 0,
    packageExportTtlHours: 24,
    jobConcurrency: 2,
    jobPollMs: 2000,
    jobHeartbeatMs: 10000,
    jobStaleMs: 600000,
    jobMaxAttempts: 3,
    sandboxResetEnabled: true,
    ...patch,
  };
}

function job(scope: unknown, status = 'RUNNING') {
  return {
    id: 'job-1',
    status,
    stage: null,
    progress: 0,
    scope,
    requestedBy: '11111111-1111-1111-1111-111111111111',
    reason: 'text',
    counts: { courses: 1 },
    report: null,
    error: null,
    heartbeatAt: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('sandbox reset scope', () => {
  it('defaults every key to true when omitted and ignores unknown keys', () => {
    expect(normalizeSandboxResetScope(undefined)).toEqual(
      DEFAULT_SANDBOX_RESET_SCOPE,
    );
    expect(normalizeSandboxResetScope({ courses: false, nope: true })).toEqual({
      ...DEFAULT_SANDBOX_RESET_SCOPE,
      courses: false,
    });
  });

  it('detects an empty scope', () => {
    expect(sandboxResetScopeIsEmpty(DEFAULT_SANDBOX_RESET_SCOPE)).toBe(false);
    expect(
      sandboxResetScopeIsEmpty({
        courses: false,
        media: false,
        staging: false,
        packageJobs: false,
        resetCodeCounters: false,
      }),
    ).toBe(true);
  });
});

describe('SandboxResetService guards', () => {
  const originalEnv = process.env.APP_ENV;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalEnv;
  });

  it('is available only when the flag is on and APP_ENV=SANDBOX', () => {
    process.env.APP_ENV = 'SANDBOX';
    const enabled = new SandboxResetService(
      makePrisma() as never,
      makeStorage() as never,
      makeConfig({ sandboxResetEnabled: true }),
      makeLock(makePrisma()) as never,
    );
    expect(enabled.isAvailable()).toBe(true);

    const flagOff = new SandboxResetService(
      makePrisma() as never,
      makeStorage() as never,
      makeConfig({ sandboxResetEnabled: false }),
      makeLock(makePrisma()) as never,
    );
    expect(flagOff.isAvailable()).toBe(false);

    process.env.APP_ENV = 'UAT';
    expect(enabled.isAvailable()).toBe(false);
  });

  it('state() returns 403 SANDBOX_RESET_DISABLED outside a sandbox', async () => {
    process.env.APP_ENV = 'UAT';
    const service = new SandboxResetService(
      makePrisma() as never,
      makeStorage() as never,
      makeConfig(),
      makeLock(makePrisma()) as never,
    );
    await expect(service.state()).rejects.toMatchObject({
      code: 'SANDBOX_RESET_DISABLED',
      status: 403,
    });
  });
});

describe('SandboxResetService.create', () => {
  const originalEnv = process.env.APP_ENV;

  beforeAll(() => {
    process.env.APP_ENV = 'SANDBOX';
  });

  afterAll(() => {
    if (originalEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalEnv;
  });

  function service(prisma = makePrisma()) {
    return new SandboxResetService(
      prisma as never,
      makeStorage() as never,
      makeConfig(),
      makeLock(prisma) as never,
    );
  }

  it('requires the exact confirmation phrase and a reason', async () => {
    const reset = service();
    await expect(
      reset.create({ confirm: 'reset sandbox', reason: 'why' }, null, null),
    ).rejects.toMatchObject({
      code: 'RESET_CONFIRMATION_REQUIRED',
      status: 409,
    });
    await expect(
      reset.create({ confirm: 'RESET SANDBOX', reason: '   ' }, null, null),
    ).rejects.toMatchObject({
      code: 'RESET_CONFIRMATION_REQUIRED',
      status: 409,
    });
  });

  it('rejects an empty scope with 422', async () => {
    await expect(
      service().create(
        {
          confirm: 'RESET SANDBOX',
          reason: 'why',
          scope: {
            courses: false,
            media: false,
            staging: false,
            packageJobs: false,
            resetCodeCounters: false,
          },
        },
        null,
        null,
      ),
    ).rejects.toMatchObject({ code: 'RESET_SCOPE_EMPTY', status: 422 });
  });

  it('refuses to start while import/export jobs are active', async () => {
    const prisma = makePrisma();
    prisma.coursePackageJob.count.mockResolvedValue(1);
    await expect(
      service(prisma).create(
        { confirm: 'RESET SANDBOX', reason: 'why' },
        null,
        null,
      ),
    ).rejects.toMatchObject({ code: 'RESET_BUSY', status: 409 });
  });

  it('creates a queued job and records the requested audit event', async () => {
    const prisma = makePrisma();
    prisma.sandboxResetJob.create.mockResolvedValue(
      job(DEFAULT_SANDBOX_RESET_SCOPE, 'QUEUED'),
    );
    const created = await service(prisma).create(
      { confirm: 'RESET SANDBOX', reason: 'fresh import', scope: {} },
      '11111111-1111-1111-1111-111111111111',
      '127.0.0.1',
    );
    expect(created.status).toBe('QUEUED');
    expect(created.scope).toEqual(DEFAULT_SANDBOX_RESET_SCOPE);
  });
});

describe('SandboxResetService.execute', () => {
  const originalEnv = process.env.APP_ENV;

  beforeAll(() => {
    process.env.APP_ENV = 'SANDBOX';
  });

  afterAll(() => {
    if (originalEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalEnv;
  });

  it('clears jobs, staging, media objects and the course database in order', async () => {
    const prisma = makePrisma();
    prisma.sandboxResetJob.findUnique.mockResolvedValue(
      job(DEFAULT_SANDBOX_RESET_SCOPE),
    );
    prisma.courseMediaAsset.findMany.mockResolvedValue([
      { storageKey: 'course-media/c1/a.png' },
    ]);
    const storage = makeStorage();
    const service = new SandboxResetService(
      prisma as never,
      storage as never,
      makeConfig(),
      makeLock(prisma) as never,
    );

    await service.execute('job-1');

    expect(prisma.coursePackageJob.deleteMany).toHaveBeenCalled();
    expect(storage.clearStagingRoot).toHaveBeenCalled();
    expect(storage.clearCourseMediaRoot).toHaveBeenCalled();
    expect(prisma.coursePlan.deleteMany).toHaveBeenCalled();
    expect(prisma.commerceCourse.deleteMany).toHaveBeenCalled();
    expect(prisma.courseCodeCounter.deleteMany).toHaveBeenCalled();
    expect(prisma.sandboxResetJob.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: 'job-1' },
        data: expect.objectContaining({ status: 'SUCCEEDED' }),
      }),
    );
  });

  it('does not begin until in-flight writers release the shared lock', async () => {
    const prisma = makePrisma();
    prisma.sandboxResetJob.findUnique.mockResolvedValue(job(DEFAULT_SANDBOX_RESET_SCOPE));
    const storage = makeStorage();
    const locks = {acquire: jest.fn().mockResolvedValue(null)};
    await new SandboxResetService(prisma as never, storage as never, makeConfig(), locks as never).execute('job-1');
    expect(storage.clearStagingRoot).not.toHaveBeenCalled();
    expect(prisma.sandboxResetJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({data: expect.objectContaining({status: 'QUEUED'})}));
  });

  it('continues heartbeating while a storage operation is pending', async () => {
    jest.useFakeTimers();
    try {
      const prisma = makePrisma();
      prisma.sandboxResetJob.findUnique.mockResolvedValue(job(DEFAULT_SANDBOX_RESET_SCOPE));
      const storage = makeStorage();
      let release!: () => void;
      storage.clearStagingRoot.mockReturnValue(new Promise<void>((resolve) => { release = resolve; }));
      const service = new SandboxResetService(prisma as never, storage as never, makeConfig({ jobHeartbeatMs: 100 }), makeLock(prisma) as never);
      const work = service.execute('job-1');
      for (let i = 0; i < 20 && !release; i++) await Promise.resolve();
      expect(release).toBeDefined();
      await jest.advanceTimersByTimeAsync(250);
      expect(prisma.sandboxResetJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({where: {id: 'job-1', status: 'RUNNING'}, data: expect.objectContaining({heartbeatAt: expect.any(Date)})}));
      release();
      await work;
    } finally { jest.useRealTimers(); }
  });

  it('exposes a stale running job as STALLED without clearing maintenance', async () => {
    const prisma = makePrisma();
    const stale = job(DEFAULT_SANDBOX_RESET_SCOPE);
    stale.heartbeatAt = new Date(Date.now() - 60_000) as never;
    prisma.sandboxResetJob.findUnique.mockResolvedValue(stale);
    const service = new SandboxResetService(prisma as never, makeStorage() as never, makeConfig({jobStaleMs: 1000}), makeLock(prisma) as never);
    expect(await service.getJob('job-1')).toMatchObject({status: 'RUNNING', stage: 'STALLED'});
  });

  it('does not requeue a stale running job which may still be deleting objects', async () => {
    const prisma = makePrisma();
    const service = new SandboxResetService(prisma as never, makeStorage() as never, makeConfig(), makeLock(prisma) as never);
    await service.reclaimStale();
    expect(prisma.sandboxResetJob.updateMany).not.toHaveBeenCalled();
  });

  it('does not begin destructive work when a package job is active at execution time', async () => {
    const prisma = makePrisma();
    prisma.sandboxResetJob.findUnique.mockResolvedValue(job(DEFAULT_SANDBOX_RESET_SCOPE));
    prisma.coursePackageJob.count.mockResolvedValue(1);
    const storage = makeStorage();
    await new SandboxResetService(prisma as never, storage as never, makeConfig(), makeLock(prisma) as never).execute('job-1');
    expect(prisma.coursePackageJob.deleteMany).not.toHaveBeenCalled();
    expect(storage.clearStagingRoot).not.toHaveBeenCalled();
    expect(prisma.sandboxResetJob.update).toHaveBeenLastCalledWith(expect.objectContaining({data: expect.objectContaining({status: 'FAILED', error: expect.stringContaining('active')})}));
  });

  it('checks staging overlap even when clearing media only', async () => {
    const prisma = makePrisma();
    prisma.sandboxResetJob.findUnique.mockResolvedValue(job({...DEFAULT_SANDBOX_RESET_SCOPE, staging: false}));
    const storage = makeStorage();
    storage.assertStagingRootSafe.mockImplementation(() => { throw new Error('unsafe overlap'); });
    await new SandboxResetService(prisma as never, storage as never, makeConfig(), makeLock(prisma) as never).execute('job-1');
    expect(storage.clearCourseMediaRoot).not.toHaveBeenCalled();
  });

  it('rejects an unsafe staging root before deleting jobs', async () => {
    const prisma = makePrisma();
    prisma.sandboxResetJob.findUnique.mockResolvedValue(job(DEFAULT_SANDBOX_RESET_SCOPE));
    const storage = makeStorage();
    storage.assertStagingRootSafe.mockImplementation(() => { throw new Error('unsafe staging'); });
    await new SandboxResetService(prisma as never, storage as never, makeConfig(), makeLock(prisma) as never).execute('job-1');
    expect(prisma.coursePackageJob.deleteMany).not.toHaveBeenCalled();
    expect(storage.clearStagingRoot).not.toHaveBeenCalled();
  });

  it('rejects media records outside the course-media namespace before any deletion', async () => {
    const prisma = makePrisma();
    prisma.sandboxResetJob.findUnique.mockResolvedValue(job(DEFAULT_SANDBOX_RESET_SCOPE));
    prisma.courseMediaAsset.findMany.mockResolvedValue([{ storageKey: 'outside/important.bin' }]);
    const storage = makeStorage();
    const service = new SandboxResetService(prisma as never, storage as never, makeConfig(), makeLock(prisma) as never);
    await service.execute('job-1');
    expect(storage.removeMedia).not.toHaveBeenCalled();
    expect(prisma.coursePackageJob.deleteMany).not.toHaveBeenCalled();
    expect(prisma.sandboxResetJob.update).toHaveBeenLastCalledWith(expect.objectContaining({data: expect.objectContaining({status: 'FAILED'})}));
  });

  it('leaves the database untouched when removing a media object fails', async () => {
    const prisma = makePrisma();
    prisma.sandboxResetJob.findUnique.mockResolvedValue(
      job(DEFAULT_SANDBOX_RESET_SCOPE),
    );
    prisma.courseMediaAsset.findMany.mockResolvedValue([
      { storageKey: 'course-media/c1/a.png' },
    ]);
    const storage = makeStorage();
    storage.clearCourseMediaRoot.mockRejectedValue(new Error('S3 down'));
    const service = new SandboxResetService(
      prisma as never,
      storage as never,
      makeConfig(),
      makeLock(prisma) as never,
    );

    await service.execute('job-1');

    expect(prisma.commerceCourse.deleteMany).not.toHaveBeenCalled();
    expect(prisma.sandboxResetJob.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    );
  });

  it('keeps code counters when resetCodeCounters is false', async () => {
    const prisma = makePrisma();
    prisma.sandboxResetJob.findUnique.mockResolvedValue(
      job({ ...DEFAULT_SANDBOX_RESET_SCOPE, resetCodeCounters: false }),
    );
    const service = new SandboxResetService(
      prisma as never,
      makeStorage() as never,
      makeConfig(),
      makeLock(prisma) as never,
    );

    await service.execute('job-1');

    expect(prisma.courseCodeCounter.deleteMany).not.toHaveBeenCalled();
    expect(prisma.commerceCourse.deleteMany).toHaveBeenCalled();
  });

  it('records pre-existing dangling references in the report', async () => {
    const prisma = makePrisma();
    prisma.sandboxResetJob.findUnique.mockResolvedValue(
      job(DEFAULT_SANDBOX_RESET_SCOPE),
    );
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          liveVersionIds: 2n,
          planCourseIds: 1n,
          popularCourseIds: 0n,
          bannerCourseIds: 0n,
        },
      ])
      .mockResolvedValueOnce([
        {
          liveVersionIds: 0n,
          planCourseIds: 0n,
          popularCourseIds: 0n,
          bannerCourseIds: 0n,
        },
      ]);
    const service = new SandboxResetService(
      prisma as never,
      makeStorage() as never,
      makeConfig(),
      makeLock(prisma) as never,
    );

    await service.execute('job-1');

    const last = prisma.sandboxResetJob.update.mock.calls.at(-1)[0];
    expect(last.data.status).toBe('SUCCEEDED');
    expect(last.data.report.integrityBefore).toEqual({
      liveVersionIds: 2,
      planCourseIds: 1,
      popularCourseIds: 0,
      bannerCourseIds: 0,
    });
  });

  it('fails and reports remaining courses after all cleanup attempts', async () => {
    const prisma = makePrisma();
    prisma.sandboxResetJob.findUnique.mockResolvedValue(job(DEFAULT_SANDBOX_RESET_SCOPE));
    prisma.commerceCourse.count.mockResolvedValue(2);
    const service = new SandboxResetService(prisma as never, makeStorage() as never, makeConfig(), makeLock(prisma) as never);
    await service.execute('job-1');
    expect(prisma.commerceCourse.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.sandboxResetJob.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'FAILED', error: expect.stringContaining('2') }),
    }));
  });

  it('fails the job when dangling references remain after the reset', async () => {
    const prisma = makePrisma();
    prisma.sandboxResetJob.findUnique.mockResolvedValue(
      job(DEFAULT_SANDBOX_RESET_SCOPE),
    );
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          liveVersionIds: 0n,
          planCourseIds: 0n,
          popularCourseIds: 0n,
          bannerCourseIds: 0n,
        },
      ])
      .mockResolvedValueOnce([
        {
          liveVersionIds: 1n,
          planCourseIds: 0n,
          popularCourseIds: 0n,
          bannerCourseIds: 0n,
        },
      ]);
    const service = new SandboxResetService(
      prisma as never,
      makeStorage() as never,
      makeConfig(),
      makeLock(prisma) as never,
    );

    await service.execute('job-1');

    expect(prisma.sandboxResetJob.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          error: expect.stringContaining('dangling reference'),
        }),
      }),
    );
  });
});
