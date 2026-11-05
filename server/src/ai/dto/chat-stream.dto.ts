import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/** 历史消息（多轮上下文，前端 localStorage 会话最近若干条；§4.3.3 扩展） */
export class ChatHistoryItemDto {
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @IsString()
  @MaxLength(8000)
  content!: string;
}

/** POST /api/ai/chat-stream 请求体（§4.4.1） */
export class ChatStreamDto {
  @IsUUID()
  courseId!: string;

  /** 防止共享测试指针被其他员工切换后，屏幕版本与请求知识不一致。 */
  @IsOptional()
  @IsUUID()
  expectedReleaseId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  message!: string;

  @IsIn(['LECTURE', 'SOCRATIC'])
  mode!: 'LECTURE' | 'SOCRATIC';

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChatHistoryItemDto)
  history?: ChatHistoryItemDto[];
}
