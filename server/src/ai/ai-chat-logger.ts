import { Injectable, Logger } from '@nestjs/common';
import { appendFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** 日志目录（相对后端启动目录；已在 .gitignore 中排除） */
const LOG_DIR = resolve(process.cwd(), 'app-logs');

/** 用户提问 / 模型回答的预览长度上限（字符） */
const PREVIEW_LIMIT = 80;

/** 错误信息保留长度上限（字符） */
const ERROR_LIMIT = 300;

/** 单次对话的结束状态：正常结束 / 出错 / 客户端中断 */
export type AiChatStatus = 'ok' | 'error' | 'aborted';

/** 单次对话日志条目（§4.4.2 第 7 步，2026-10-22 用户拍板） */
export interface AiChatLogEntry {
  courseId: string;
  releaseId: string | null;
  mode: 'LECTURE' | 'SOCRATIC';
  /** 2026-10-22：区分后台测试对话与 Portal 学员对话 */
  channel: 'admin' | 'learner';
  /** 2026-10-28：Portal 学员 userId；后台测试/直播间不传 */
  userId?: string;
  provider: string;
  model: string;
  historyCount: number;
  latencyMs: number;
  status: AiChatStatus;
  error?: string;
  question: string;
  answer: string;
}

/** 本地时区的 YYYY-MM-DD（日志按自然日分文件） */
function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 压平空白并截断，避免日志换行与超长内容 */
function preview(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * AI 对话运行日志（§4.4.2 第 7 步）：
 * 每次对话结束后旁路追加一行 JSON 到 `app-logs/ai-chat-YYYY-MM-DD.log`。
 * 只记录元数据与短预览——**绝不写 apiKey / baseUrl / 完整 Prompt**；
 * 写盘失败仅告警，不影响对话主流程。会话本身仍不落库（§4.3.2）。
 */
@Injectable()
export class AiChatLogger {
  private readonly logger = new Logger(AiChatLogger.name);

  async write(entry: AiChatLogEntry): Promise<void> {
    try {
      await mkdir(LOG_DIR, { recursive: true });
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        courseId: entry.courseId,
        releaseId: entry.releaseId,
        mode: entry.mode,
        channel: entry.channel,
        ...(entry.userId ? { userId: entry.userId } : {}),
        provider: entry.provider,
        model: entry.model,
        historyCount: entry.historyCount,
        latencyMs: entry.latencyMs,
        status: entry.status,
        ...(entry.error ? { error: preview(entry.error, ERROR_LIMIT) } : {}),
        questionChars: entry.question.length,
        answerChars: entry.answer.length,
        question: preview(entry.question, PREVIEW_LIMIT),
        answer: preview(entry.answer, PREVIEW_LIMIT),
      });
      await appendFile(
        join(LOG_DIR, `ai-chat-${today()}.log`),
        `${line}\n`,
        'utf8',
      );
    } catch (err) {
      this.logger.warn(`AI 对话日志写入失败：${(err as Error).message}`);
    }
  }
}
