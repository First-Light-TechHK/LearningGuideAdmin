import {
  ASSIST_SOURCES,
  type InsightTurn,
  type TicketStatus,
} from '../contracts';
import { query, withTransaction } from '../../../lib/db';
import type { SqlDb } from '../faqs/faqRepository';

/**
 * 事实表 helpdesk_insight_turns 与指标视图 helpdesk_insight_turn_facts（迁移 20261031090000）。
 * Admin 读不到 Portal 的库：这里的每一行都来自 Portal 的 insights 接口（契约 fixture v7，学员文字
 * 已脱敏，其余全是标签），按 Portal 的轮 id 幂等 upsert（同一轮再拉一次只更新会变的标签与工单结果）。
 */

type Row = Record<string, unknown>;

const defaultDb: SqlDb = {
  query: (sql, params) => query<Row>(sql, params),
  withTransaction: (fn) => withTransaction((client) => fn(client)),
};

const iso = (value: unknown): string | null =>
  value instanceof Date
    ? value.toISOString()
    : typeof value === 'string'
      ? new Date(value).toISOString()
      : null;

const TURN_COLUMNS = `id, created_at, source, locale, text, session_id, turn_index, last_turn,
  session_end_reason, kind, intent, guard, via, faq_id, node_id, parent_node_id, release_version,
  answered, vote, rating, covered, expanded, handover, ticket_after_chat, ticket_linked, ticket_status,
  ticket_close_reason, ticket_resolved_by_agent, ticket_agent_replied, agent_reply, signals`;

/** 事实表的一行 → InsightTurn（与 Portal 发来的同一个形状）。 */
export function toInsightTurn(row: Row): InsightTurn {
  const linked = row.ticket_linked as boolean | null;
  return {
    id: row.id as string,
    createdAt: iso(row.created_at) as string,
    source: (ASSIST_SOURCES as readonly unknown[]).includes(row.source)
      ? (row.source as InsightTurn['source'])
      : null,
    locale: row.locale as string,
    text: row.text as string,
    sessionId: (row.session_id as string | null) ?? null,
    turnIndex: (row.turn_index as number | null) ?? null,
    lastTurn: (row.last_turn as boolean | null) ?? null,
    sessionEndReason: (row.session_end_reason ??
      null) as InsightTurn['sessionEndReason'],
    kind: (row.kind ?? null) as InsightTurn['kind'],
    intent: (row.intent as string | null) ?? null,
    guard: (row.guard ?? null) as InsightTurn['guard'],
    via: (row.via ?? null) as InsightTurn['via'],
    faqId: (row.faq_id as string | null) ?? null,
    nodeId: (row.node_id as string | null) ?? null,
    parentNodeId: (row.parent_node_id as string | null) ?? null,
    releaseVersion: (row.release_version as number | null) ?? null,
    answered: row.answered === true,
    vote: (row.vote ?? null) as InsightTurn['vote'],
    rating: (row.rating as number | null) ?? null,
    covered: (row.covered as boolean | null) ?? null,
    expanded: (row.expanded as boolean | null) ?? null,
    handover: row.handover === true,
    ticketAfterChat: row.ticket_after_chat === true,
    ticket:
      linked === null || linked === undefined
        ? null
        : {
            linked,
            status: (row.ticket_status as TicketStatus | null) ?? null,
            closeReason: (row.ticket_close_reason ?? null) as NonNullable<
              InsightTurn['ticket']
            >['closeReason'],
            resolvedByAgent: row.ticket_resolved_by_agent === true,
            agentReplied: row.ticket_agent_replied === true,
            agentReply: (row.agent_reply as string | null) ?? null,
          },
    signals: (row.signals as string[] | null) ?? [],
  };
}

function turnParams(turn: InsightTurn): unknown[] {
  return [
    turn.id,
    turn.createdAt,
    turn.source,
    turn.locale,
    turn.text,
    turn.sessionId,
    turn.turnIndex,
    turn.lastTurn,
    turn.sessionEndReason,
    turn.kind,
    turn.intent,
    turn.guard,
    turn.via,
    turn.faqId,
    turn.nodeId,
    turn.parentNodeId,
    turn.releaseVersion,
    turn.answered,
    turn.vote,
    turn.rating,
    turn.covered,
    turn.expanded,
    turn.handover,
    turn.ticketAfterChat,
    turn.ticket ? turn.ticket.linked : null,
    turn.ticket?.status ?? null,
    turn.ticket?.closeReason ?? null,
    turn.ticket ? turn.ticket.resolvedByAgent : null,
    turn.ticket ? turn.ticket.agentReplied : null,
    turn.ticket?.agentReply ?? null,
    turn.signals,
  ];
}

const UPSERT_SQL = `
INSERT INTO helpdesk_insight_turns (${TURN_COLUMNS})
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31::text[])
ON CONFLICT (id) DO UPDATE SET
  source = EXCLUDED.source, locale = EXCLUDED.locale, text = EXCLUDED.text,
  session_id = EXCLUDED.session_id, turn_index = EXCLUDED.turn_index, last_turn = EXCLUDED.last_turn,
  session_end_reason = EXCLUDED.session_end_reason, kind = EXCLUDED.kind, intent = EXCLUDED.intent,
  guard = EXCLUDED.guard, via = EXCLUDED.via, faq_id = EXCLUDED.faq_id, node_id = EXCLUDED.node_id,
  parent_node_id = EXCLUDED.parent_node_id, release_version = EXCLUDED.release_version,
  answered = EXCLUDED.answered, vote = EXCLUDED.vote, rating = EXCLUDED.rating,
  covered = EXCLUDED.covered, expanded = EXCLUDED.expanded, handover = EXCLUDED.handover,
  ticket_after_chat = EXCLUDED.ticket_after_chat, ticket_linked = EXCLUDED.ticket_linked,
  ticket_status = EXCLUDED.ticket_status, ticket_close_reason = EXCLUDED.ticket_close_reason,
  ticket_resolved_by_agent = EXCLUDED.ticket_resolved_by_agent,
  ticket_agent_replied = EXCLUDED.ticket_agent_replied, agent_reply = EXCLUDED.agent_reply,
  signals = EXCLUDED.signals, updated_at = CURRENT_TIMESTAMP
WHERE (helpdesk_insight_turns.source, helpdesk_insight_turns.locale, helpdesk_insight_turns.text,
       helpdesk_insight_turns.session_id, helpdesk_insight_turns.turn_index,
       helpdesk_insight_turns.last_turn, helpdesk_insight_turns.session_end_reason,
       helpdesk_insight_turns.kind, helpdesk_insight_turns.intent, helpdesk_insight_turns.guard,
       helpdesk_insight_turns.via, helpdesk_insight_turns.faq_id, helpdesk_insight_turns.node_id,
       helpdesk_insight_turns.parent_node_id, helpdesk_insight_turns.release_version,
       helpdesk_insight_turns.answered, helpdesk_insight_turns.vote, helpdesk_insight_turns.rating,
       helpdesk_insight_turns.covered, helpdesk_insight_turns.expanded, helpdesk_insight_turns.handover,
       helpdesk_insight_turns.ticket_after_chat, helpdesk_insight_turns.ticket_linked,
       helpdesk_insight_turns.ticket_status, helpdesk_insight_turns.ticket_close_reason,
       helpdesk_insight_turns.ticket_resolved_by_agent, helpdesk_insight_turns.ticket_agent_replied,
       helpdesk_insight_turns.agent_reply, helpdesk_insight_turns.signals)
  IS DISTINCT FROM
      (EXCLUDED.source, EXCLUDED.locale, EXCLUDED.text, EXCLUDED.session_id, EXCLUDED.turn_index,
       EXCLUDED.last_turn, EXCLUDED.session_end_reason, EXCLUDED.kind, EXCLUDED.intent, EXCLUDED.guard,
       EXCLUDED.via, EXCLUDED.faq_id, EXCLUDED.node_id, EXCLUDED.parent_node_id,
       EXCLUDED.release_version, EXCLUDED.answered, EXCLUDED.vote, EXCLUDED.rating, EXCLUDED.covered,
       EXCLUDED.expanded, EXCLUDED.handover, EXCLUDED.ticket_after_chat, EXCLUDED.ticket_linked,
       EXCLUDED.ticket_status, EXCLUDED.ticket_close_reason, EXCLUDED.ticket_resolved_by_agent,
       EXCLUDED.ticket_agent_replied, EXCLUDED.agent_reply, EXCLUDED.signals)
RETURNING (xmax = 0) AS inserted`;

export type MetricsGranularity = 'day' | 'week';
export type MetricsSplit = 'none' | 'locale' | 'entry' | 'signal';

export type MetricsQuery = {
  granularity: MetricsGranularity;
  /** UTC 日期（含）。 */
  from: string;
  /** UTC 日期（含）。 */
  to: string;
  split: MetricsSplit;
};

/** 一个时间桶（或合计）× 一个切分值的计数（比率由服务层算）。 */
export type MetricsCounts = {
  turns: number;
  answers: number;
  answersSettled: number;
  aiSolved: number;
  noMatch: number;
  votes: number;
  helpful: number;
  ratings: number;
  ratingSum: number;
  handovers: number;
  clarify: number;
  clarifyCovered: number;
  guarded: number;
  guardFallback: number;
  unsolved: number;
};

export type MetricsRow = MetricsCounts & {
  bucket: string | null;
  segment: string;
};

const COUNT_COLUMNS = `
  count(*)::int AS turns,
  count(*) FILTER (WHERE f.is_answer)::int AS answers,
  count(*) FILTER (WHERE f.answer_settled)::int AS answers_settled,
  count(*) FILTER (WHERE f.ai_solved)::int AS ai_solved,
  count(*) FILTER (WHERE f.is_no_match)::int AS no_match,
  count(*) FILTER (WHERE f.voted)::int AS votes,
  count(*) FILTER (WHERE f.helpful)::int AS helpful,
  count(f.rating)::int AS ratings,
  COALESCE(sum(f.rating), 0)::int AS rating_sum,
  count(*) FILTER (WHERE f.handover)::int AS handovers,
  count(*) FILTER (WHERE f.is_clarify)::int AS clarify,
  count(*) FILTER (WHERE f.clarify_covered)::int AS clarify_covered,
  count(*) FILTER (WHERE f.guarded)::int AS guarded,
  count(*) FILTER (WHERE f.guard_fallback)::int AS guard_fallback,
  count(*) FILTER (WHERE f.unsolved)::int AS unsolved`;

function counts(row: Row): MetricsCounts {
  return {
    turns: Number(row.turns),
    answers: Number(row.answers),
    answersSettled: Number(row.answers_settled),
    aiSolved: Number(row.ai_solved),
    noMatch: Number(row.no_match),
    votes: Number(row.votes),
    helpful: Number(row.helpful),
    ratings: Number(row.ratings),
    ratingSum: Number(row.rating_sum),
    handovers: Number(row.handovers),
    clarify: Number(row.clarify),
    clarifyCovered: Number(row.clarify_covered),
    guarded: Number(row.guarded),
    guardFallback: Number(row.guard_fallback),
    unsolved: Number(row.unsolved),
  };
}

/** 切分的 SQL：locale / entry（入口：submit 提交工单、chat 聊天、chip 点问题）/ signal（按信号展开，没有信号 = none）。 */
function segmentSql(split: MetricsSplit): { from: string; segment: string } {
  switch (split) {
    case 'locale':
      return { from: 'helpdesk_insight_turn_facts f', segment: 'f.locale' };
    case 'entry':
      return { from: 'helpdesk_insight_turn_facts f', segment: 'f.entry' };
    case 'signal':
      return {
        from: `helpdesk_insight_turn_facts f
          CROSS JOIN LATERAL unnest(CASE WHEN cardinality(f.signals) = 0
                                         THEN ARRAY['none']::text[] ELSE f.signals END) AS s(signal)`,
        segment: 's.signal',
      };
    default:
      return { from: 'helpdesk_insight_turn_facts f', segment: `'all'` };
  }
}

export type GapGroupRow = {
  candidateId: string;
  topic: string;
  proposedQuestion: string;
  suggestion: string;
  status: string;
  turns: number;
};

export type TicketFaqRow = {
  faqId: string;
  answers: number;
  ticketsAfter: number;
};

export function createPgInsightRepository(db: SqlDb = defaultDb) {
  return {
    /** 幂等 upsert（按轮 id）；内容没变的行不改（updated_at 不动）。 */
    async upsertTurns(
      turns: readonly InsightTurn[],
    ): Promise<{ inserted: number; updated: number }> {
      if (turns.length === 0) return { inserted: 0, updated: 0 };
      return db.withTransaction(async (client) => {
        let inserted = 0;
        let updated = 0;
        for (const turn of turns) {
          const result = await client.query(UPSERT_SQL, turnParams(turn));
          const row = result.rows[0];
          if (!row) continue;
          if (row.inserted === true) inserted += 1;
          else updated += 1;
        }
        return { inserted, updated };
      });
    },

    /** 事实表里最新的一轮的时间（下一次拉取从它往回看 72 小时开始）；空表 → null。 */
    async latestTurnAt(): Promise<string | null> {
      const [row] = await db.query(
        'SELECT max(created_at) AS at FROM helpdesk_insight_turns',
      );
      return iso(row?.at);
    },

    /** 最近一次写入事实表的时间（数据页显示「数据截至」）。 */
    async lastIngestedAt(): Promise<string | null> {
      const [row] = await db.query(
        'SELECT max(updated_at) AS at FROM helpdesk_insight_turns',
      );
      return iso(row?.at);
    },

    /** since 之后、AI 没解决、还没归属任何候选的轮，最新的先，至多 limit 条。 */
    async unassignedUnsolved(input: {
      since: string;
      limit: number;
    }): Promise<InsightTurn[]> {
      const rows = await db.query(
        `SELECT ${TURN_COLUMNS.split(',')
          .map((c) => `f.${c.trim()}`)
          .join(', ')}
           FROM helpdesk_insight_turn_facts f
          WHERE f.unsolved AND f.created_at >= $1::timestamptz
            AND NOT EXISTS (SELECT 1 FROM helpdesk_faq_candidate_turns m WHERE m.turn_id = f.id)
          ORDER BY f.created_at DESC, f.id DESC
          LIMIT $2`,
        [input.since, input.limit],
      );
      return rows.map(toInsightTurn);
    },

    /** 按日 / 周 × 切分值的计数，以及整段时间的合计（同一个视图）。 */
    async metrics(
      q: MetricsQuery,
    ): Promise<{ rows: MetricsRow[]; totals: MetricsRow[] }> {
      const { from, segment } = segmentSql(q.split);
      const bucket = q.granularity === 'week' ? 'f.week' : 'f.day';
      const where = 'f.day BETWEEN $1::date AND $2::date';
      const [rows, totals] = await Promise.all([
        db.query(
          `SELECT ${bucket}::text AS bucket, ${segment} AS segment, ${COUNT_COLUMNS}
             FROM ${from} WHERE ${where}
            GROUP BY 1, 2 ORDER BY 1, 2`,
          [q.from, q.to],
        ),
        db.query(
          `SELECT ${segment} AS segment, ${COUNT_COLUMNS}
             FROM ${from} WHERE ${where}
            GROUP BY 1 ORDER BY 1`,
          [q.from, q.to],
        ),
      ]);
      return {
        rows: rows.map((row) => ({
          bucket: row.bucket as string,
          segment: row.segment as string,
          ...counts(row),
        })),
        totals: totals.map((row) => ({
          bucket: null,
          segment: row.segment as string,
          ...counts(row),
        })),
      };
    },

    /** 这段时间里轮数最多的缺口组（候选的成员轮按时间落在这段里的条数）。 */
    async topGapGroups(
      q: Pick<MetricsQuery, 'from' | 'to'>,
      limit: number,
    ): Promise<GapGroupRow[]> {
      const rows = await db.query(
        `SELECT c.id, c.topic, c.proposed_question, c.suggestion, c.status, count(*)::int AS turns
           FROM helpdesk_faq_candidate_turns m
           JOIN helpdesk_insight_turn_facts f ON f.id = m.turn_id
           JOIN helpdesk_faq_candidates c ON c.id = m.candidate_id
          WHERE f.day BETWEEN $1::date AND $2::date
          GROUP BY c.id
          ORDER BY turns DESC, c.id
          LIMIT $3`,
        [q.from, q.to, limit],
      );
      return rows.map((row) => ({
        candidateId: row.id as string,
        topic: row.topic as string,
        proposedQuestion: row.proposed_question as string,
        suggestion: row.suggestion as string,
        status: row.status as string,
        turns: Number(row.turns),
      }));
    },

    /** 最常在答案之后（24 小时内）还建了工单的 FAQ（只看已满 24 小时的答案）。 */
    async ticketFaqs(
      q: Pick<MetricsQuery, 'from' | 'to'>,
      limit: number,
    ): Promise<TicketFaqRow[]> {
      const rows = await db.query(
        `SELECT f.faq_id, count(*)::int AS answers,
                count(*) FILTER (WHERE f.ticket_after_chat)::int AS tickets_after
           FROM helpdesk_insight_turn_facts f
          WHERE f.answer_settled AND f.faq_id IS NOT NULL
            AND f.day BETWEEN $1::date AND $2::date
          GROUP BY f.faq_id
         HAVING count(*) FILTER (WHERE f.ticket_after_chat) > 0
          ORDER BY tickets_after DESC, answers DESC, f.faq_id
          LIMIT $3`,
        [q.from, q.to, limit],
      );
      return rows.map((row) => ({
        faqId: row.faq_id as string,
        answers: Number(row.answers),
        ticketsAfter: Number(row.tickets_after),
      }));
    },
  };
}

export type InsightRepository = ReturnType<typeof createPgInsightRepository>;
