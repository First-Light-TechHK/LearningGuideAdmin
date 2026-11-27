import { ArrayNotEmpty, ArrayUnique, IsArray, IsString } from 'class-validator';

export class ClearCoursePagesDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsString({ each: true })
  expectedPageIds!: string[];
}
