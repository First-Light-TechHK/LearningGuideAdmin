import { IsIn, IsOptional, IsUUID } from 'class-validator';

/** POST /api/ai/config/:courseId/reset 请求体（§4.2.4 / §5.2；2026-10-29 新增 MAIN） */
export class ResetAiConfigDto {
  /** 要重置的分段项：MAIN=清空主提示词，其余为清空对应模式 System Prompt */
  @IsIn(['MAIN', 'LECTURE', 'SOCRATIC', 'ASSESSMENT'])
  mode!: 'MAIN' | 'LECTURE' | 'SOCRATIC' | 'ASSESSMENT';

  /** 要重置的 Release（可选）：省略时作用于「测试所选 Release」 */
  @IsOptional()
  @IsUUID()
  releaseId?: string;
}
