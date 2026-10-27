import { IsIn } from 'class-validator';

/** POST /api/ai/config/:courseId/reset 请求体（§4.2.4 / §5.2；2026-10-27：带 mode，仅重置该模式 System Prompt） */
export class ResetAiConfigDto {
  /** 要重置的模式：只清空该模式的 System Prompt 自定义覆盖，恢复该模式默认模板 */
  @IsIn(['LECTURE', 'SOCRATIC', 'ASSESSMENT'])
  mode!: 'LECTURE' | 'SOCRATIC' | 'ASSESSMENT';
}
