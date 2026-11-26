import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { COMMERCE_CONFIG, type CommerceCourseConfig } from './commerce.config';

/**
 * 课程媒体与课程包的私有文件存储。
 * 生产用 S3 私有桶（COURSE_MEDIA_BUCKET / COURSE_PACKAGE_BUCKET），
 * 未配置桶时回退到本地文件系统（开发）。接口保持不变（见设计文档 §5.7/§19.5）。
 */
export interface StorageDriver {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** 读取一段字节（视频 Range 请求用，避免整份文件读进内存）。 */
  getRange(key: string, start: number, length: number): Promise<Buffer>;
  /** 对象字节数；不存在返回 null。 */
  size(key: string): Promise<number | null>;
  /** 对象是否存在；只有“确实不存在”才返回 false，基础设施故障必须抛出。 */
  has(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
  removePrefix(prefix: string): Promise<void>;
}

/**
 * HeadObject 错误的判定：只有“对象确实不存在”才算 false。
 * NoSuchBucket / AccessDenied / 凭证 / 网络错误同样是 HeadObject 的失败，
 * 但它们是存储不可用，不能伪装成“对象不存在”——否则导入 complete 会把
 * 存储故障误报成 400「Missing chunk」。
 * 注意：NoSuchBucket 也常带 HTTP 404，所以不能按状态码判定。
 */
export function isObjectNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { name?: unknown; Code?: unknown; code?: unknown };
  return (
    e.name === 'NoSuchKey' ||
    e.Code === 'NoSuchKey' ||
    e.code === 'NoSuchKey'
  );
}

async function resolvedExistingPath(target: string): Promise<string> {
  let current = path.resolve(target);
  const missing: string[] = [];
  for (;;) {
    try { return path.join(await fs.realpath(current), ...missing.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

class LocalDriver implements StorageDriver {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    const normalised = key.replace(/\\/g, '/').replace(/^\/+/, '');
    if (normalised.split('/').some((seg) => seg === '..' || seg === '')) {
      throw new Error(`Illegal storage key: ${key}`);
    }
    const full = path.join(this.root, normalised);
    const rootAbs = path.resolve(this.root);
    if (
      !path.resolve(full).startsWith(rootAbs + path.sep) &&
      path.resolve(full) !== rootAbs
    ) {
      throw new Error(`Storage key escapes root: ${key}`);
    }
    return full;
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, bytes);
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
  }

  async getRange(key: string, start: number, length: number): Promise<Buffer> {
    const full = this.resolve(key);
    const handle = await fs.open(full, 'r');
    try {
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async size(key: string): Promise<number | null> {
    try {
      const info = await fs.stat(this.resolve(key));
      return info.size;
    } catch {
      return null;
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch (error) {
      // 只有“确实不存在”才返回 false；EACCES/ENOSPC/非法 key 等是存储故障，必须上抛。
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') return false;
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  async removePrefix(prefix: string): Promise<void> {
    // 空前缀 = 清空整个 staging 根（Sandbox 重置专用）；其余前缀仍走安全解析。
    if (prefix === '') {
      await fs.rm(path.resolve(this.root), { recursive: true, force: true });
      return;
    }
    await fs.rm(this.resolve(prefix), { recursive: true, force: true });
  }
}

class S3Driver implements StorageDriver {
  private readonly client: S3Client;
  constructor(
    private readonly bucket: string,
    private readonly prefix: string,
    region: string,
    endpoint?: string,
    forcePathStyle?: boolean,
  ) {
    this.client = new S3Client({
      region,
      ...(endpoint ? { endpoint } : {}),
      ...(forcePathStyle ? { forcePathStyle: true } : {}),
    });
  }

  private k(key: string): string {
    return `${this.prefix}${key.replace(/^\/+/, '')}`;
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.k(key),
        Body: bytes,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const out = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.k(key) }),
    );
    const body = out.Body as
      { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
    if (!body) throw new Error(`Empty S3 body for ${key}`);
    if (typeof body.transformToByteArray === 'function') {
      return Buffer.from(await body.transformToByteArray());
    }
    // 兜底：流式读取
    const chunks: Buffer[] = [];
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async getRange(key: string, start: number, length: number): Promise<Buffer> {
    const out = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.k(key),
        Range: `bytes=${start}-${start + length - 1}`,
      }),
    );
    const body = out.Body as
      { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
    if (!body) throw new Error(`Empty S3 body for ${key}`);
    if (typeof body.transformToByteArray === 'function') {
      return Buffer.from(await body.transformToByteArray());
    }
    const chunks: Buffer[] = [];
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async size(key: string): Promise<number | null> {
    try {
      const out = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.k(key) }),
      );
      return typeof out.ContentLength === 'number' ? out.ContentLength : null;
    } catch {
      return null;
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.k(key) }),
      );
      return true;
    } catch (error) {
      // NoSuchBucket/AccessDenied/凭证/网络错误不能被当成“对象不存在”
      if (isObjectNotFoundError(error)) return false;
      // HeadObject's generic 404 may mean either a missing key or a missing bucket.
      // Only treat it as a missing key after the bucket itself is confirmed reachable.
      if (typeof error === 'object' && error !== null && (error as { name?: string }).name === 'NotFound') {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
        return false;
      }
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.k(key) }),
    );
  }

  async removePrefix(prefix: string): Promise<void> {
    let token: string | undefined;
    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.k(prefix),
          ContinuationToken: token,
        }),
      );
      const objects = (listed.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => Boolean(k))
        .map((k) => ({ Key: k }));
      if (objects.length > 0) {
        const deleted = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: objects },
          }),
        );
        if (deleted.Errors?.length) throw new Error(`S3 delete failed for ${deleted.Errors.length} object(s)`);
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
  }
}

@Injectable()
export class CourseStorageService {
  private readonly logger = new Logger(CourseStorageService.name);
  private readonly media: StorageDriver;
  private readonly staging: StorageDriver;

  constructor(
    @Inject(COMMERCE_CONFIG) private readonly config: CommerceCourseConfig,
  ) {
    const region = config.awsRegion ?? 'ap-southeast-1';
    const forcePathStyle = config.s3ForcePathStyle ?? false;
    if (config.mediaBucket) {
      this.media = new S3Driver(
        config.mediaBucket,
        config.mediaPrefix ?? '',
        region,
        config.s3Endpoint,
        forcePathStyle,
      );
      const stagingBucket = config.stagingBucket ?? config.mediaBucket;
      this.staging = new S3Driver(
        stagingBucket,
        config.stagingPrefix ?? 'staging/',
        region,
        config.s3Endpoint,
        forcePathStyle,
      );
      this.logger.log(
        `Course media storage: S3 (media=${config.mediaBucket}, staging=${stagingBucket})`,
      );
    } else {
      this.media = new LocalDriver(path.resolve(config.mediaRoot));
      this.staging = new LocalDriver(path.resolve(config.packageStagingRoot));
      this.logger.log(`Course media storage: local (${config.mediaRoot})`);
    }
  }

  // ===== 课程媒体 =====
  mediaKey(courseId: string, assetId: string, extension: string): string {
    return `course-media/${courseId}/${assetId}.${extension}`;
  }

  putMedia(key: string, bytes: Buffer): Promise<void> {
    return this.media.put(key, bytes);
  }

  getMedia(key: string): Promise<Buffer> {
    return this.media.get(key);
  }

  getMediaRange(key: string, start: number, length: number): Promise<Buffer> {
    return this.media.getRange(key, start, length);
  }

  mediaSize(key: string): Promise<number | null> {
    return this.media.size(key);
  }

  hasMedia(key: string): Promise<boolean> {
    return this.media.has(key);
  }

  removeMedia(key: string): Promise<void> {
    return this.media.remove(key);
  }

  /** Remove the course-media namespace including objects without database rows. */
  clearCourseMediaRoot(): Promise<void> {
    return this.media.removePrefix(this.config.mediaBucket ? 'course-media/' : 'course-media');
  }

  // ===== 课程包 staging =====
  stagingKey(jobId: string, name: string): string {
    return `${jobId}/${name}`;
  }

  putStaging(key: string, bytes: Buffer): Promise<void> {
    return this.staging.put(key, bytes);
  }

  getStaging(key: string): Promise<Buffer> {
    return this.staging.get(key);
  }

  hasStaging(key: string): Promise<boolean> {
    return this.staging.has(key);
  }

  removeStaging(key: string): Promise<void> {
    return this.staging.remove(key);
  }

  clearStagingPrefix(jobId: string): Promise<void> {
    return this.staging.removePrefix(jobId);
  }

  /**
   * 清空整个课程包 staging 根（Sandbox 课程内容重置用）。
   * 只在 Sandbox 的专用桶/专用根目录上调用；前缀为空时明确拒绝，避免误删整桶或整个工作目录。
   */
  async assertStagingRootSafe(): Promise<void> {
    if (this.config.mediaBucket) {
      const stagingPrefix = (this.config.stagingPrefix ?? '').trim();
      const mediaPrefix = `${this.config.mediaPrefix ?? ''}course-media/`;
      const sameBucket = (this.config.stagingBucket ?? this.config.mediaBucket) === this.config.mediaBucket;
      if (!stagingPrefix || !stagingPrefix.endsWith('/') ||
          (sameBucket && (stagingPrefix.startsWith(mediaPrefix) || mediaPrefix.startsWith(stagingPrefix)))) {
        throw new Error('Refusing to clear an unsafe or overlapping staging bucket prefix');
      }
    } else {
      const staging = await resolvedExistingPath(this.config.packageStagingRoot);
      const media = await resolvedExistingPath(this.config.mediaRoot);
      const cwd = await resolvedExistingPath(process.cwd());
      if (staging === path.parse(staging).root || staging === cwd || cwd.startsWith(staging + path.sep) ||
          staging === media || staging.startsWith(media + path.sep) || media.startsWith(staging + path.sep)) {
        throw new Error('Refusing to clear an unsafe or overlapping staging directory');
      }
    }
  }

  async clearStagingRoot(): Promise<void> {
    await this.assertStagingRootSafe();
    await this.staging.removePrefix('');
  }

  /** 只读诊断：返回当前生效的存储驱动信息（不含密钥），用于确认是否用上 S3。 */
  describe(): {
    driver: 's3' | 'local';
    region?: string;
    bucket?: string;
    prefix?: string;
    stagingBucket?: string;
    stagingPrefix?: string;
    mediaRoot?: string;
    stagingRoot?: string;
    mediaKeyPattern?: string;
  } {
    if (this.config.mediaBucket) {
      return {
        driver: 's3',
        region: this.config.awsRegion ?? 'ap-southeast-1',
        bucket: this.config.mediaBucket,
        prefix: this.config.mediaPrefix ?? '',
        stagingBucket: this.config.stagingBucket ?? this.config.mediaBucket,
        stagingPrefix: this.config.stagingPrefix ?? 'staging/',
        mediaKeyPattern: `${this.config.mediaPrefix ?? ''}course-media/<courseId>/<assetId>.<ext>`,
      };
    }
    return {
      driver: 'local',
      mediaRoot: path.resolve(this.config.mediaRoot),
      stagingRoot: path.resolve(this.config.packageStagingRoot),
      mediaKeyPattern: 'course-media/<courseId>/<assetId>.<ext>',
    };
  }

  static sha256(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
  }
}
