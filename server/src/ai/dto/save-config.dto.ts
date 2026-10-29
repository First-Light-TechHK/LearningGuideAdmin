import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/** PUT /api/ai/config 请求体（§4.2.5 / §5.2；2026-10-29 新增 MAIN 模式用于主提示词） */
export class SaveAiConfigDto {
  @IsUUID()
  courseId!: string;

  /** 要写入的 Release（可选）：带了就写这一份，省略时写「测试所选 Release」 */
  @IsOptional()
  @IsUUID()
  releaseId?: string;

  /** 当前保存的分段项：MAIN=主提示词（讲授/苏格拉底共享），其余为模式自身 System Prompt */
  @IsIn(['MAIN', 'LECTURE', 'SOCRATIC', 'ASSESSMENT'])
  mode!: 'MAIN' | 'LECTURE' | 'SOCRATIC' | 'ASSESSMENT';

  @IsString()
  @IsIn(['openrouter'])
  llmProvider!: string;

  /** 课程级统一 LLM Model（不随模式区分） */
  @IsString()
  @MaxLength(100)
  llmModel!: string;

  /** 该模式自定义 System Prompt（优先级高于该模式模板）；省略/空串表示清除 */
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  systemPrompt?: string;

  /** 课程级统一 Welcome Message（不随模式区分）；省略/空串表示清除 */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  welcomeMsg?: string;

  /**
   * 课程级 API Key 明文（仅入参方向）：服务端立即加密存储；
   * 省略 = 保持原值不变；空字符串 = 清除（回退 env 全局 key）。
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  apiKey?: string;
}
