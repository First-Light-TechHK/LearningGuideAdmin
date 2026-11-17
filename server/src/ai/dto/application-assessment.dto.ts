import { IsIn, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { ApplicationAssessmentRequest } from '../../contracts/application-assessment';

export class ApplicationAssessmentDto implements ApplicationAssessmentRequest {
  @IsString() @MinLength(1) @MaxLength(100) externalCourseId!: string;
  @IsString() @MinLength(1) @MaxLength(16000) question!: string;
  @IsString() @MinLength(1) @MaxLength(2000) answer!: string;
  @IsIn(['en-GB', 'zh-CN']) locale!: 'en-GB' | 'zh-CN';
  @IsString() @MinLength(1) @MaxLength(100) userId!: string;
  @IsUUID('4') evaluationId!: string;
}
