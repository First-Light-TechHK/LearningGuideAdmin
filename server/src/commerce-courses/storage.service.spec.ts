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
    ).toBe(false);
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
      await fs.writeFile(path.join(root, 'not-a-directory'), 'x');
      await expect(svc.hasStaging('not-a-directory/chunk')).rejects.toMatchObject({code: 'ENOTDIR'});
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
    send.mockResolvedValueOnce({}); // HeadBucket confirms the bucket exists.
    await expect(svc.hasStaging('missing.bin')).resolves.toBe(false);
    send.mockRejectedValueOnce(Object.assign(new Error('NotFound'), { name: 'NotFound' }));
    send.mockRejectedValueOnce(Object.assign(new Error('NoSuchBucket'), { name: 'NoSuchBucket' }));
    await expect(svc.hasStaging('ambiguous.bin')).rejects.toThrow('NoSuchBucket');

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

describe('Sandbox media cleanup', () => {
  it('removes course-media orphans while preserving neighbouring files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-media-clean-'));
    try {
      const svc = new CourseStorageService(config({ mediaRoot: root, packageStagingRoot: path.join(root, 'staging') }));
      await svc.putMedia('course-media/orphan/file.bin', Buffer.from('orphan'));
      await svc.putMedia('course-media-unrelated/keep.bin', Buffer.from('keep'));
      await svc.clearCourseMediaRoot();
      expect(await svc.hasMedia('course-media/orphan/file.bin')).toBe(false);
      expect(await svc.hasMedia('course-media-unrelated/keep.bin')).toBe(true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('fails if S3 reports per-object deletion errors', async () => {
    const svc = new CourseStorageService(config({ mediaBucket: 'test', mediaPrefix: 'sandbox/' }));
    const driver = (svc as unknown as { media: { client: { send: (command: unknown) => Promise<unknown> } } }).media;
    const send = jest.spyOn(driver.client, 'send');
    send.mockResolvedValueOnce({ Contents: [{ Key: 'sandbox/course-media/a' }] });
    send.mockResolvedValueOnce({ Errors: [{ Key: 'sandbox/course-media/a', Code: 'AccessDenied' }] });
    await expect(svc.clearCourseMediaRoot()).rejects.toThrow(/delete/i);
  });
});

describe('Sandbox staging cleanup safety', () => {
  it.each(['/', '/tmp/media', '/tmp/media/sub'])('refuses a dangerous local staging root %s', async (stagingRoot) => {
    const svc = new CourseStorageService(config({ mediaRoot: '/tmp/media', packageStagingRoot: stagingRoot }));
    const driver = (svc as unknown as { staging: { removePrefix: (prefix: string) => Promise<void> } }).staging;
    const remove = jest.spyOn(driver, 'removePrefix').mockResolvedValue();
    await expect(svc.clearStagingRoot()).rejects.toThrow(/refus/i);
    expect(remove).not.toHaveBeenCalled();
  });
  it('refuses a staging path reached through a symlink', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-reset-symlink-'));
    try {
      await fs.mkdir(path.join(root, 'media'));
      await fs.symlink(path.join(root, 'media'), path.join(root, 'alias'));
      const svc = new CourseStorageService(config({ mediaRoot: path.join(root, 'media'), packageStagingRoot: path.join(root, 'alias', 'stage') }));
      const driver = (svc as unknown as { staging: { removePrefix: (prefix: string) => Promise<void> } }).staging;
      const remove = jest.spyOn(driver, 'removePrefix').mockResolvedValue();
      await expect(svc.clearStagingRoot()).rejects.toThrow(/refus/i);
      expect(remove).not.toHaveBeenCalled();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('refuses overlapping namespaces in the same S3 bucket', async () => {
    const svc = new CourseStorageService(config({ mediaBucket: 'test', stagingBucket: 'test', mediaPrefix: 'sandbox/', stagingPrefix: 'sandbox/course-media/' }));
    const driver = (svc as unknown as { staging: { removePrefix: (prefix: string) => Promise<void> } }).staging;
    const remove = jest.spyOn(driver, 'removePrefix').mockResolvedValue();
    await expect(svc.clearStagingRoot()).rejects.toThrow(/refus/i);
    expect(remove).not.toHaveBeenCalled();
  });
});
