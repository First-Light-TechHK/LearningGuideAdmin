import { query, withTransaction } from '../../../lib/db';
import type {
  FaqChangeNode,
  FaqChangeRelease,
  FaqChangeSubject,
  RawFaqChange,
} from './faqChangeLog';
import type { FaqEdgeRow } from './faqContracts';
import type { FaqGraphCheckResult } from './faqGraphChecks';
import type { SqlDb } from './faqRepository';

/**
 * Change Log 的 PostgreSQL 读取（只读）：四张只追加的表 UNION ALL 成一条时间线，按时间倒序翻页。
 * FAQ 的上一版快照用窗口函数 LAG 取（同一条 FAQ 按版本号排）。提到的 FAQ 连当前行一起读出（已删除的也读）。
 * 员工名字不在这里（employees 表归登录模块，服务层另查）。
 */

type Row = Record<string, unknown>;

const defaultDb: SqlDb = {
  query: (sql, params) => query<Row>(sql, params),
  withTransaction: (fn) => withTransaction((client) => fn(client)),
};

export type FaqChangeFilter = {
  subject?: FaqChangeSubject;
  /** 只看这位员工的（null = 种子 / 系统写入的）。 */
  employeeId?: string | null;
  from?: string;
  to?: string;
  /** 问题文字、key、问法、显示文字里包含它。 */
  q?: string;
  /** 一条 FAQ 的：它自己的修订、它作为父或子的边、它的问法（不含版本事件）。 */
  faqId?: string;
  offset: number;
  limit: number;
};

const EVENTS = `
  WITH faq_rev AS (
    SELECT r.*, LAG(r.snapshot) OVER (PARTITION BY r.faq_id ORDER BY r.version) AS previous
      FROM helpdesk_faq_revisions r
  ),
  events AS (
    SELECT 'faq'::text AS source, r.id, r.at, r.employee_id, r.faq_id, NULL::uuid AS child_id,
           'faq'::text AS subject,
           jsonb_build_object('action', r.action, 'version', r.version,
                              'snapshot', r.snapshot, 'previous', r.previous) AS payload,
           concat_ws(' ', r.snapshot->>'questionEn', r.snapshot->>'questionZh', r.snapshot->>'key') AS words
      FROM faq_rev r
    UNION ALL
    SELECT 'edge', e.id, e.at, e.employee_id, e.parent_id, e.child_id,
           COALESCE(e.after->>'kind', e.before->>'kind', 'follow_up'),
           jsonb_build_object('action', e.action, 'before', e.before, 'after', e.after),
           concat_ws(' ', e.after->>'labelEn', e.after->>'labelZh', e.before->>'labelEn', e.before->>'labelZh')
      FROM helpdesk_faq_edge_revisions e
    UNION ALL
    SELECT 'phrasing', p.id, p.at, p.employee_id, p.faq_id, NULL::uuid, 'phrasing',
           jsonb_build_object('action', p.action, 'locale', p.locale, 'text', p.text, 'source', p.source),
           p.text
      FROM helpdesk_faq_phrasing_revisions p
    UNION ALL
    SELECT 'release_created', rel.id, rel.created_at, rel.created_by, NULL::uuid, NULL::uuid, 'release',
           jsonb_build_object('version', rel.version, 'status', rel.status,
                              'sourceVersion', rel.source_version, 'checks', rel.checks),
           concat('v', rel.version, ' version ', rel.version)
      FROM helpdesk_faq_releases rel
    UNION ALL
    SELECT 'release_published', rel.id, rel.published_at, rel.published_by, NULL::uuid, NULL::uuid, 'release',
           jsonb_build_object('version', rel.version, 'status', rel.status,
                              'sourceVersion', rel.source_version, 'checks', rel.checks),
           concat('v', rel.version, ' version ', rel.version)
      FROM helpdesk_faq_releases rel
     WHERE rel.published_at IS NOT NULL
  )`;

const NODE = (alias: string) =>
  `${alias}.id AS ${alias}_id, ${alias}.key AS ${alias}_key, ${alias}.question_en AS ${alias}_question_en,
   ${alias}.question_zh AS ${alias}_question_zh, ${alias}.status AS ${alias}_status`;

/** LIKE 通配符转义（\ % _）。 */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : '';
}

function node(row: Row, alias: 'f' | 'c'): FaqChangeNode | null {
  if (row[`${alias}_id`] === null || row[`${alias}_id`] === undefined)
    return null;
  return {
    id: String(row[`${alias}_id`]),
    key: String(row[`${alias}_key`]),
    questionEn: String(row[`${alias}_question_en`]),
    questionZh: String(row[`${alias}_question_zh`]),
    status: row[`${alias}_status`] as FaqChangeNode['status'],
  };
}

function release(payload: Row): FaqChangeRelease {
  const checks = payload.checks as Partial<FaqGraphCheckResult> | null;
  return {
    version: Number(payload.version),
    status: payload.status as FaqChangeRelease['status'],
    sourceVersion:
      payload.sourceVersion === null || payload.sourceVersion === undefined
        ? null
        : Number(payload.sourceVersion),
    problems: Array.isArray(checks?.problems) ? checks.problems.length : 0,
  };
}

export function toRawChange(row: Row): RawFaqChange {
  const payload = (row.payload as Row) ?? {};
  const common = {
    id: String(row.id),
    at: iso(row.at),
    employeeId: (row.employee_id as string | null) ?? null,
  };
  switch (row.source) {
    case 'faq':
      return {
        ...common,
        source: 'faq',
        action: payload.action as 'create' | 'update' | 'archive',
        version: Number(payload.version),
        snapshot: (payload.snapshot as Record<string, unknown>) ?? {},
        previous: (payload.previous as Record<string, unknown> | null) ?? null,
        faq: node(row, 'f'),
      };
    case 'edge':
      return {
        ...common,
        source: 'edge',
        action: payload.action as 'create' | 'update' | 'delete',
        before: (payload.before as Partial<FaqEdgeRow> | null) ?? null,
        after: (payload.after as Partial<FaqEdgeRow> | null) ?? null,
        faq: node(row, 'f'),
        child: node(row, 'c'),
      };
    case 'phrasing':
      return {
        ...common,
        source: 'phrasing',
        action: payload.action as 'create' | 'delete',
        locale: String(payload.locale),
        text: String(payload.text),
        phrasingSource: String(payload.source),
        faq: node(row, 'f'),
      };
    default:
      return {
        ...common,
        source: row.source as 'release_created' | 'release_published',
        release: release(payload),
      };
  }
}

function where(filter: Omit<FaqChangeFilter, 'offset' | 'limit'>): {
  sql: string;
  params: unknown[];
} {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (filter.subject) clauses.push(`ev.subject = ${param(filter.subject)}`);
  if (filter.employeeId === null) clauses.push('ev.employee_id IS NULL');
  else if (filter.employeeId)
    clauses.push(`ev.employee_id = ${param(filter.employeeId)}`);
  if (filter.from) clauses.push(`ev.at >= ${param(filter.from)}::timestamptz`);
  if (filter.to) clauses.push(`ev.at < ${param(filter.to)}::timestamptz`);
  if (filter.faqId) {
    const id = param(filter.faqId);
    clauses.push(
      `(ev.faq_id = ${id} OR ev.child_id = ${id}) AND ev.source <> 'release_created' AND ev.source <> 'release_published'`,
    );
  }
  if (filter.q) {
    const q = param(likePattern(filter.q));
    clauses.push(
      `concat_ws(' ', ev.words, f.question_en, f.question_zh, f.key, c.question_en, c.question_zh, c.key) ILIKE ${q}`,
    );
  }
  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

export function createPgFaqChangeLogRepository(db: SqlDb = defaultDb) {
  return {
    /** 一页记录（新的在前）与符合条件的总数。 */
    async page(
      filter: FaqChangeFilter,
    ): Promise<{ changes: RawFaqChange[]; total: number }> {
      const w = where(filter);
      const rows = await db.query(
        `${EVENTS}
         SELECT ev.source, ev.id, ev.at, ev.employee_id, ev.payload, ${NODE('f')}, ${NODE('c')},
                count(*) OVER () AS total
           FROM events ev
           LEFT JOIN helpdesk_faqs f ON f.id = ev.faq_id
           LEFT JOIN helpdesk_faqs c ON c.id = ev.child_id
          ${w.sql}
          ORDER BY ev.at DESC, ev.id DESC
          OFFSET $${w.params.length + 1} LIMIT $${w.params.length + 2}`,
        [...w.params, filter.offset, filter.limit],
      );
      return {
        changes: rows.map(toRawChange),
        total: rows.length > 0 ? Number(rows[0].total) : 0,
      };
    },

    /** 在记录里出现过的员工（筛选「Changed by」的选项）。 */
    async employeeIds(): Promise<string[]> {
      const rows = await db.query(
        `${EVENTS}
         SELECT DISTINCT ev.employee_id FROM events ev WHERE ev.employee_id IS NOT NULL`,
      );
      return rows.map((row) => String(row.employee_id));
    },
  };
}

export type FaqChangeLogRepository = ReturnType<
  typeof createPgFaqChangeLogRepository
>;
