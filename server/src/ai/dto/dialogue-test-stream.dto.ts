import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
  IsArray,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ChatHistoryItemDto } from './chat-stream.dto';

export class DialogueTestStreamDto {
  @IsUUID()
  courseId!: string;

  @IsUUID()
  releaseId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  model!: string;

  @IsBoolean()
  useKnowledge!: boolean;

  @IsIn(['LECTURE', 'SOCRATIC'])
  mode!: 'LECTURE' | 'SOCRATIC';

  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  message!: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChatHistoryItemDto)
  history?: ChatHistoryItemDto[];
}
