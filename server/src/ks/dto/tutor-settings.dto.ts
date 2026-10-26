import { IsBoolean, IsNotEmpty, IsString } from 'class-validator';

export class SetTutorTestReleaseDto {
  @IsString()
  @IsNotEmpty()
  releaseId!: string;
}

export class SetTutorOnlineDto {
  @IsBoolean()
  online!: boolean;
}
