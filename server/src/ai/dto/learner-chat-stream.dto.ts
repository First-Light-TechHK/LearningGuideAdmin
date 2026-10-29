import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ChatHistoryItemDto } from './chat-stream.dto';

/** POST /api/user/ai/chat-stream 请求体（2026-10-22，Portal 学员端专用） */
export class LearnerChatStreamDto {
  /** Portal course.slug，对应 Course.externalId */
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  externalCourseId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  message!: string;

  @IsIn(['LECTURE', 'SOCRATIC'])
  mode!: 'LECTURE' | 'SOCRATIC';

  @IsIn(['en-GB', 'zh-CN'])
  locale!: 'en-GB' | 'zh-CN';

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChatHistoryItemDto)
  history?: ChatHistoryItemDto[];

  /** 流量来源（2026-10-23）：portal=学员个人对话，study-group=直播间；限流按来源分桶 */
  @IsOptional()
  @IsIn(['portal', 'study-group'])
  channel?: 'portal' | 'study-group';

  /** Portal 学员 userId（2026-10-28）：用于 KS 侧日志审计 + 用户级限流分桶；后台测试不填 */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  userId?: string;
}
