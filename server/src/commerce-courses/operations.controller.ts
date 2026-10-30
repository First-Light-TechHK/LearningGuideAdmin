import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { BackofficeRequest } from '../backoffice/nest/request-context';
import { OperationsService } from './operations.service';

function actor(request: BackofficeRequest): string | null {
  return request.employee?.employeeId ?? null;
}

/** Operations（PRD §19）：从 Course Overview 右上角进入。 */
@Controller('backoffice/operations')
export class OperationsController {
  constructor(private readonly operations: OperationsService) {}

  @Get('popular-courses')
  getPopular() {
    return this.operations.getPopular();
  }

  @Put('popular-courses')
  @HttpCode(200)
  savePopular(
    @Body() body: { items: Array<{ courseId: string; sortOrder?: number }> },
  ) {
    return this.operations.savePopular(body?.items ?? []);
  }

  @Get('discovery-banner')
  getBanner() {
    return this.operations.getBanner();
  }

  @Put('discovery-banner')
  @HttpCode(200)
  saveBanner(
    @Body()
    body: {
      enabled: boolean;
      courseId?: string | null;
      localized?: Record<string, unknown> | null;
    },
  ) {
    return this.operations.saveBanner(body);
  }

  @Post('publish')
  @HttpCode(200)
  publish(
    @Body() body: { section?: 'popular' | 'banner' | 'both'; reason?: string },
    @Req() request: BackofficeRequest,
  ) {
    return this.operations.publish(
      body?.section ?? 'both',
      actor(request),
      body?.reason,
    );
  }
}
