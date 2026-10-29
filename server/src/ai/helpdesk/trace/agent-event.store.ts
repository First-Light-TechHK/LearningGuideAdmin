import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type {
  AgentEventEnvelope,
  AgentEventType,
  JsonObject,
} from '../../../contracts/helpdesk-trace';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * helpdesk_agent_events（迁移 20261029120000）：dsh SessionEvent 日志，归 Agent 写。
 * 每个 run 的 seq 从 1 连续，由存储在 run 级锁里分配（并发追加也连续）；只追加、不改写，
 * 唯一例外是 90 天后清掉学员原文字段（LEARNER_TEXT_FIELDS），表上的触发器拦住其它一切 UPDATE / DELETE。
 */
export type NewAgentEvent = {
  type: AgentEventType;
  time: Date;
  data: JsonObject;
};

/** 含学员原文的字段：90 天后清空；导出副本里脱敏。 */
export const LEARNER_TEXT_FIELDS: Partial<Record<AgentEventType, string>> = {
  'turn/start': 'input',
  'assistant/message': 'text',
};

export type AppendOptions = {
  /** 新 run：该 run_id 已有事件时整批拒绝（调用方给的 runId 不能接到别人的 run 后面）。 */
  fresh?: boolean;
};

export interface AgentEventLog {
  append(
    runId: string,
    events: NewAgentEvent[],
    options?: AppendOptions,
  ): Promise<void>;
  read(runId: string): Promise<AgentEventEnvelope[]>;
  /** 一段对话的 run：root 自己 + turn/start.parentRunId = root 的，按 turn/start 时间先后。 */
  chain(rootRunId: string): Promise<string[]>;
  /** 清掉早于 cutOff 的学员原文字段，返回清理的事件数。 */
  purgeLearnerText(cutOff: Date): Promise<number>;
}

export class RunAlreadyExistsError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} already has events`);
    this.name = 'RunAlreadyExistsError';
  }
}

function withoutLearnerText(
  type: AgentEventType,
  data: JsonObject,
): JsonObject | null {
  const field = LEARNER_TEXT_FIELDS[type];
  if (!field || !(field in data)) return null;
  const rest = { ...data };
  delete rest[field];
  return rest;
}

/** 内存实现：单测与评测脚本用；语义与 PostgreSQL 实现一致（同一套 conformance 用例）。 */
export function createMemoryAgentEventLog(): AgentEventLog & {
  runs: Map<string, (AgentEventEnvelope & { at: number })[]>;
} {
  const runs = new Map<string, (AgentEventEnvelope & { at: number })[]>();
  const copy = (data: JsonObject) =>
    JSON.parse(JSON.stringify(data)) as JsonObject;
  return {
    runs,
    append(runId, events, options = {}) {
      const existing = runs.get(runId) ?? [];
      if (options.fresh && existing.length > 0)
        return Promise.reject(new RunAlreadyExistsError(runId));
      for (const event of events) {
        existing.push({
          type: event.type,
          seq: existing.length + 1,
          time: event.time.toISOString(),
          data: copy(event.data),
          at: event.time.getTime(),
        });
      }
      runs.set(runId, existing);
      return Promise.resolve();
    },
    read(runId) {
      return Promise.resolve(
        (runs.get(runId) ?? []).map(({ type, seq, time, data }) => ({
          type,
          seq,
          time,
          data: copy(data),
        })),
      );
    },
    chain(rootRunId) {
      const found: { runId: string; at: number }[] = [];
      for (const [runId, events] of runs) {
        const start = events.find((e) => e.type === 'turn/start');
        if (!start) continue;
        if (runId === rootRunId || start.data.parentRunId === rootRunId)
          found.push({ runId, at: start.at });
      }
      found.sort((a, b) => a.at - b.at || a.runId.localeCompare(b.runId));
      return Promise.resolve(found.map((f) => f.runId));
    },
    purgeLearnerText(cutOff) {
      let cleared = 0;
      for (const events of runs.values()) {
        for (const event of events) {
          if (event.at >= cutOff.getTime()) continue;
          const rest = withoutLearnerText(event.type, event.data);
          if (rest) {
            event.data = rest;
            cleared += 1;
          }
        }
      }
      return Promise.resolve(cleared);
    },
  };
}

type EventRow = {
  type: string;
  seq: number;
  time: Date;
  data: Prisma.JsonValue;
};

/** PostgreSQL 实现：run 级 advisory lock 内取 MAX(seq) 再整批插入，并发写同一 run 也连续。 */
@Injectable()
export class PrismaAgentEventLog implements AgentEventLog {
  constructor(private readonly prisma: PrismaService) {}

  async append(
    runId: string,
    events: NewAgentEvent[],
    options: AppendOptions = {},
  ): Promise<void> {
    if (events.length === 0) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${runId}, 0))`;
      const [{ last }] = await tx.$queryRaw<{ last: number }[]>`
        SELECT COALESCE(MAX(seq), 0)::int AS last FROM helpdesk_agent_events WHERE run_id = ${runId}::uuid`;
      if (options.fresh && last > 0) throw new RunAlreadyExistsError(runId);
      await tx.helpdeskAgentEvent.createMany({
        data: events.map((event, index) => ({
          runId,
          seq: last + index + 1,
          type: event.type,
          time: event.time,
          data: event.data,
        })),
      });
    });
  }

  async read(runId: string): Promise<AgentEventEnvelope[]> {
    const rows: EventRow[] = await this.prisma.helpdeskAgentEvent.findMany({
      where: { runId },
      orderBy: { seq: 'asc' },
      select: { type: true, seq: true, time: true, data: true },
    });
    return rows.map((row) => ({
      type: row.type as AgentEventType,
      seq: row.seq,
      time: row.time.toISOString(),
      data: row.data as JsonObject,
    }));
  }

  async chain(rootRunId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ run_id: string }[]>`
      SELECT run_id::text AS run_id FROM helpdesk_agent_events
       WHERE type = 'turn/start'
         AND (run_id = ${rootRunId}::uuid OR data->>'parentRunId' = ${rootRunId})
       ORDER BY time ASC, run_id ASC`;
    return rows.map((row) => row.run_id);
  }

  async purgeLearnerText(cutOff: Date): Promise<number> {
    let cleared = 0;
    for (const [type, field] of Object.entries(LEARNER_TEXT_FIELDS)) {
      cleared += await this.prisma.$executeRaw`
        UPDATE helpdesk_agent_events SET data = data - ${field}::text
         WHERE type = ${type} AND time < ${cutOff} AND data ? ${field}::text`;
    }
    return cleared;
  }
}
