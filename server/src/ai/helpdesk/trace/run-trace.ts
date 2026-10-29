import type {
  AgentEventType,
  JsonObject,
} from '../../../contracts/helpdesk-trace';
import type { AgentEventLog, NewAgentEvent } from './agent-event.store';

/**
 * 一次推荐（一个 run，一轮 turn）的事件缓冲：事件按发生时刻打时间，整轮结束时一次写入（一个事务），
 * 不拖慢推荐；写失败只记日志。run 关闭后再来的事件（超时后迟到的回调）直接丢弃。
 * data 先过一遍 JSON（去掉 undefined 等），日志里存的就是读出来的样子。
 */
export class RunTrace {
  readonly turn = 1;
  private stepNo = 0;
  private buffer: NewAgentEvent[] = [];
  private closed = false;
  private written = false;

  constructor(
    readonly runId: string,
    private readonly log: AgentEventLog,
    private readonly now: () => number = Date.now,
  ) {}

  emit(type: AgentEventType, data: JsonObject): void {
    if (this.closed) return;
    this.buffer.push({
      type,
      time: new Date(this.now()),
      data: JSON.parse(JSON.stringify(data)) as JsonObject,
    });
    if (type === 'turn/end') this.closed = true;
  }

  /** 下一步的步号（从 1 起）。 */
  nextStep(): number {
    this.stepNo += 1;
    return this.stepNo;
  }

  /** 写出缓冲的事件；第一次写入要求 run 是新的（不接到别的 run 后面）。 */
  async flush(): Promise<void> {
    const batch = this.buffer.splice(0);
    if (batch.length === 0) return;
    const fresh = !this.written;
    this.written = true;
    await this.log.append(this.runId, batch, { fresh });
  }
}
