import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { SyncService } from './sync.service';
import { SyncRequestDto } from './dto/sync-request.dto';

/**
 * 同步接口（§5.1.5 / §3.2.2 外部源接管模型）。
 * 2026-10-26 改拍：同步数据源为 KS 内置课程 ID 映射表（`course-registry.ts`），
 * 不再运行时向 Portal 拉取课程目录；仅同步课程与课时标题。
 */
@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  /** 同步目标课程列表 + 同步状态（供前端选择器） */
  @Get('external-courses')
  listExternalCourses() {
    return this.syncService.listExternalCourses();
  }

  /** 仅同步目录树结构 */
  @Post('structure')
  syncStructure(@Body() dto: SyncRequestDto) {
    return this.syncService.sync(dto.externalId, 'structure');
  }

  /** 内容同步已禁用（2026-10-22 拍板：本期只同步标题） */
  @Post('all')
  syncAll(_dto: SyncRequestDto) {
    throw new BadRequestException({
      code: 'CONTENT_SYNC_DISABLED',
      message: '本期仅同步课程与课时标题，正文内容同步已禁用',
    });
  }
}
