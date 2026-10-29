import { ConfigService } from '@nestjs/config';

/**
 * Commerce Course 模块配置（带安全默认值）。环境变量见 docs/Course_Module_Import_Export_Design.md §19。
 */
export interface CommerceCourseConfig {
  mediaRoot: string;
  packageStagingRoot: string;
  maxImageBytes: number;
  maxVideoBytes: number;
  maxAudioBytes: number;
  maxPdfBytes: number;
  maxModelBytes: number;
  packageMaxBytes: number;
  packageDirectUploadBytes: number;
  packageExportTtlHours: number;
  jobConcurrency: number;
  jobPollMs: number;
  jobHeartbeatMs: number;
  jobStaleMs: number;
  jobMaxAttempts: number;
}

const MB = 1024 * 1024;

export function commerceConfig(config: ConfigService): CommerceCourseConfig {
  const num = (key: string, fallback: number): number => {
    const raw = config.get<string>(key);
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    mediaRoot:
      config.get<string>('COURSE_MEDIA_ROOT')?.trim() ||
      'storage/course-media',
    packageStagingRoot:
      config.get<string>('COURSE_PACKAGE_ROOT')?.trim() ||
      'storage/course-package',
    maxImageBytes: num('MEDIA_MAX_IMAGE_BYTES', 20 * MB),
    maxVideoBytes: num('MEDIA_MAX_VIDEO_BYTES', 500 * MB),
    maxAudioBytes: num('MEDIA_MAX_AUDIO_BYTES', 100 * MB),
    maxPdfBytes: num('MEDIA_MAX_PDF_BYTES', 100 * MB),
    maxModelBytes: num('MEDIA_MAX_MODEL_BYTES', 25 * MB),
    packageMaxBytes: num('PACKAGE_MAX_BYTES', 8 * 1024 * MB),
    packageDirectUploadBytes: num('PACKAGE_DIRECT_UPLOAD_BYTES', 200 * MB),
    packageExportTtlHours: num('PACKAGE_EXPORT_TTL_HOURS', 24),
    jobConcurrency: num('PACKAGE_JOB_CONCURRENCY', 2),
    jobPollMs: num('PACKAGE_JOB_POLL_MS', 2000),
    jobHeartbeatMs: num('PACKAGE_JOB_HEARTBEAT_MS', 10_000),
    jobStaleMs: num('PACKAGE_JOB_STALE_MS', 10 * 60 * 1000),
    jobMaxAttempts: num('PACKAGE_JOB_MAX_ATTEMPTS', 3),
  };
}

export const COMMERCE_CONFIG = Symbol('COMMERCE_CONFIG');
