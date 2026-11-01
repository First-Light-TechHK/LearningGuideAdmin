import { MediaUploadService } from './media-upload.service';
import type { CommerceCourseConfig } from './commerce.config';

const MB = 1024 * 1024;

function config(
  overrides: Partial<CommerceCourseConfig> = {},
): CommerceCourseConfig {
  return {
    maxVideoBytes: 50 * MB,
    maxImageBytes: 4 * MB,
    maxAudioBytes: 10 * MB,
    maxPdfBytes: 10 * MB,
    maxModelBytes: 5 * MB,
    ...overrides,
  } as CommerceCourseConfig;
}

function fakeStorage() {
  const files = new Map<string, Buffer>();
  return {
    files,
    stagingKey: (jobId: string, name: string) => `${jobId}/${name}`,
    putStaging: jest.fn((key: string, bytes: Buffer) => {
      files.set(key, bytes);
      return Promise.resolve();
    }),
    getStaging: jest.fn((key: string) =>
      Promise.resolve(files.get(key) as Buffer),
    ),
    hasStaging: jest.fn((key: string) => Promise.resolve(files.has(key))),
    clearStagingPrefix: jest.fn((prefix: string) => {
      for (const key of [...files.keys()])
        if (key.startsWith(prefix)) files.delete(key);
      return Promise.resolve();
    }),
  };
}

function fakeAuthoring() {
  return {
    ensureCourseExists: jest.fn(() => Promise.resolve()),
    uploadMedia: jest.fn(() =>
      Promise.resolve({ id: 'asset-1', kind: 'VIDEO' }),
    ),
  };
}

describe('MediaUploadService', () => {
  it('创建分块会话时按扩展名和大小提前拒绝，避免白传大文件', async () => {
    const service = new MediaUploadService(
      fakeAuthoring() as never,
      fakeStorage() as never,
      config(),
    );
    await expect(
      service.createSession('course-1', {
        fileName: 'clip.exe',
        bytesTotal: 1024,
      }),
    ).rejects.toMatchObject({ response: { code: 'MEDIA_INVALID' } });
    await expect(
      service.createSession('course-1', {
        fileName: 'clip.mp4',
        bytesTotal: 51 * MB,
      }),
    ).rejects.toMatchObject({ response: { code: 'MEDIA_TOO_LARGE' } });
  });

  it('逐块上传后合并成完整文件并登记媒体资产', async () => {
    const authoring = fakeAuthoring();
    const storage = fakeStorage();
    const service = new MediaUploadService(
      authoring as never,
      storage as never,
      config(),
    );
    const total = MediaUploadService.CHUNK_BYTES + 1024;
    const session = await service.createSession('course-1', {
      fileName: 'lesson.mp4',
      bytesTotal: total,
    });
    const first = Buffer.alloc(MediaUploadService.CHUNK_BYTES, 1);
    const second = Buffer.alloc(1024, 2);
    await service.appendChunk('course-1', session.sessionId, 0, first);
    const view = await service.appendChunk(
      'course-1',
      session.sessionId,
      1,
      second,
    );
    expect(view.progress).toBe(99);
    expect(view.bytesReceived).toBe(total);

    await service.complete('course-1', session.sessionId);
    const passed = (authoring.uploadMedia.mock.calls[0] as unknown[])[1] as {
      originalname: string;
      buffer: Buffer;
    };
    expect(passed.originalname).toBe('lesson.mp4');
    expect(passed.buffer.length).toBe(total);
    expect(passed.buffer.subarray(0, 4)).toEqual(Buffer.from([1, 1, 1, 1]));
    expect(storage.clearStagingPrefix).toHaveBeenCalled();
  });

  it('缺块时拒绝合并，并提示重试', async () => {
    const service = new MediaUploadService(
      fakeAuthoring() as never,
      fakeStorage() as never,
      config(),
    );
    const total = MediaUploadService.CHUNK_BYTES + 10;
    const session = await service.createSession('course-1', {
      fileName: 'lesson.mp4',
      bytesTotal: total,
    });
    await service.appendChunk(
      'course-1',
      session.sessionId,
      0,
      Buffer.alloc(MediaUploadService.CHUNK_BYTES, 1),
    );
    await expect(
      service.complete('course-1', session.sessionId),
    ).rejects.toMatchObject({
      response: { code: 'UPLOAD_INCOMPLETE' },
    });
  });

  it('取消会话后状态查询返回 404，并清理分块', async () => {
    const storage = fakeStorage();
    const service = new MediaUploadService(
      fakeAuthoring() as never,
      storage as never,
      config(),
    );
    const session = await service.createSession('course-1', {
      fileName: 'lesson.mp4',
      bytesTotal: 10,
    });
    await service.cancel('course-1', session.sessionId);
    expect(storage.clearStagingPrefix).toHaveBeenCalledWith(
      `media-session-${session.sessionId}`,
    );
    expect(() => service.status('course-1', session.sessionId)).toThrow();
  });
});
