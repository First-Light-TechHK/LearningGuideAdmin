import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { COMMERCE_CONFIG, type CommerceCourseConfig } from './commerce.config';

/**
 * 课程媒体与课程包的私有文件存储（P1a 使用本地文件系统）。
 * 生产多实例应替换为 S3 {@link StorageDriver}；接口保持不变（见设计文档 §5.7/§19.5）。
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
    if (!path.resolve(full).startsWith(rootAbs + path.sep) && path.resolve(full) !== rootAbs) {
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

@Injectable()
export class CourseStorageService {
  private readonly logger = new Logger(CourseStorageService.name);
  private readonly media: StorageDriver;
  private readonly staging: StorageDriver;

  constructor(@Inject(COMMERCE_CONFIG) private readonly config: CommerceCourseConfig) {
    this.media = new LocalDriver(path.resolve(config.mediaRoot));
    this.staging = new LocalDriver(path.resolve(config.packageStagingRoot));
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
