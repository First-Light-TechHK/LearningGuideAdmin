import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type {
  HelpdeskQuestionStats,
  HelpdeskSuggestionStats,
} from '../../contracts/helpdesk-qa';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * helpdesk_suggestions（Figma addendum §C；迁移 20261028090100_helpdesk_suggestions）：
 * Agent 每次检索记一行；学员反馈 outcome 首个为准；query_text 90 天后清空。
 * 同一张表给 BackOffice 的 Common Questions 计数（经契约 HelpdeskSuggestionStats）。
 */
export const SUGGESTION_OUTCOMES = ['solved', 'declined', 'edited'] as const;
export type SuggestionOutcome = (typeof SUGGESTION_OUTCOMES)[number];

export type SuggestionLogEntry = {
  id: string;
  learnerId: string;
  locale: string;
  category: string;
  queryText: string;
  candidateIds: string[];
  qaId: string | null;
  /** 没调模型（无候选）时为 null。 */
  model: string | null;
  latencyMs: number;
};

export interface HelpdeskSuggestionLog {
  record(entry: SuggestionLogEntry): Promise<void>;
  /** 首个为准：已有结果时不改，返回已存的；找不到返回 null。 */
  setOutcome(
    id: string,
    outcome: SuggestionOutcome,
  ): Promise<{ outcome: SuggestionOutcome; changed: boolean } | null>;
  /** 清空早于 cutOff 的 query_text，返回清理行数。 */
  purgeQueryText(cutOff: Date): Promise<number>;
}

@Injectable()
export class PrismaHelpdeskSuggestionStore
  implements HelpdeskSuggestionLog, HelpdeskSuggestionStats
{
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: SuggestionLogEntry): Promise<void> {
    await this.prisma.helpdeskSuggestion.create({
      data: {
        id: entry.id,
        learnerId: entry.learnerId,
        locale: entry.locale,
        category: entry.category,
        queryText: entry.queryText,
        candidateIds: entry.candidateIds,
        qaId: entry.qaId,
        model: entry.model,
        latencyMs: Math.max(0, Math.round(entry.latencyMs)),
      },
    });
  }

  async setOutcome(
    id: string,
    outcome: SuggestionOutcome,
  ): Promise<{ outcome: SuggestionOutcome; changed: boolean } | null> {
    // 条件更新保证并发下只有第一个生效
    const { count } = await this.prisma.helpdeskSuggestion.updateMany({
      where: { id, outcome: null },
      data: { outcome },
    });
    if (count === 1) return { outcome, changed: true };
    const row = await this.prisma.helpdeskSuggestion.findUnique({
      where: { id },
      select: { outcome: true },
    });
    if (!row || row.outcome === null) return null;
    return { outcome: row.outcome as SuggestionOutcome, changed: false };
  }

  async purgeQueryText(cutOff: Date): Promise<number> {
    const { count } = await this.prisma.helpdeskSuggestion.updateMany({
      where: { createdAt: { lt: cutOff }, queryText: { not: null } },
      data: { queryText: null },
    });
    return count;
  }

  async statsFor(
    questionIds: string[],
  ): Promise<Map<string, HelpdeskQuestionStats>> {
    const stats = new Map<string, HelpdeskQuestionStats>();
    if (questionIds.length === 0) return stats;
    const rows = await this.prisma.$queryRaw<
      { qa_id: string; shown: number; solved: number; declined: number }[]
    >(Prisma.sql`
      SELECT qa_id::text AS qa_id,
             count(*)::int AS shown,
             count(*) FILTER (WHERE outcome = 'solved')::int AS solved,
             count(*) FILTER (WHERE outcome = 'declined')::int AS declined
        FROM helpdesk_suggestions
       WHERE qa_id = ANY(${questionIds}::uuid[])
       GROUP BY qa_id`);
    for (const row of rows) {
      stats.set(row.qa_id, {
        shown: Number(row.shown),
        solved: Number(row.solved),
        declined: Number(row.declined),
      });
    }
    return stats;
  }
}
