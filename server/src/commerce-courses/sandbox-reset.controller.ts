import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';

import { clientIp } from '../backoffice/nest/request-context';
import type { BackofficeRequest } from '../backoffice/nest/request-context';
import { SandboxResetService } from './sandbox-reset.service';

/**
 * Sandbox 课程内容重置（Sandbox 专项，docs/sandbox/partitioning.md §4）。
 *
 * 路由在 backoffice/nest/route-access.ts 显式登记为 employeeAdmin（仅 ADMIN）。
 * 服务层还有两层守卫：SANDBOX_RESET_ENABLED=true 且 APP_ENV=SANDBOX；
 * 任何一条不满足都返回 403 SANDBOX_RESET_DISABLED，生产/UAT/SIT 默认不可用。
 */
@Controller('backoffice/sandbox/reset')
export class SandboxResetController {
  constructor(private readonly resets: SandboxResetService) {}

  @Get()
  state() {
    return this.resets.state();
  }

  @Post()
  @HttpCode(202)
  create(
    @Body()
    body: { confirm?: unknown; reason?: unknown; scope?: unknown },
    @Req() request: BackofficeRequest,
  ) {
    return this.resets.create(
      body ?? {},
      request.employee?.employeeId ?? null,
      clientIp(request),
    );
  }

  @Get(':jobId')
  getJob(@Param('jobId') jobId: string) {
    return this.resets.getJob(jobId);
  }

  @Post(':jobId/cancel')
  @HttpCode(200)
  cancel(@Param('jobId') jobId: string) {
    return this.resets.cancel(jobId);
  }
}
