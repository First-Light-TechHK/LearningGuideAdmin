import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { COMMERCE_CONFIG, type CommerceCourseConfig } from './commerce.config';
import { CourseAuthoringService } from './course-authoring.service';
import { CourseStorageService } from './storage.service';
import {
  MediaValidationError,
  describeMediaUpload,
  type MediaDescriptor,
} from './media-validate';

type SessionPhase = 'UPLOADING' | 'PROCESSING';

interface MediaUploadSession {
  id: string;
  courseId: string;
  fileName: string;
  bytesTotal: number;
  descriptor: MediaDescriptor;
  chunks: Map<number, number>;
  receivedBytes: number;
  phase: SessionPhase;
  createdAt: number;
  updatedAt: number;
}

export interface MediaSessionView {
  sessionId: string;
  chunkSize: number;
  bytesTotal: number;
  bytesReceived: number;
  progress: number;
  phase: SessionPhase;
  fileName: string;
  maxBytes: number;
  chunkIndices: number[];
}

/**
 * 课时媒体（视频/封面/展品）分块上传。
 *
 * 为什么需要：单次 multipart 直传 100MB+ 的视频，会在 CloudFront / App Runner
 * 出入口被中途切断或长时间无响应（前端只看到“没有任何反应”）。这里按 5MB 切块，
 * 每块都是小请求，前端能拿到真实进度、失败可重试、可取消；服务端也不再把整份
 * 视频塞进 multer 内存。
 *
 * 会话保存在进程内（服务器重启后会话失效，前端重新上传即可），分块落在
 * staging 存储（本地目录或 S3），完成时合并、校验签名并登记为媒体资产。
 */
@Injectable()
export class MediaUploadService {
  private readonly logger = new Logger(MediaUploadService.name);
  static readonly CHUNK_BYTES = 5 * 1024 * 1024;
  private static readonly CHUNK_SLACK_BYTES = 1024;
  private static readonly SESSION_TTL_MS = 6 * 60 * 60 * 1000;
  private readonly sessions = new Map<string, MediaUploadSession>();

  constructor(
    private readonly authoring: CourseAuthoringService,
    private readonly storage: CourseStorageService,
    @Inject(COMMERCE_CONFIG) private readonly config: CommerceCourseConfig,
  ) {}

  private chunkKey(sessionId: string, index: number): string {
    return this.storage.stagingKey(
      `media-session-${sessionId}`,
      `chunk/${index}`,
    );
  }

  private chunkCountFor(session: MediaUploadSession): number {
    return Math.max(
      1,
      Math.ceil(session.bytesTotal / MediaUploadService.CHUNK_BYTES),
    );
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.updatedAt < MediaUploadService.SESSION_TTL_MS) continue;
      this.sessions.delete(id);
      void this.storage
        .clearStagingPrefix(`media-session-${id}`)
        .catch(() => undefined);
    }
  }

  private requireSession(
    courseId: string,
    sessionId: string,
  ): MediaUploadSession {
    this.purgeExpired();
    const session = this.sessions.get(sessionId);
    if (!session || session.courseId !== courseId) {
      throw new NotFoundException({
        code: 'UPLOAD_SESSION_NOT_FOUND',
        message: 'Upload session not found or expired. Upload the file again.',
      });
    }
    return session;
  }

  private view(session: MediaUploadSession): MediaSessionView {
    const expected = this.chunkCountFor(session);
    return {
      sessionId: session.id,
      chunkSize: MediaUploadService.CHUNK_BYTES,
      bytesTotal: session.bytesTotal,
      bytesReceived: session.receivedBytes,
      progress: Math.min(
        99,
        Math.round(
          (session.receivedBytes / Math.max(1, session.bytesTotal)) * 100,
        ),
      ),
      phase: session.phase,
      fileName: session.fileName,
      maxBytes: session.descriptor.maxBytes,
      chunkIndices: [...session.chunks.keys()]
        .sort((a, b) => a - b)
        .slice(0, expected),
    };
  }

  /** 各类型媒体单文件上限（字节）：前端用于在选文件前展示，服务端仍以同一份配置校验。 */
  limits() {
    return {
      imageBytes: this.config.maxImageBytes,
      videoBytes: this.config.maxVideoBytes,
      audioBytes: this.config.maxAudioBytes,
      pdfBytes: this.config.maxPdfBytes,
      modelBytes: this.config.maxModelBytes,
      chunkSize: MediaUploadService.CHUNK_BYTES,
    };
  }

  /** 开会话：先按扩展名与总大小做前置校验，避免用户白传几百 MB 才被拒绝。 */
  async createSession(
    courseId: string,
    body: { fileName?: string; bytesTotal?: number },
  ): Promise<MediaSessionView> {
    this.purgeExpired();
    await this.authoring.ensureCourseExists(courseId);
    const fileName = (body?.fileName ?? '').trim();
    const bytesTotal = Number(body?.bytesTotal);
    let descriptor: MediaDescriptor;
    try {
      descriptor = describeMediaUpload(
        { name: fileName, bytesTotal },
        this.config,
      );
    } catch (error) {
      if (error instanceof MediaValidationError) {
        const code =
          error.code === 'too_large' ? 'MEDIA_TOO_LARGE' : 'MEDIA_INVALID';
        throw new BadRequestException({ code, message: error.message });
      }
      throw error;
    }
    const session: MediaUploadSession = {
      id: randomUUID(),
      courseId,
      fileName,
      bytesTotal,
      descriptor,
      chunks: new Map(),
      receivedBytes: 0,
      phase: 'UPLOADING',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.sessions.set(session.id, session);
    return this.view(session);
  }

  status(courseId: string, sessionId: string): MediaSessionView {
    return this.view(this.requireSession(courseId, sessionId));
  }

  /** 写入单块（可重复写同一 index，用于前端重试；大小不符直接拒绝）。 */
  async appendChunk(
    courseId: string,
    sessionId: string,
    index: number,
    bytes: Buffer | undefined,
  ): Promise<MediaSessionView> {
    const session = this.requireSession(courseId, sessionId);
    if (session.phase !== 'UPLOADING') {
      throw new BadRequestException({
        code: 'UPLOAD_NOT_ACTIVE',
        message: 'This upload is already being processed.',
      });
    }
    if (!bytes?.length) {
      throw new BadRequestException({
        code: 'CHUNK_REQUIRED',
        message: 'No chunk uploaded.',
      });
    }
    const chunkIndex = Number(index);
    const expected = this.chunkCountFor(session);
    if (
      !Number.isInteger(chunkIndex) ||
      chunkIndex < 0 ||
      chunkIndex >= expected
    ) {
      throw new BadRequestException({
        code: 'INVALID_CHUNK_INDEX',
        message: `Chunk index must be between 0 and ${expected - 1}.`,
      });
    }
    if (
      bytes.length >
      MediaUploadService.CHUNK_BYTES + MediaUploadService.CHUNK_SLACK_BYTES
    ) {
      throw new BadRequestException({
        code: 'CHUNK_TOO_LARGE',
        message: 'Chunk is larger than the agreed chunk size.',
      });
    }
    const offset = chunkIndex * MediaUploadService.CHUNK_BYTES;
    const expectedLength = Math.min(
      MediaUploadService.CHUNK_BYTES,
      session.bytesTotal - offset,
    );
    if (bytes.length !== expectedLength) {
      throw new BadRequestException({
        code: 'CHUNK_SIZE_MISMATCH',
        message: `Chunk ${chunkIndex} should be ${expectedLength} bytes.`,
      });
    }
    await this.storage.putStaging(this.chunkKey(session.id, chunkIndex), bytes);
    const previous = session.chunks.get(chunkIndex) ?? 0;
    session.chunks.set(chunkIndex, bytes.length);
    session.receivedBytes += bytes.length - previous;
    session.updatedAt = Date.now();
    return this.view(session);
  }

  /**
   * 合并并登记媒体资产。视频文件较大，合并 + 校验放在这个请求里完成；
   * 前端此时已把进度切到“处理中”，失败会给出可读错误。
   */
  async complete(courseId: string, sessionId: string) {
    const session = this.requireSession(courseId, sessionId);
    if (session.phase !== 'UPLOADING') {
      throw new BadRequestException({
        code: 'UPLOAD_NOT_ACTIVE',
        message: 'This upload is already being processed.',
      });
    }
    const expected = this.chunkCountFor(session);
    for (let i = 0; i < expected; i++) {
      if (!session.chunks.has(i)) {
        throw new BadRequestException({
          code: 'UPLOAD_INCOMPLETE',
          message: `Missing chunk ${i + 1}/${expected}. Retry the upload.`,
        });
      }
    }
    if (session.receivedBytes !== session.bytesTotal) {
      throw new BadRequestException({
        code: 'UPLOAD_INCOMPLETE',
        message: 'Uploaded bytes do not match the file size. Retry the upload.',
      });
    }
    session.phase = 'PROCESSING';
    session.updatedAt = Date.now();
    try {
      // 逐块拷进一整块预分配 Buffer：避免同时持有「所有分块 + 拼接结果」两倍内存。
      const buffer = Buffer.allocUnsafe(session.bytesTotal);
      let offset = 0;
      for (let i = 0; i < expected; i++) {
        const part = await this.storage.getStaging(
          this.chunkKey(session.id, i),
        );
        part.copy(buffer, offset);
        offset += part.length;
      }
      if (offset !== session.bytesTotal) {
        throw new BadRequestException({
          code: 'UPLOAD_INCOMPLETE',
          message: 'Assembled file size does not match. Retry the upload.',
        });
      }
      const asset = await this.authoring.uploadMedia(courseId, {
        originalname: session.fileName,
        mimetype: session.descriptor.mimeType,
        buffer,
      });
      return asset;
    } finally {
      // 成功或失败都释放会话与分块；失败时需要重新上传整份文件（分块已清理）。
      this.sessions.delete(session.id);
      await this.storage
        .clearStagingPrefix(`media-session-${session.id}`)
        .catch((error: unknown) => {
          this.logger.warn(
            `清理上传分块失败：${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
  }

  async cancel(
    courseId: string,
    sessionId: string,
  ): Promise<{ cancelled: true }> {
    const session = this.sessions.get(sessionId);
    if (session && session.courseId === courseId) {
      this.sessions.delete(sessionId);
    }
    await this.storage
      .clearStagingPrefix(`media-session-${sessionId}`)
      .catch(() => undefined);
    return { cancelled: true };
  }
}
