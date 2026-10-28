import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * helpdesk_suggestions（Figma addendum §C；Tickets v2 §1；迁移 20261028090100 + 20261029090000）：
 * Agent 每次回答记一行（来源 submit / chat / chip，faq_id 是展示给学员的 FAQ）；
 * 学员反馈 outcome 首个为准，且必须属于该来源；query_text 90 天后清空。
 */
export const SUGGESTION_SOURCES = ['submit', 'chat', 'chip'] as const;
export type SuggestionSource = (typeof SUGGESTION_SOURCES)[number];

/** 提交工单弹窗（submit）的结果。 */
export const SUGGESTION_OUTCOMES = ['solved', 'declined', 'edited'] as const;
/** 聊天面板（chat / chip）的结果。 */
export const ASSIST_OUTCOMES = ['helpful', 'not_helpful'] as const;
/** 全部结果（顺序同契约 enums.assistFeedback）。 */
export const ALL_OUTCOMES = [
  ...ASSIST_OUTCOMES,
  ...SUGGESTION_OUTCOMES,
] as const;
export type SuggestionOutcome = (typeof ALL_OUTCOMES)[number];

export function isSuggestionOutcome(
  value: unknown,
): value is SuggestionOutcome {
  return (ALL_OUTCOMES as readonly unknown[]).includes(value);
}

/** 结果是否属于该来源：submit 只收 solved / declined / edited，chat / chip 只收 helpful / not_helpful。 */
export function outcomeFits(
  source: SuggestionSource,
  outcome: SuggestionOutcome,
): boolean {
  const allowed: readonly string[] =
    source === 'submit' ? SUGGESTION_OUTCOMES : ASSIST_OUTCOMES;
  return allowed.includes(outcome);
}

export type SuggestionLogEntry = {
  id: string;
  learnerId: string;
  locale: string;
  source: SuggestionSource;
  /** 工单类型或 FAQ 分类（原样）；chat / chip 没有时为 null。 */
  category: string | null;
  queryText: string;
  candidateIds: string[];
  /** 展示给学员的 FAQ；没有答案时为 null。 */
  faqId: string | null;
  /** 没调模型（无候选、chip）时为 null。 */
  model: string | null;
  latencyMs: number;
};

export type OutcomeResult =
  | { kind: 'recorded'; outcome: SuggestionOutcome; changed: boolean }
  | { kind: 'not_found' }
  | { kind: 'wrong_source'; source: SuggestionSource };

export interface HelpdeskSuggestionLog {
  record(entry: SuggestionLogEntry): Promise<void>;
  /** 首个为准：已有结果时不改，返回已存的；结果不属于该来源时什么都不改。 */
  setOutcome(id: string, outcome: SuggestionOutcome): Promise<OutcomeResult>;
  /** 清空早于 cutOff 的 query_text，返回清理行数。 */
  purgeQueryText(cutOff: Date): Promise<number>;
}

function sourcesFor(outcome: SuggestionOutcome): SuggestionSource[] {
  return SUGGESTION_SOURCES.filter((source) => outcomeFits(source, outcome));
}

@Injectable()
export class PrismaHelpdeskSuggestionStore implements HelpdeskSuggestionLog {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: SuggestionLogEntry): Promise<void> {
    await this.prisma.helpdeskSuggestion.create({
      data: {
        id: entry.id,
        learnerId: entry.learnerId,
        locale: entry.locale,
        source: entry.source,
        category: entry.category,
        queryText: entry.queryText,
        candidateIds: entry.candidateIds,
        faqId: entry.faqId,
        model: entry.model,
        latencyMs: Math.max(0, Math.round(entry.latencyMs)),
      },
    });
  }

  async setOutcome(
    id: string,
    outcome: SuggestionOutcome,
  ): Promise<OutcomeResult> {
    // 条件更新保证并发下只有第一个生效；来源不对的行不会被改
    const { count } = await this.prisma.helpdeskSuggestion.updateMany({
      where: { id, outcome: null, source: { in: sourcesFor(outcome) } },
      data: { outcome },
    });
    if (count === 1) return { kind: 'recorded', outcome, changed: true };
    const row = await this.prisma.helpdeskSuggestion.findUnique({
      where: { id },
      select: { outcome: true, source: true },
    });
    if (!row) return { kind: 'not_found' };
    const source = row.source as SuggestionSource;
    if (!outcomeFits(source, outcome)) return { kind: 'wrong_source', source };
    if (row.outcome === null) return { kind: 'not_found' };
    return {
      kind: 'recorded',
      outcome: row.outcome as SuggestionOutcome,
      changed: false,
    };
  }

  async purgeQueryText(cutOff: Date): Promise<number> {
    const { count } = await this.prisma.helpdeskSuggestion.updateMany({
      where: { createdAt: { lt: cutOff }, queryText: { not: null } },
      data: { queryText: null },
    });
    return count;
  }
}
