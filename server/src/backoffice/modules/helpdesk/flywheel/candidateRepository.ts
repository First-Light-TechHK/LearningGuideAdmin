import { uuidv7 } from '../../../../common/uuidv7';
import { query, withTransaction } from '../../../lib/db';
import type { SqlClient, SqlDb } from '../faqs/faqRepository';
import {
  addMix,
  answerSourcesOf,
  examplesOf,
  sourceMixOf,
  type CandidateExample,
  type MiningTurn,
  type OpenCandidate,
  type SourceMix,
  type Suggestion,
} from './flywheelMining';

/**
 * FAQ 候选（helpdesk_faq_candidates，迁移 20261031090000）的读写。BackOffice 是唯一写入方。
 * - 夜间挖掘建候选与给候选加轮（成员表 helpdesk_faq_candidate_turns 的主键是轮 id：一轮至多归一个
 *   候选，ON CONFLICT DO NOTHING，只按真正加进去的轮计数，重跑不会重复计）；
 * - 员工的动作（接受、驳回、合并）：WHERE id AND version 的条件更新（不一致 → conflict），与审计行
 *   （helpdesk_faq_candidate_revisions，只追加）同一事务；
 * - 回归用例（helpdesk_faq_eval_cases）：按 (节点, 语言, 小写文字) 幂等。
 */

type Row = Record<string, unknown>;

const defaultDb: SqlDb = {
  query: (sql, params) => query<Row>(sql, params),
  withTransaction: (fn) => withTransaction((client) => fn(client)),
};

export const CANDIDATE_STATUSES = [
  'new',
  'accepted',
  'dismissed',
  'merged',
] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];
export const CANDIDATE_SUGGESTIONS = [
  'new_faq',
  'add_phrasing',
  'follow_up',
] as const;
export const CANDIDATE_ORIGINS = ['mining', 'ticket'] as const;
export type CandidateOrigin = (typeof CANDIDATE_ORIGINS)[number];
/** 驳回的原因（枚举；备注另给）。 */
export const DISMISS_REASONS = [
  'duplicate',
  'not_a_gap',
  'out_of_scope',
  'personal_data',
  'spam',
  'other',
] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];

export type FaqCandidate = {
  id: string;
  status: CandidateStatus;
  suggestion: Suggestion;
  origin: CandidateOrigin;
  topic: string;
  proposedQuestion: string;
  labelSource: 'model' | 'code';
  category: string | null;
  locale: string;
  turnCount: number;
  examples: CandidateExample[];
  sourceMix: SourceMix;
  answerSources: string[];
  relatedNodeId: string | null;
  relatedScore: number | null;
  parentNodeId: string | null;
  shownNodeId: string | null;
  ticketId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  reason: DismissReason | null;
  reasonNote: string | null;
  acceptedAs: Suggestion | null;
  acceptedFaqId: string | null;
  mergedInto: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  actionKey: string | null;
  version: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CandidateRevision = {
  id: string;
  candidateId: string;
  action: 'create' | 'grow' | 'accept' | 'dismiss' | 'merge';
  before: unknown;
  after: unknown;
  employeeId: string | null;
  at: string;
};

export type NewCandidate = {
  suggestion: Suggestion;
  origin: CandidateOrigin;
  topic: string;
  proposedQuestion: string;
  labelSource: 'model' | 'code';
  category: string | null;
  locale: string;
  examples: CandidateExample[];
  sourceMix: SourceMix;
  answerSources: string[];
  relatedNodeId: string | null;
  relatedScore: number | null;
  parentNodeId: string | null;
  shownNodeId: string | null;
  ticketId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  /** origin = ticket：没有成员轮，条数从 1 起。 */
  turnCount?: number;
  createdBy: string | null;
};

export type CandidateFilter = {
  status?: CandidateStatus;
  suggestion?: Suggestion;
  origin?: CandidateOrigin;
  q?: string;
  offset: number;
  limit: number;
};

/** 员工的决定（status 之外的列）。 */
export type CandidateDecision =
  | {
      status: 'accepted';
      acceptedAs: Suggestion;
      acceptedFaqId: string;
      parentNodeId?: string | null;
    }
  | { status: 'dismissed'; reason: DismissReason; reasonNote: string | null };

export type DecideResult =
  | { kind: 'ok'; candidate: FaqCandidate }
  | { kind: 'not_found' }
  | { kind: 'conflict'; candidate: FaqCandidate };

export type EvalCaseRow = {
  id: string;
  faqId: string;
  faqKey: string | null;
  candidateId: string | null;
  locale: 'en-GB' | 'zh-CN' | 'zh-TW';
  text: string;
  source: 'flywheel' | 'staff';
  createdAt: string;
};

const iso = (value: unknown): string | null =>
  value instanceof Date
    ? value.toISOString()
    : typeof value === 'string'
      ? new Date(value).toISOString()
      : null;

const COLUMNS = `id, status, suggestion, origin, topic, proposed_question, label_source, category, locale,
  turn_count, examples, source_mix, answer_sources, related_node_id, related_score, parent_node_id,
  shown_node_id, ticket_id, first_seen_at, last_seen_at, reason, reason_note, accepted_as,
  accepted_faq_id, merged_into, decided_by, decided_at, action_key, version, created_by, created_at,
  updated_at`;

export function toCandidate(row: Row): FaqCandidate {
  return {
    id: row.id as string,
    status: row.status as CandidateStatus,
    suggestion: row.suggestion as Suggestion,
    origin: row.origin as CandidateOrigin,
    topic: row.topic as string,
    proposedQuestion: row.proposed_question as string,
    labelSource: row.label_source as 'model' | 'code',
    category: (row.category as string | null) ?? null,
    locale: row.locale as string,
    turnCount: Number(row.turn_count),
    examples: (row.examples as CandidateExample[]) ?? [],
    sourceMix: (row.source_mix as SourceMix) ?? {},
    answerSources: (row.answer_sources as string[]) ?? [],
    relatedNodeId: (row.related_node_id as string | null) ?? null,
    relatedScore:
      row.related_score === null || row.related_score === undefined
        ? null
        : Number(row.related_score),
    parentNodeId: (row.parent_node_id as string | null) ?? null,
    shownNodeId: (row.shown_node_id as string | null) ?? null,
    ticketId: (row.ticket_id as string | null) ?? null,
    firstSeenAt: iso(row.first_seen_at) as string,
    lastSeenAt: iso(row.last_seen_at) as string,
    reason: (row.reason as DismissReason | null) ?? null,
    reasonNote: (row.reason_note as string | null) ?? null,
    acceptedAs: (row.accepted_as as Suggestion | null) ?? null,
    acceptedFaqId: (row.accepted_faq_id as string | null) ?? null,
    mergedInto: (row.merged_into as string | null) ?? null,
    decidedBy: (row.decided_by as string | null) ?? null,
    decidedAt: iso(row.decided_at),
    actionKey: (row.action_key as string | null) ?? null,
    version: Number(row.version),
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
  };
}

/** 审计行里存的：去掉大块的例句，留下状态与决定。 */
function auditView(candidate: FaqCandidate | null) {
  if (!candidate) return null;
  const { examples, answerSources, ...rest } = candidate;
  return {
    ...rest,
    examples: examples.length,
    answerSources: answerSources.length,
  };
}

async function writeRevision(
  client: SqlClient,
  candidateId: string,
  action: CandidateRevision['action'],
  before: FaqCandidate | null,
  after: FaqCandidate | null,
  employeeId: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO helpdesk_faq_candidate_revisions (id, candidate_id, action, before, after, employee_id)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
    [
      uuidv7(),
      candidateId,
      action,
      JSON.stringify(auditView(before)),
      JSON.stringify(auditView(after)),
      employeeId,
    ],
  );
}

async function lockCandidate(
  client: SqlClient,
  id: string,
): Promise<FaqCandidate | null> {
  const result = await client.query(
    `SELECT ${COLUMNS} FROM helpdesk_faq_candidates WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] ? toCandidate(result.rows[0]) : null;
}

/** 把轮加进成员表，返回真正加进去的（已归别的候选的不算）。 */
async function addMembers(
  client: SqlClient,
  candidateId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const result = await client.query(
    `INSERT INTO helpdesk_faq_candidate_turns (turn_id, candidate_id)
     SELECT unnest($1::uuid[]), $2
     ON CONFLICT (turn_id) DO NOTHING
     RETURNING turn_id`,
    [ids, candidateId],
  );
  return new Set(result.rows.map((row) => row.turn_id as string));
}

export function createPgCandidateRepository(db: SqlDb = defaultDb) {
  return {
    /** 并进已有候选时比较用：待处理的与驳回过的（驳回的吸收相似的轮、不回到队列），since 之后动过的。 */
    async openCandidates(since: string): Promise<OpenCandidate[]> {
      const rows = await db.query(
        `SELECT id, examples FROM helpdesk_faq_candidates
          WHERE status IN ('new', 'dismissed') AND last_seen_at >= $1::timestamptz
          ORDER BY id`,
        [since],
      );
      return rows.map((row) => ({
        id: row.id as string,
        examples: ((row.examples as CandidateExample[]) ?? []).map(
          (e) => e.text,
        ),
      }));
    },

    /**
     * 新候选与它的成员轮（同一事务）。成员都已归了别的候选（另一个实例抢先）→ 不建，返回 null；
     * 条数、例句、原因构成只按真正加进去的轮算。
     */
    async insertCandidate(
      input: NewCandidate,
      members: readonly MiningTurn[],
    ): Promise<FaqCandidate | null> {
      return db
        .withTransaction(async (client) => {
          const id = uuidv7();
          const inserted = await client.query(
            `INSERT INTO helpdesk_faq_candidates
             (id, suggestion, origin, topic, proposed_question, label_source, category, locale,
              turn_count, examples, source_mix, answer_sources, related_node_id, related_score,
              parent_node_id, shown_node_id, ticket_id, first_seen_at, last_seen_at, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14,
                   $15, $16, $17, $18, $19, $20)
           ON CONFLICT (ticket_id) WHERE ticket_id IS NOT NULL DO NOTHING
           RETURNING ${COLUMNS}`,
            [
              id,
              input.suggestion,
              input.origin,
              input.topic,
              input.proposedQuestion,
              input.labelSource,
              input.category,
              input.locale,
              input.turnCount ?? 0,
              JSON.stringify(input.examples),
              JSON.stringify(input.sourceMix),
              JSON.stringify(input.answerSources),
              input.relatedNodeId,
              input.relatedScore,
              input.parentNodeId,
              input.shownNodeId,
              input.ticketId,
              input.firstSeenAt,
              input.lastSeenAt,
              input.createdBy,
            ],
          );
          if (!inserted.rows[0]) return null;
          let candidate = toCandidate(inserted.rows[0]);
          if (members.length > 0) {
            const added = await addMembers(
              client,
              id,
              members.map((m) => m.id),
            );
            const kept = members.filter((m) => added.has(m.id));
            // 成员全被别的候选抢走了：抛错让整个事务回滚（不留空候选）
            if (kept.length === 0) throw new NothingAdded();
            if (kept.length !== members.length) {
              const examples = examplesOf(
                kept,
                input.examples.filter((e) => e.turnId && added.has(e.turnId)),
              );
              const updated = await client.query(
                `UPDATE helpdesk_faq_candidates
                  SET turn_count = $2, examples = $3::jsonb, source_mix = $4::jsonb,
                      answer_sources = $5::jsonb
                WHERE id = $1 RETURNING ${COLUMNS}`,
                [
                  id,
                  kept.length,
                  JSON.stringify(examples),
                  JSON.stringify(sourceMixOf(kept)),
                  JSON.stringify(answerSourcesOf(kept)),
                ],
              );
              candidate = toCandidate(updated.rows[0]);
            } else {
              const updated = await client.query(
                `UPDATE helpdesk_faq_candidates SET turn_count = $2 WHERE id = $1 RETURNING ${COLUMNS}`,
                [id, kept.length],
              );
              candidate = toCandidate(updated.rows[0]);
            }
          }
          await writeRevision(
            client,
            id,
            'create',
            null,
            candidate,
            input.createdBy,
          );
          return candidate;
        })
        .catch((error: unknown) => {
          if (error instanceof NothingAdded) return null;
          throw error;
        });
    },

    /** 给已有的候选加轮：条数、例句（补到 5 个）、原因构成、草稿来源（补到 3 条）、最后出现时间。 */
    async growCandidate(
      id: string,
      members: readonly MiningTurn[],
    ): Promise<{ added: number; candidate: FaqCandidate } | null> {
      return db.withTransaction(async (client) => {
        const before = await lockCandidate(client, id);
        if (!before) return null;
        const added = await addMembers(
          client,
          id,
          members.map((m) => m.id),
        );
        const kept = members.filter((m) => added.has(m.id));
        if (kept.length === 0) return { added: 0, candidate: before };
        const last = kept.reduce(
          (latest, m) => (m.createdAt > latest ? m.createdAt : latest),
          before.lastSeenAt,
        );
        const updated = await client.query(
          `UPDATE helpdesk_faq_candidates
              SET turn_count = turn_count + $2, examples = $3::jsonb, source_mix = $4::jsonb,
                  answer_sources = $5::jsonb, last_seen_at = $6, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 RETURNING ${COLUMNS}`,
          [
            id,
            kept.length,
            JSON.stringify(examplesOf(kept, before.examples)),
            JSON.stringify(addMix(before.sourceMix, sourceMixOf(kept))),
            JSON.stringify(answerSourcesOf(kept, before.answerSources)),
            last,
          ],
        );
        const candidate = toCandidate(updated.rows[0]);
        await writeRevision(client, id, 'grow', before, candidate, null);
        return { added: kept.length, candidate };
      });
    },

    async list(filter: CandidateFilter): Promise<{
      candidates: FaqCandidate[];
      total: number;
      counts: Record<CandidateStatus, number>;
    }> {
      const where: string[] = [];
      const params: unknown[] = [];
      /** sql 里的每个 ? 都是这一个参数。 */
      const add = (sql: string, value: unknown) => {
        params.push(value);
        where.push(sql.replace(/\?/g, `$${params.length}`));
      };
      if (filter.status) add('status = ?', filter.status);
      if (filter.suggestion) add('suggestion = ?', filter.suggestion);
      if (filter.origin) add('origin = ?', filter.origin);
      if (filter.q)
        add(
          `(topic ILIKE ? OR proposed_question ILIKE ? OR examples::text ILIKE ?)`,
          `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
        );
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const [rows, total, counts] = await Promise.all([
        db.query(
          `SELECT ${COLUMNS} FROM helpdesk_faq_candidates ${clause}
            ORDER BY turn_count DESC, last_seen_at DESC, id
            OFFSET $${params.length + 1} LIMIT $${params.length + 2}`,
          [...params, filter.offset, filter.limit],
        ),
        db.query(
          `SELECT count(*)::int AS n FROM helpdesk_faq_candidates ${clause}`,
          params,
        ),
        db.query(
          'SELECT status, count(*)::int AS n FROM helpdesk_faq_candidates GROUP BY status',
        ),
      ]);
      const byStatus = Object.fromEntries(
        CANDIDATE_STATUSES.map((status) => [status, 0]),
      ) as Record<CandidateStatus, number>;
      for (const row of counts)
        byStatus[row.status as CandidateStatus] = Number(row.n);
      return {
        candidates: rows.map(toCandidate),
        total: Number(total[0]?.n ?? 0),
        counts: byStatus,
      };
    },

    async get(id: string): Promise<FaqCandidate | null> {
      const [row] = await db.query(
        `SELECT ${COLUMNS} FROM helpdesk_faq_candidates WHERE id = $1`,
        [id],
      );
      return row ? toCandidate(row) : null;
    },

    async byTicket(ticketId: string): Promise<FaqCandidate | null> {
      const [row] = await db.query(
        `SELECT ${COLUMNS} FROM helpdesk_faq_candidates WHERE ticket_id = $1`,
        [ticketId],
      );
      return row ? toCandidate(row) : null;
    },

    async revisions(id: string): Promise<CandidateRevision[]> {
      const rows = await db.query(
        `SELECT id, candidate_id, action, before, after, employee_id, at
           FROM helpdesk_faq_candidate_revisions WHERE candidate_id = $1 ORDER BY at, id`,
        [id],
      );
      return rows.map((row) => ({
        id: row.id as string,
        candidateId: row.candidate_id as string,
        action: row.action as CandidateRevision['action'],
        before: row.before ?? null,
        after: row.after ?? null,
        employeeId: (row.employee_id as string | null) ?? null,
        at: iso(row.at) as string,
      }));
    },

    /**
     * 接受 / 驳回：只有 status = new 且 version 一致时才改（与审计行同一事务）；否则 conflict
     * （带现在的样子，服务层判断是不是同一个决定的重试）。
     */
    async decide(
      id: string,
      expectedVersion: number,
      decision: CandidateDecision,
      employeeId: string,
      actionKey: string | null,
    ): Promise<DecideResult> {
      return db.withTransaction(async (client) => {
        const before = await lockCandidate(client, id);
        if (!before) return { kind: 'not_found' };
        if (before.status !== 'new' || before.version !== expectedVersion)
          return { kind: 'conflict', candidate: before };
        const accepted = decision.status === 'accepted';
        const updated = await client.query(
          `UPDATE helpdesk_faq_candidates
              SET status = $2, accepted_as = $3, accepted_faq_id = $4,
                  parent_node_id = COALESCE($5, parent_node_id), reason = $6, reason_note = $7,
                  decided_by = $8, decided_at = CURRENT_TIMESTAMP, action_key = $9,
                  version = version + 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 RETURNING ${COLUMNS}`,
          [
            id,
            decision.status,
            accepted ? decision.acceptedAs : null,
            accepted ? decision.acceptedFaqId : null,
            accepted ? (decision.parentNodeId ?? null) : null,
            accepted ? null : decision.reason,
            accepted ? null : decision.reasonNote,
            employeeId,
            actionKey,
          ],
        );
        const candidate = toCandidate(updated.rows[0]);
        await writeRevision(
          client,
          id,
          accepted ? 'accept' : 'dismiss',
          before,
          candidate,
          employeeId,
        );
        return { kind: 'ok', candidate };
      });
    },

    /**
     * 合并：source 的成员轮、条数、例句与原因构成并进 target（都要是 new），source → merged。
     * 同一事务里按 id 顺序锁两行（不会死锁）。
     */
    async merge(
      sourceId: string,
      expectedVersion: number,
      targetId: string,
      employeeId: string,
      actionKey: string | null,
    ): Promise<
      | { kind: 'ok'; source: FaqCandidate; target: FaqCandidate }
      | { kind: 'not_found' }
      | { kind: 'target_not_found' }
      | { kind: 'conflict'; source: FaqCandidate }
      | { kind: 'target_closed'; target: FaqCandidate }
    > {
      return db.withTransaction(async (client) => {
        const [first, second] = [sourceId, targetId].sort();
        const locked = new Map<string, FaqCandidate | null>();
        locked.set(first, await lockCandidate(client, first));
        locked.set(second, await lockCandidate(client, second));
        const source = locked.get(sourceId) ?? null;
        const target = locked.get(targetId) ?? null;
        if (!source) return { kind: 'not_found' };
        if (!target) return { kind: 'target_not_found' };
        if (source.status !== 'new' || source.version !== expectedVersion)
          return { kind: 'conflict', source };
        if (target.status !== 'new') return { kind: 'target_closed', target };
        const moved = await client.query(
          `UPDATE helpdesk_faq_candidate_turns SET candidate_id = $2 WHERE candidate_id = $1`,
          [sourceId, targetId],
        );
        const movedCount = moved.rowCount ?? 0;
        const updatedTarget = await client.query(
          `UPDATE helpdesk_faq_candidates
              SET turn_count = turn_count + $2, examples = $3::jsonb, source_mix = $4::jsonb,
                  answer_sources = $5::jsonb, first_seen_at = LEAST(first_seen_at, $6),
                  last_seen_at = GREATEST(last_seen_at, $7), updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 RETURNING ${COLUMNS}`,
          [
            targetId,
            // 从工单转来的没有成员轮：按它自己的条数
            movedCount > 0 ? movedCount : source.turnCount,
            JSON.stringify(
              [...target.examples, ...source.examples]
                .filter(
                  (e, i, all) =>
                    all.findIndex(
                      (o) => o.text.toLowerCase() === e.text.toLowerCase(),
                    ) === i,
                )
                .slice(0, 5),
            ),
            JSON.stringify(addMix(target.sourceMix, source.sourceMix)),
            JSON.stringify(
              [
                ...new Set([...target.answerSources, ...source.answerSources]),
              ].slice(0, 3),
            ),
            source.firstSeenAt,
            source.lastSeenAt,
          ],
        );
        const updatedSource = await client.query(
          `UPDATE helpdesk_faq_candidates
              SET status = 'merged', merged_into = $2, turn_count = 0, decided_by = $3,
                  decided_at = CURRENT_TIMESTAMP, action_key = $4, version = version + 1,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 RETURNING ${COLUMNS}`,
          [sourceId, targetId, employeeId, actionKey],
        );
        const after = toCandidate(updatedSource.rows[0]);
        const afterTarget = toCandidate(updatedTarget.rows[0]);
        await writeRevision(
          client,
          sourceId,
          'merge',
          source,
          after,
          employeeId,
        );
        await writeRevision(
          client,
          targetId,
          'grow',
          target,
          afterTarget,
          employeeId,
        );
        return { kind: 'ok', source: after, target: afterTarget };
      });
    },

    /** 回归用例（幂等：同一节点、语言、文字只一条）；返回新加的条数。 */
    async insertEvalCases(
      cases: readonly {
        faqId: string;
        candidateId: string | null;
        locale: string;
        text: string;
        createdBy: string | null;
      }[],
    ): Promise<number> {
      if (cases.length === 0) return 0;
      return db.withTransaction(async (client) => {
        let added = 0;
        for (const item of cases) {
          const result = await client.query(
            `INSERT INTO helpdesk_faq_eval_cases (id, faq_id, candidate_id, locale, text, created_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (faq_id, locale, lower(text)) DO NOTHING`,
            [
              uuidv7(),
              item.faqId,
              item.candidateId,
              item.locale,
              item.text,
              item.createdBy,
            ],
          );
          added += result.rowCount ?? 0;
        }
        return added;
      });
    },

    /** 全部回归用例（发布评测门与导出用），带节点的 key（导出按 key，换库也认得）。 */
    async evalCases(): Promise<EvalCaseRow[]> {
      const rows = await db.query(
        `SELECT c.id, c.faq_id, f.key AS faq_key, c.candidate_id, c.locale, c.text, c.source, c.created_at
           FROM helpdesk_faq_eval_cases c
           LEFT JOIN helpdesk_faqs f ON f.id = c.faq_id
          ORDER BY c.created_at, c.id`,
      );
      return rows.map((row) => ({
        id: row.id as string,
        faqId: row.faq_id as string,
        faqKey: (row.faq_key as string | null) ?? null,
        candidateId: (row.candidate_id as string | null) ?? null,
        locale: row.locale as EvalCaseRow['locale'],
        text: row.text as string,
        source: row.source as EvalCaseRow['source'],
        createdAt: iso(row.created_at) as string,
      }));
    },
  };
}

class NothingAdded extends Error {
  constructor() {
    super('nothing added');
  }
}

export type CandidateRepository = ReturnType<
  typeof createPgCandidateRepository
>;
