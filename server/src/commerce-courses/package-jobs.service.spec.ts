import { ArgumentsHost, Logger } from '@nestjs/common';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import {
  assertExportSelectorBody,
  encodeJobByteTotal,
  formatBytes,
  PackageJobsService,
  parseExportSelector,
} from './package-jobs.service';

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;
const KB = 1024;

describe('formatBytes', () => {
  it('prints whole configured limits the way users read them', () => {
    expect(formatBytes(8 * GB)).toBe('8 GB');
    expect(formatBytes(200 * MB)).toBe('200 MB');
    expect(formatBytes(5 * MB)).toBe('5 MB');
    expect(formatBytes(512 * KB)).toBe('512 KB');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(3)).toBe('3 B');
  });
});

describe('encodeJobByteTotal', () => {
  it('stores sizes within the Postgres INTEGER range directly', () => {
    expect(encodeJobByteTotal(1 * GB)).toEqual({
      bytesTotal: 1 * GB,
      requestId: null,
    });
    expect(encodeJobByteTotal(2_147_483_647)).toEqual({
      bytesTotal: 2_147_483_647,
      requestId: null,
    });
  });

  it('keeps 4 GiB–8 GiB declarations without overflowing the Int column', () => {
    // 4 GiB 超过 2^31-1：Int 列封顶，真实值进 requestId（不再 500）
    const four = encodeJobByteTotal(4 * GB);
    expect(four.bytesTotal).toBe(2_147_483_647);
    expect(four.requestId).toBe(`raw-bytes-total:${4 * GB}`);
    const eight = encodeJobByteTotal(8 * GB);
    expect(eight.bytesTotal).toBe(2_147_483_647);
    expect(eight.requestId).toBe(`raw-bytes-total:${8 * GB}`);
  });
});

describe('parseExportSelector — PRD §16.2 只导出当前线上版本', () => {
  it('defaults to the live version and accepts the explicit live selector', () => {
    expect(parseExportSelector(undefined)).toEqual({ kind: 'live' });
    expect(parseExportSelector({})).toEqual({ kind: 'live' });
    expect(parseExportSelector({ version: '' })).toEqual({ kind: 'live' });
    expect(parseExportSelector({ version: ' live ' })).toEqual({
      kind: 'live',
    });
    expect(parseExportSelector({ version: 'LIVE' })).toEqual({
      kind: 'live',
    });
  });

  it('rejects every draft / specific-version selector with 400 VALIDATION_ERROR', () => {
    for (const body of [
      { version: 'working' },
      { version: ' draft ' },
      { version: 'version:4' },
      { version: 'version:1.2' },
      { version: 'version:Version 3' },
      { version: '1.1' },
      { versionId: '11111111-1111-1111-1111-111111111111' },
      { sourceVersion: 'live' },
      { sourceVersion: 'version:2' },
    ]) {
      let error: unknown;
      try {
        parseExportSelector(body);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        code: 'VALIDATION_ERROR',
        httpStatus: 400,
      });
      // 文案必须说明只能导出线上版本
      expect(String((error as Error).message)).toContain(
        'current live version',
      );
    }
  });
});

describe('assertExportSelectorBody', () => {
  it('accepts absent or string selectors', () => {
    expect(() => assertExportSelectorBody(undefined)).not.toThrow();
    expect(() => assertExportSelectorBody({})).not.toThrow();
    expect(() =>
      assertExportSelectorBody({
        version: 'live',
        versionId: '',
        sourceVersion: '',
      }),
    ).not.toThrow();
  });

  it('rejects non-string selectors instead of silently exporting live', () => {
    for (const body of [
      { version: 1 },
      { version: null },
      { versionId: 123 },
      { sourceVersion: ['live'] },
    ]) {
      let error: unknown;
      try {
        assertExportSelectorBody(body);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        code: 'VALIDATION_ERROR',
        httpStatus: 400,
      });
    }
  });
});

describe('PackageJobsService — 课程包分块会话（> 200 MB）', () => {
  function make() {
    const prisma = {
      coursePackageJob: {
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const storage = {
      stagingKey: (jobId: string, name: string) => `${jobId}/${name}`,
      putStaging: jest.fn().mockResolvedValue(undefined),
      hasStaging: jest.fn().mockResolvedValue(true),
      getStaging: jest.fn(),
      removeStaging: jest.fn().mockResolvedValue(undefined),
    };
    const config = {
      packageMaxBytes: 8 * GB,
      packageDirectUploadBytes: 200 * MB,
    };
    const svc = new PackageJobsService(
      prisma as never,
      storage as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      config as never,
    );
    return { svc, prisma, storage };
  }

  it('creates an UPLOADING_PACKAGE job and accepts a 1 GB package', async () => {
    const { svc, prisma } = make();
    const result = await svc.createPackageUploadSession(
      { name: 'big.lgcourse.zip', bytesTotal: 1 * GB },
      'emp-1',
    );
    expect(result.jobId).toBeTruthy();
    expect(result.chunkSize).toBe(5 * MB);
    const created = prisma.coursePackageJob.create.mock.calls[0] as unknown as [
      { data: { stage: string; bytesTotal: number; courseId: string | null } },
    ];
    const data = created[0].data;
    expect(data.stage).toBe('UPLOADING_PACKAGE');
    expect(data.bytesTotal).toBe(1 * GB);
    expect(data.courseId).toBeNull();
  });

  it('rejects unsupported extensions and oversize declarations', async () => {
    const { svc } = make();
    await expect(
      svc.createPackageUploadSession({ name: 'big.rar', bytesTotal: 1 }, null),
    ).rejects.toMatchObject({ code: 'PACKAGE_INVALID_ZIP', httpStatus: 400 });
    await expect(
      svc.createPackageUploadSession(
        { name: 'big.zip', bytesTotal: 9 * GB },
        null,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 400 });
  });

  it('does not accept package chunks on a raw upload job', async () => {
    const { svc, prisma } = make();
    prisma.coursePackageJob.findUnique.mockResolvedValue({
      id: 'j1',
      stage: 'UPLOADING',
      bytesTotal: 10,
      requestId: null,
    });
    await expect(
      svc.appendPackageChunk('j1', 0, Buffer.from('x')),
    ).rejects.toMatchObject({
      code: 'RAW_UPLOAD_NOT_ACTIVE',
      httpStatus: 409,
    });
  });

  it('refuses to complete when a chunk is missing', async () => {
    const { svc, prisma, storage } = make();
    prisma.coursePackageJob.findUnique.mockResolvedValue({
      id: 'j1',
      stage: 'UPLOADING_PACKAGE',
      bytesTotal: 10,
      requestId: null,
    });
    storage.hasStaging.mockResolvedValue(false);
    await expect(svc.completePackageUpload('j1')).rejects.toMatchObject({
      code: 'RAW_UPLOAD_INCOMPLETE',
      httpStatus: 400,
    });
  });
});

describe('PackageJobsService — 分块拼包后直接校验（不做 Excel 转换）', () => {
  it('assembles chunks, hashes the package and starts validation', async () => {
    const job = {
      id: 'j1',
      kind: 'IMPORT',
      status: 'VALIDATING',
      stage: 'UPLOADING_PACKAGE',
      progress: 0,
      error: null,
      courseId: null,
      sourceVersionId: null,
      fileLabel: null,
      manifest: null,
      report: null,
      conflicts: null,
      bytesTotal: 6 * MB,
      requestId: null,
    };
    const prisma = {
      coursePackageJob: {
        findUnique: jest.fn().mockResolvedValue(job),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const storage = {
      stagingKey: (jobId: string, name: string) => `${jobId}/${name}`,
      putStaging: jest.fn(),
      hasStaging: jest.fn().mockResolvedValue(true),
      getStaging: jest.fn().mockResolvedValue(Buffer.from('abc')),
      removeStaging: jest.fn().mockResolvedValue(undefined),
    };
    const config = {
      packageMaxBytes: 8 * GB,
      packageDirectUploadBytes: 200 * MB,
    };
    const svc = new PackageJobsService(
      prisma as never,
      storage as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      config as never,
    );
    const validate = jest
      .spyOn(svc as never, 'runValidationFromFile')
      .mockResolvedValue(undefined as never);
    await svc.completePackageUpload('j1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(storage.getStaging).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenCalledWith(
      'j1',
      expect.stringContaining('package.zip'),
    );
    const updates = prisma.coursePackageJob.update.mock.calls.map(
      (call) =>
        (
          call as unknown as [
            {
              data: {
                stage?: string;
                packageHash?: string;
                bytesTotal?: number;
              };
            },
          ]
        )[0].data,
    );
    const update = updates.find((row) => row.stage === 'VALIDATING');
    expect(update?.packageHash).toMatch(/^[a-f0-9]{64}$/);
    expect(update?.bytesTotal).toBe(6 * MB);
  });
});

describe('PackageJobsService.startExport — 只导出当前线上版本（PRD §16.2）', () => {
  function make(exportable = { versionId: 'v-live', versionLabel: '2.1' }) {
    const prisma = {
      commerceCourse: {
        findUnique: jest.fn().mockResolvedValue({ code: 'C001' }),
      },
      coursePackageJob: {
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const publishing = {
      assertExportable: jest.fn().mockResolvedValue(exportable),
    };
    const config = {
      packageMaxBytes: 8 * GB,
      packageDirectUploadBytes: 200 * MB,
    };
    const svc = new PackageJobsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      publishing as never,
      config as never,
    );
    return { svc, prisma, publishing };
  }

  it('defaults to the live version returned by assertExportable', async () => {
    const { svc, prisma, publishing } = make();
    const result = await svc.startExport('course-1', null);
    expect(publishing.assertExportable).toHaveBeenCalledWith('course-1');
    expect(result).toMatchObject({
      status: 'EXPORTING',
      versionId: 'v-live',
      versionLabel: '2.1',
      fileName: 'C001_2.1.zip',
    });
    const calls = prisma.coursePackageJob.create.mock.calls as unknown as Array<
      [{ data: Record<string, unknown> }]
    >;
    const data = calls[0][0].data;
    expect(data).toMatchObject({
      kind: 'EXPORT',
      status: 'EXPORTING',
      courseId: 'course-1',
      sourceVersionId: 'v-live',
      fileLabel: 'C001_2.1.zip',
    });
  });

  it('rejects draft and specific-version selectors before creating a job', async () => {
    for (const body of [
      { version: 'working' },
      { version: 'draft' },
      { version: 'version:1' },
      { version: '1.1' },
      { versionId: '11111111-1111-1111-1111-111111111111' },
      { sourceVersion: 'live' },
    ]) {
      const { svc, prisma, publishing } = make();
      await expect(
        svc.startExport('course-1', null, body),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 400 });
      expect(prisma.coursePackageJob.create).not.toHaveBeenCalled();
      expect(publishing.assertExportable).not.toHaveBeenCalled();
    }
  });

  it('keeps the 3-step export gate: an unpublished live version is refused', async () => {
    const { svc, prisma, publishing } = make();
    publishing.assertExportable.mockRejectedValue({
      code: 'EXPORT_REQUIRES_LIVE_VERSION',
      httpStatus: 409,
    });
    await expect(svc.startExport('course-1', null, {})).rejects.toMatchObject({
      code: 'EXPORT_REQUIRES_LIVE_VERSION',
    });
    expect(prisma.coursePackageJob.create).not.toHaveBeenCalled();
  });
});

describe('PackageJobsService — staging 存储故障（导入同步链路）', () => {
  const STORAGE_MESSAGE =
    '课程存储不可用，请联系运维检查课程存储桶与实例角色权限';

  function make() {
    const prisma = {
      coursePackageJob: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const storage = {
      stagingKey: (jobId: string, name: string) => `${jobId}/${name}`,
      putStaging: jest.fn().mockResolvedValue(undefined),
      hasStaging: jest.fn().mockResolvedValue(true),
      getStaging: jest.fn(),
      removeStaging: jest.fn().mockResolvedValue(undefined),
    };
    const config = {
      packageMaxBytes: 8 * GB,
      packageDirectUploadBytes: 200 * MB,
    };
    const svc = new PackageJobsService(
      prisma as never,
      storage as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      config as never,
    );
    return { svc, prisma, storage };
  }

  /** 与线上 NoSuchBucket 同形的 S3 SDK 错误（非 HttpException）。 */
  function noSuchBucket(): Error {
    return Object.assign(new Error('The specified bucket does not exist'), {
      name: 'NoSuchBucket',
      $metadata: { httpStatusCode: 404 },
    });
  }

  /** 走真实的全局异常过滤器，断言最终 HTTP 响应。 */
  function renderThroughFilter(error: unknown): {
    status: number;
    body: Record<string, unknown>;
  } {
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn<void, [Record<string, unknown>]>(),
    };
    const host = {
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as ArgumentsHost;
    new AllExceptionsFilter().catch(error, host);
    const statusCalls = response.status.mock.calls as unknown as Array<
      [number]
    >;
    return {
      status: statusCalls[0][0],
      body: response.json.mock.calls[0][0],
    };
  }

  let errorSpy: jest.SpyInstance<
    void,
    [message: unknown, ...optionalParams: unknown[]]
  >;

  beforeEach(() => {
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('把课程包直传 putStaging 的 S3 故障映射为 503 + STORAGE_UNAVAILABLE（不再 500 服务器内部错误）', async () => {
    const { svc, storage } = make();
    const storageError = noSuchBucket();
    storage.putStaging.mockRejectedValue(storageError);

    let caught: unknown;
    try {
      await svc.createImportJob(
        { name: 'European civilisation.zip', bytes: Buffer.from('zip-bytes') },
        null,
      );
    } catch (error) {
      caught = error;
    }

    const { status, body } = renderThroughFilter(caught);
    expect(status).toBe(503);
    expect(body).toEqual({
      success: false,
      data: null,
      error: {
        code: 'STORAGE_UNAVAILABLE',
        message: STORAGE_MESSAGE,
      },
    });

    // 响应不泄露桶名/凭证/SDK 错误；原始错误栈只进服务器日志
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('bucket');
    expect(serialised).not.toContain('NoSuchBucket');
    expect(serialised).not.toContain('AWS');
    expect(
      errorSpy.mock.calls.some((call) => call[1] === storageError.stack),
    ).toBe(true);
  });

  it('把原始素材分块 PUT 的 putStaging 故障映射为 503 + STORAGE_UNAVAILABLE', async () => {
    const { svc, prisma, storage } = make();
    prisma.coursePackageJob.findUnique.mockResolvedValue({
      id: 'j1',
      stage: 'UPLOADING',
      bytesTotal: 10,
      requestId: null,
    });
    storage.putStaging.mockRejectedValue(noSuchBucket());

    await expect(
      svc.appendRawChunk('j1', 0, Buffer.from('chunk')),
    ).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      httpStatus: 503,
      message: STORAGE_MESSAGE,
    });
  });

  it('把单次原始素材 POST 的 putStaging 故障映射为 503 + STORAGE_UNAVAILABLE', async () => {
    const { svc, storage } = make();
    storage.putStaging.mockRejectedValue(noSuchBucket());

    await expect(
      svc.createRawImportJob(
        { name: 'raw.zip', bytes: Buffer.from('raw') },
        null,
      ),
    ).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      httpStatus: 503,
      message: STORAGE_MESSAGE,
    });
  });

  it('complete 阶段 hasStaging 探测失败时返回 503，而不是误报 400 Missing chunk', async () => {
    const { svc, prisma, storage } = make();
    prisma.coursePackageJob.findUnique.mockResolvedValue({
      id: 'j1',
      stage: 'UPLOADING',
      bytesTotal: 10,
      requestId: null,
    });
    storage.hasStaging.mockRejectedValue(noSuchBucket());

    await expect(svc.completeRawUpload('j1')).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      httpStatus: 503,
      message: STORAGE_MESSAGE,
    });
  });

  it('课程包分块 complete 的 hasStaging 故障同样返回 503', async () => {
    const { svc, prisma, storage } = make();
    prisma.coursePackageJob.findUnique.mockResolvedValue({
      id: 'j1',
      stage: 'UPLOADING_PACKAGE',
      bytesTotal: 10,
      requestId: null,
    });
    storage.hasStaging.mockRejectedValue(noSuchBucket());

    await expect(svc.completePackageUpload('j1')).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      httpStatus: 503,
      message: STORAGE_MESSAGE,
    });
  });

  it('分块确实缺失时仍保持 400 RAW_UPLOAD_INCOMPLETE（不弱化既有校验）', async () => {
    const { svc, prisma, storage } = make();
    prisma.coursePackageJob.findUnique.mockResolvedValue({
      id: 'j1',
      stage: 'UPLOADING',
      bytesTotal: 10,
      requestId: null,
    });
    storage.hasStaging.mockResolvedValue(false);

    await expect(svc.completeRawUpload('j1')).rejects.toMatchObject({
      code: 'RAW_UPLOAD_INCOMPLETE',
      httpStatus: 400,
    });
  });
});

describe('sandbox invalid-live recovery access', () => {
  const originalEnv = process.env.APP_ENV;
  afterEach(() => { if (originalEnv === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = originalEnv; });
  it('rejects outside Sandbox or without an explicit reason before loading a job', async () => {
    const jobs = new PackageJobsService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, { sandboxResetEnabled: true } as never);
    process.env.APP_ENV = 'PROD';
    await expect(jobs.recoverInvalidLiveImport('j1', 'reason', 'admin')).rejects.toMatchObject({code: 'RECOVERY_DISABLED'});
    process.env.APP_ENV = 'SANDBOX';
    await expect(jobs.recoverInvalidLiveImport('j1', '', 'admin')).rejects.toMatchObject({code: 'RECOVERY_REASON_REQUIRED'});
  });
});
