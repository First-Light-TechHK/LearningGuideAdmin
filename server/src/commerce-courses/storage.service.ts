import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
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
  has(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
  removePrefix(prefix: string): Promise<void>;
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

  async has(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async remove(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  async removePrefix(prefix: string): Promise<void> {
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

  async has(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.k(key) }),
      );
      return true;
    } catch {
      return false;
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
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: objects },
          }),
        );
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

  hasMedia(key: string): Promise<boolean> {
    return this.media.has(key);
  }

  removeMedia(key: string): Promise<void> {
    return this.media.remove(key);
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

  static sha256(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
  }
}
