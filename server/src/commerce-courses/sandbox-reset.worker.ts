import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { COMMERCE_CONFIG, type CommerceCourseConfig } from './commerce.config';
import { SandboxResetService } from './sandbox-reset.service';

/**
 * Sandbox 课程内容重置 worker（DB 队列 + FOR UPDATE SKIP LOCKED）。
 * 与 PackageWorker 同一模式：每实例一个轮询循环，多实例安全；
 * 未启用（非 Sandbox / 开关关）时不启动定时器，也不领取作业。
 */
@Injectable()
export class SandboxResetWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SandboxResetWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly resets: SandboxResetService,
    @Inject(COMMERCE_CONFIG) private readonly config: CommerceCourseConfig,
  ) {}

  onModuleInit(): void {
    if (!this.resets.isAvailable()) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.jobPollMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      await this.resets.reclaimStale();
      for (let i = 0; i < this.config.jobConcurrency; i++) {
        const jobId = await this.resets.claimNext();
        if (!jobId) break;
        await this.resets.execute(jobId);
      }
    } catch (error) {
      this.logger.warn(
        `reset worker tick failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.running = false;
    }
  }
}
