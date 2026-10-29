import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ALLOWED_TAG_COLORS } from './update-tag.dto';

/** 创建 Tag（开发文档 §5.1.6）。color 可选，不传则按 name 哈希分配。 */
export class CreateTagDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  name!: string;

  @IsOptional()
  @IsString()
  @IsIn(ALLOWED_TAG_COLORS)
  color?: string;
}
