import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CommerceCourseConfig } from './commerce.config';
import { CourseStorageService, isObjectNotFoundError } from './storage.service';

function config(
  overrides: Partial<CommerceCourseConfig>,
): CommerceCourseConfig {
  return {
    mediaRoot: '/tmp/lg-media',
    packageStagingRoot: '/tmp/lg-staging',
    ...overrides,
  } as unknown as CommerceCourseConfig;
}

describe('isObjectNotFoundError', () => {
  it('只把对象确实不存在（NotFound / NoSuchKey）判定为 false 的依据', () => {
    expect(
      isObjectNotFoundError(
        Object.assign(new Error('x'), { name: 'NotFound' }),
      ),
    ).toBe(true);
    expect(
      isObjectNotFoundError(
        Object.assign(new Error('x'), { name: 'NoSuchKey' }),
      ),
    ).toBe(true);
    expect(
      isObjectNotFoundError(
        Object.assign(new Error('x'), { Code: 'NoSuchKey' }),
      ),
    ).toBe(true);
    expect(
      isObjectNotFoundError(
        Object.assign(new Error('x'), { code: 'NoSuchKey' }),
      ),
    ).toBe(true);
  });

  it('桶不存在 / 无权限 / 网络错误不能被当成“对象不存在”', () => {
    // NoSuchBucket 同样常带 HTTP 404，因此不能按状态码判定
    expect(
      isObjectNotFoundError(
        Object.assign(new Error('x'), {
          name: 'NoSuchBucket',
          $metadata: { httpStatusCode: 404 },
        }),
      ),
    ).toBe(false);
    expect(
      isObjectNotFoundError(
        Object.assign(new Error('x'), {
          name: 'AccessDenied',
          $metadata: { httpStatusCode: 403 },
        }),
      ),
    ).toBe(false);
    expect(
      isObjectNotFoundError(
        Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED',
        }),
      ),
    ).toBe(false);
    expect(isObjectNotFoundError(new Error('boom'))).toBe(false);
    expect(isObjectNotFoundError(null)).toBe(false);
  });
});

describe('CourseStorageService.hasStaging — 本地驱动', () => {
  it('对象缺失返回 false；非法 key 等存储错误必须上抛', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-storage-spec-'));
    try {
      const svc = new CourseStorageService(
        config({ mediaRoot: root, packageStagingRoot: root }),
      );
      await expect(svc.hasStaging('missing/file.bin')).resolves.toBe(false);
      // 修复前这里会被吞成 false，让导入 complete 误报 400 Missing chunk
      await expect(svc.hasStaging('../escape')).rejects.toThrow(
        /Illegal storage key/,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('CourseStorageService.hasStaging — S3 驱动', () => {
  it('对象缺失返回 false；NoSuchBucket / AccessDenied 必须上抛', async () => {
    const svc = new CourseStorageService(
      config({ mediaBucket: 'lg-test-bucket', mediaPrefix: '' }),
    );
    const staging = (
      svc as unknown as {
        staging: { client: { send: (command: unknown) => Promise<unknown> } };
      }
    ).staging;
    const send = jest.spyOn(staging.client, 'send');

    send.mockRejectedValueOnce(
      Object.assign(new Error('NotFound'), {
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      }),
    );
    await expect(svc.hasStaging('missing.bin')).resolves.toBe(false);

    const noSuchBucket = Object.assign(
      new Error('The specified bucket does not exist'),
      { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } },
    );
    send.mockRejectedValueOnce(noSuchBucket);
    await expect(svc.hasStaging('chunk/0')).rejects.toBe(noSuchBucket);

    const accessDenied = Object.assign(new Error('Access Denied'), {
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    });
    send.mockRejectedValueOnce(accessDenied);
    await expect(svc.hasStaging('chunk/1')).rejects.toBe(accessDenied);
  });
});
