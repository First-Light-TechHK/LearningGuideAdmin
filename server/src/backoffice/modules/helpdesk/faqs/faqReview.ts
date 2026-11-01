import { isUuid, uuidv7 } from '../../../../common/uuidv7';
import { displayNameFromEmail } from '../../../contracts/employee';
import { query, withTransaction } from '../../../lib/db';
import type { SqlClient } from './faqRepository';
import { scrubPii } from '../flywheel/piiScrubber';
import { HelpdeskError } from '../portalHelpdeskClient';
import { FAQ_CATEGORIES } from '../../../../contracts/helpdesk-qa';
import {
  FAQ_LIMITS,
  type FaqActor,
  type FaqRevision,
  type HelpdeskFaq,
} from './faqContracts';
import { FAQ_COLUMNS, likePattern, toFaq, type SqlDb } from './faqRepository';

/**
 * FAQ 逐张审核（owner 2026-10-31：员工要能审核整张 FAQ 表，每次改动都留痕）。
 * - 一次审核一行 helpdesk_faq_reviews（只追加）：审的是哪一版、结论（没问题 / 要改）、备注、谁、何时；
 * - 卡的审核状态 = 当前版本上最近的一次审核；卡改过（version 变了）自动回到「未审核」，要再审；
 * - 写操作带 version（卡的版本）：不一致 409 VERSION_CONFLICT（员工看的不是现在这一版）；可带 Idempotency-Key；
 * - 改动历史 = 卡的修订快照逐版对比（哪些字段、改前改后）+ 位置的挂载记录 + 审核记录，谁做的给显示名。
 * 不调模型，不改卡本身；「保存修改」走现有的 PUT /faqs/:id，再审核新版本。
 */
export const FAQ_REVIEW_STATUSES = ['ok', 'needs_change'] as const;
export type FaqReviewStatus = (typeof FAQ_REVIEW_STATUSES)[number];
export const FAQ_REVIEW_FILTERS = [
  'unreviewed',
  'ok',
  'needs_change',
  'all',
] as const;
export type FaqReviewFilter = (typeof FAQ_REVIEW_FILTERS)[number];

export const FAQ_REVIEW_LIMITS = {
  noteMax: 500,
  historyMax: 200,
} as const;

export type Person = { id: string; name: string };

/** 一张卡的审核状态（当前版本上最近的一次；没有 = 未审核）。 */
export type FaqReviewState = {
  status: 'unreviewed' | FaqReviewStatus;
  /** 最近一次审核审的是哪一版（卡改过之后它小于卡的版本，状态回到未审核）。 */
  faqVersion: number | null;
  note: string | null;
  by: Person | null;
  at: string | null;
};

export type FaqReviewCounts = Record<'unreviewed' | FaqReviewStatus, number>;

/** 历史里比较的字段（版本号、时间、修改人这些每次都变的不算）。 */
export const HISTORY_FIELDS = [
  'questionZh',
  'answerZh',
  'questionEn',
  'answerEn',
  'category',
  'popular',
  'keywords',
  'signals',
  'type',
  'entry',
  'key',
  'status',
] as const;
export type HistoryField = (typeof HISTORY_FIELDS)[number];

export type FaqHistoryEntry =
  | {
      kind: 'card';
      at: string;
      by: Person | null;
      /** create | update | archive */
      action: string;
      version: number;
      changes: { field: HistoryField; before: unknown; after: unknown }[];
    }
  | {
      kind: 'placement';
      at: string;
      by: Person | null;
      action: 'create' | 'update' | 'delete';
      nodeKey: string | null;
      primary: { before: boolean | null; after: boolean | null };
    }
  | {
      kind: 'review';
      at: string;
      by: Person | null;
      action: FaqReviewStatus;
      version: number;
      note: string | null;
    };

type Row = Record<string, unknown>;

type ReviewRow = {
  faqId: string;
  faqVersion: number;
  status: FaqReviewStatus;
  note: string | null;
  employeeId: string | null;
  at: string;
};

function invalid(message: string): HelpdeskError {
  return new HelpdeskError(400, 'INVALID_INPUT', message);
}

/** uuid / 文字列：pg 回的是字符串；不是就当没有。 */
const textOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : String(value);

function toReview(row: Row): ReviewRow {
  return {
    faqId: String(row.faq_id),
    faqVersion: Number(row.faq_version),
    status: row.status as FaqReviewStatus,
    note: (row.note as string | null) ?? null,
    employeeId: textOrNull(row.employee_id),
    at: iso(row.at),
  };
}

/** 卡的状态：最近一次审核审的是当前版本才算数。 */
export function reviewStateOf(
  faq: Pick<HelpdeskFaq, 'version'>,
  latest: ReviewRow | null,
  people: ReadonlyMap<string, Person>,
): FaqReviewState {
  if (!latest)
    return {
      status: 'unreviewed',
      faqVersion: null,
      note: null,
      by: null,
      at: null,
    };
  return {
    status: latest.faqVersion === faq.version ? latest.status : 'unreviewed',
    faqVersion: latest.faqVersion,
    note: latest.note,
    by: latest.employeeId ? (people.get(latest.employeeId) ?? null) : null,
    at: latest.at,
  };
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** 卡的修订（新的在前或在后都行）→ 每一版改了哪些字段。第一版（新建）列出所有非空字段。 */
export function cardChanges(
  revisions: readonly FaqRevision[],
): Map<number, { field: HistoryField; before: unknown; after: unknown }[]> {
  const ordered = [...revisions].sort((a, b) => a.version - b.version);
  const out = new Map<
    number,
    { field: HistoryField; before: unknown; after: unknown }[]
  >();
  let previous: Record<string, unknown> | null = null;
  for (const revision of ordered) {
    const snap = revision.snapshot;
    const changes = HISTORY_FIELDS.filter((field) =>
      previous === null
        ? snap[field] !== undefined &&
          snap[field] !== '' &&
          !same(snap[field], [])
        : !same(previous[field], snap[field]),
    ).map((field) => ({
      field,
      before: previous === null ? null : (previous[field] ?? null),
      after: snap[field] ?? null,
    }));
    out.set(revision.version, changes);
    previous = snap;
  }
  return out;
}

export function createPgFaqReviewRepository(
  db: Pick<SqlDb, 'query'> = {
    query: (sql, params) => query<Row>(sql, params),
  },
  transaction: <T>(fn: (client: SqlClient) => Promise<T>) => Promise<T> = (
    fn,
  ) => withTransaction((client) => fn(client)),
) {
  const STATUS_SQL = `COALESCE((
      SELECT r.status FROM helpdesk_faq_reviews r
       WHERE r.faq_id = f.id AND r.faq_version = f.version
       ORDER BY r.at DESC, r.id DESC LIMIT 1), 'unreviewed')`;

  return {
    /** 每张卡最近的一次审核（不管哪一版；状态由 reviewStateOf 按版本算）。 */
    async latest(faqIds: readonly string[]): Promise<Map<string, ReviewRow>> {
      if (faqIds.length === 0) return new Map();
      const rows = await db.query(
        `SELECT DISTINCT ON (faq_id) faq_id, faq_version, status, note, employee_id, at
           FROM helpdesk_faq_reviews WHERE faq_id = ANY($1::uuid[])
          ORDER BY faq_id, at DESC, id DESC`,
        [faqIds],
      );
      return new Map(rows.map((row) => [String(row.faq_id), toReview(row)]));
    },

    async all(faqId: string): Promise<ReviewRow[]> {
      const rows = await db.query(
        `SELECT faq_id, faq_version, status, note, employee_id, at
           FROM helpdesk_faq_reviews WHERE faq_id = $1
          ORDER BY at DESC, id DESC LIMIT $2`,
        [faqId, FAQ_REVIEW_LIMITS.historyMax],
      );
      return rows.map(toReview);
    },

    /** 在用的卡（没归档）按审核状态分一页；counts 是筛选前（同样的分类和关键词）的三类计数。 */
    async queue(filter: {
      review: FaqReviewFilter;
      category?: string;
      q?: string;
      offset: number;
      limit: number;
    }): Promise<{
      faqs: HelpdeskFaq[];
      total: number;
      counts: FaqReviewCounts;
    }> {
      const params: unknown[] = [];
      const where = [`f.status = 'published'`];
      if (filter.category) {
        params.push(filter.category);
        where.push(`f.category = $${params.length}`);
      }
      if (filter.q) {
        params.push(likePattern(filter.q));
        const n = params.length;
        where.push(`(f.question_en ILIKE $${n} OR f.answer_en ILIKE $${n}
          OR f.question_zh ILIKE $${n} OR f.answer_zh ILIKE $${n} OR f.key ILIKE $${n})`);
      }
      const base = `SELECT f.*, ${STATUS_SQL} AS review_status FROM helpdesk_faqs f WHERE ${where.join(' AND ')}`;
      const pick =
        filter.review === 'all'
          ? ''
          : `WHERE review_status = $${params.length + 1}`;
      const pickParams = filter.review === 'all' ? [] : [filter.review];
      const [counted, rows] = await Promise.all([
        db.query(
          `SELECT review_status, count(*)::int AS n FROM (${base}) s GROUP BY review_status`,
          params,
        ),
        db.query(
          `SELECT ${FAQ_COLUMNS} FROM (${base}) s ${pick}
            ORDER BY updated_at DESC, id DESC
            OFFSET $${params.length + pickParams.length + 1} LIMIT $${params.length + pickParams.length + 2}`,
          [...params, ...pickParams, filter.offset, filter.limit],
        ),
      ]);
      const counts: FaqReviewCounts = { unreviewed: 0, ok: 0, needs_change: 0 };
      for (const row of counted)
        counts[row.review_status as keyof FaqReviewCounts] = Number(row.n);
      const total =
        filter.review === 'all'
          ? counts.unreviewed + counts.ok + counts.needs_change
          : counts[filter.review];
      return { faqs: rows.map(toFaq), total, counts };
    },

    /**
     * 记一次审核：锁住卡，核对版本（409），幂等键撞了 → 回放原来那一行。
     * 返回 { review, replayed }；卡不存在或已归档 → null。
     */
    async record(input: {
      faqId: string;
      version: number;
      status: FaqReviewStatus;
      note: string | null;
      employeeId: string | null;
      idempotencyKey: string | null;
    }): Promise<
      | { ok: true; review: ReviewRow; faqVersion: number; replayed: boolean }
      | { ok: false; reason: 'not_found' }
      | { ok: false; reason: 'conflict'; current: number }
    > {
      return transaction(async (client) => {
        if (input.idempotencyKey) {
          const { rows } = await client.query(
            `SELECT r.faq_id, r.faq_version, r.status, r.note, r.employee_id, r.at, f.version
               FROM helpdesk_faq_reviews r JOIN helpdesk_faqs f ON f.id = r.faq_id
              WHERE r.idempotency_key = $1`,
            [input.idempotencyKey],
          );
          if (rows.length > 0) {
            if (String(rows[0].faq_id) !== input.faqId)
              throw invalid('Idempotency-Key was used for another FAQ');
            return {
              ok: true,
              review: toReview(rows[0]),
              faqVersion: Number(rows[0].version),
              replayed: true,
            };
          }
        }
        const { rows: faqs } = await client.query(
          `SELECT version, status FROM helpdesk_faqs WHERE id = $1 FOR UPDATE`,
          [input.faqId],
        );
        if (faqs.length === 0 || faqs[0].status !== 'published')
          return { ok: false, reason: 'not_found' };
        const current = Number(faqs[0].version);
        if (current !== input.version)
          return { ok: false, reason: 'conflict', current };
        const { rows } = await client.query(
          `INSERT INTO helpdesk_faq_reviews
             (id, faq_id, faq_version, status, note, employee_id, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING faq_id, faq_version, status, note, employee_id, at`,
          [
            uuidv7(),
            input.faqId,
            current,
            input.status,
            input.note,
            input.employeeId,
            input.idempotencyKey,
          ],
        );
        return {
          ok: true,
          review: toReview(rows[0]),
          faqVersion: current,
          replayed: false,
        };
      });
    },

    /** 卡的挂载记录（helpdesk_faq_map_revisions 里 entity = placement、改前或改后指向这张卡）。 */
    async placements(faqId: string): Promise<
      {
        action: 'create' | 'update' | 'delete';
        nodeKey: string | null;
        before: boolean | null;
        after: boolean | null;
        employeeId: string | null;
        at: string;
      }[]
    > {
      const rows = await db.query(
        `SELECT r.action, r.before, r.after, r.employee_id, r.at, n.key AS node_key
           FROM helpdesk_faq_map_revisions r
           LEFT JOIN helpdesk_faq_map_nodes n
             ON n.id = COALESCE(r.after->>'nodeId', r.before->>'nodeId')::uuid
          WHERE r.entity = 'placement'
            AND COALESCE(r.after->>'faqId', r.before->>'faqId') = $1
          ORDER BY r.at DESC, r.id DESC LIMIT $2`,
        [faqId, FAQ_REVIEW_LIMITS.historyMax],
      );
      const flag = (value: unknown) =>
        value && typeof value === 'object' && 'primary' in value
          ? Boolean(value.primary)
          : null;
      return rows.map((row) => ({
        action: row.action as 'create' | 'update' | 'delete',
        nodeKey: textOrNull(row.node_key),
        before: flag(row.before),
        after: flag(row.after),
        employeeId: textOrNull(row.employee_id),
        at: iso(row.at),
      }));
    },

    /** 员工 id → 显示名（登录邮箱 @ 前面那段，和会话里的 displayName 同一规则）。 */
    async people(
      ids: readonly (string | null)[],
    ): Promise<Map<string, Person>> {
      const wanted = [...new Set(ids.filter((id): id is string => !!id))];
      if (wanted.length === 0) return new Map();
      const rows = await db.query(
        `SELECT employee_id, login_email FROM employees WHERE employee_id = ANY($1::uuid[])`,
        [wanted],
      );
      return new Map(
        rows.map((row) => [
          String(row.employee_id),
          {
            id: String(row.employee_id),
            name: displayNameFromEmail(String(row.login_email)),
          },
        ]),
      );
    },
  };
}

export type FaqReviewRepository = ReturnType<
  typeof createPgFaqReviewRepository
>;

export type FaqReviewServiceDeps = {
  reviews: FaqReviewRepository;
  /** 卡和它的修订（现有的 FAQ 服务；归档的卡 404）。 */
  faqs: {
    get(id: string): Promise<HelpdeskFaq>;
    revisions(id: string): Promise<{ revisions: FaqRevision[] }>;
  };
};

function record(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function faqId(raw: string): string {
  if (!isUuid(raw)) throw invalid('Invalid FAQ id');
  return raw.toLowerCase();
}

function oneText(value: unknown, name: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string')
    throw invalid(`${name} must be a single value`);
  return value;
}

function positiveInt(
  raw: unknown,
  name: string,
  fallback: number,
  max: number,
) {
  const value = oneText(raw, name);
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw invalid(`${name} must be a positive integer`);
  const n = Number(value);
  if (n < 1 || n > max) throw invalid(`${name} must be between 1 and ${max}`);
  return n;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function createFaqReviewService(deps: FaqReviewServiceDeps) {
  async function states(faqs: readonly HelpdeskFaq[]) {
    const latest = await deps.reviews.latest(faqs.map((f) => f.id));
    const people = await deps.reviews.people(
      [...latest.values()].map((r) => r.employeeId),
    );
    return Object.fromEntries(
      faqs.map((f) => [
        f.id,
        reviewStateOf(f, latest.get(f.id) ?? null, people),
      ]),
    );
  }

  return {
    /** 审核队列：GET /faq-reviews?status=unreviewed|ok|needs_change|all&category=&q=&page=&pageSize= */
    async queue(raw: Record<string, unknown>) {
      const status = oneText(raw.status, 'status') ?? 'unreviewed';
      if (!(FAQ_REVIEW_FILTERS as readonly string[]).includes(status))
        throw invalid(`status must be one of ${FAQ_REVIEW_FILTERS.join(', ')}`);
      const category = oneText(raw.category, 'category');
      if (category && !(FAQ_CATEGORIES as readonly string[]).includes(category))
        throw invalid('Unknown category');
      const q = oneText(raw.q, 'q')?.trim();
      if (q && [...q].length > FAQ_LIMITS.searchMax)
        throw invalid(`q must be at most ${FAQ_LIMITS.searchMax} characters`);
      const page = positiveInt(raw.page, 'page', 1, 100_000);
      const pageSize = positiveInt(
        raw.pageSize,
        'pageSize',
        FAQ_LIMITS.pageSize,
        FAQ_LIMITS.pageSizeMax,
      );
      const { faqs, total, counts } = await deps.reviews.queue({
        review: status as FaqReviewFilter,
        category,
        q: q || undefined,
        offset: (page - 1) * pageSize,
        limit: pageSize,
      });
      return {
        faqs,
        total,
        page,
        pageSize,
        counts,
        reviews: await states(faqs),
      };
    },

    /** POST /faqs/:id/review { status: ok | needs_change, note?, version } */
    async review(
      actor: FaqActor,
      rawId: string,
      rawBody: unknown,
      rawKey?: string,
    ): Promise<{ review: FaqReviewState; replayed: boolean }> {
      const id = faqId(rawId);
      const body = record(rawBody);
      const status = body.status;
      if (
        typeof status !== 'string' ||
        !(FAQ_REVIEW_STATUSES as readonly string[]).includes(status)
      )
        throw invalid(
          `status must be one of ${FAQ_REVIEW_STATUSES.join(', ')}`,
        );
      const version = body.version;
      if (
        typeof version !== 'number' ||
        !Number.isInteger(version) ||
        version < 1
      )
        throw invalid('version must be a positive integer');
      let note: string | null = null;
      if (body.note !== undefined && body.note !== null) {
        if (typeof body.note !== 'string') throw invalid('note must be text');
        if (CONTROL.test(body.note))
          throw invalid('note has control characters');
        const trimmed = body.note.trim();
        if ([...trimmed].length > FAQ_REVIEW_LIMITS.noteMax)
          throw invalid(
            `note must be at most ${FAQ_REVIEW_LIMITS.noteMax} characters`,
          );
        note = trimmed === '' ? null : scrubPii(trimmed);
      }
      if (status === 'needs_change' && note === null)
        throw invalid('needs_change needs a note saying what to change');
      let key: string | null = null;
      if (rawKey !== undefined && rawKey !== '') {
        if (!isUuid(rawKey)) throw invalid('Idempotency-Key must be a UUID');
        key = rawKey.toLowerCase();
      }
      const result = await deps.reviews.record({
        faqId: id,
        version,
        status: status as FaqReviewStatus,
        note,
        employeeId: actor.employeeId,
        idempotencyKey: key,
      });
      if (!result.ok && result.reason === 'not_found')
        throw new HelpdeskError(404, 'FAQ_NOT_FOUND', 'FAQ not found');
      if (!result.ok)
        throw new HelpdeskError(
          409,
          'VERSION_CONFLICT',
          `This FAQ was changed by someone else (now version ${result.current}). Reload and try again.`,
        );
      const people = await deps.reviews.people([result.review.employeeId]);
      return {
        review: reviewStateOf(
          { version: result.faqVersion },
          result.review,
          people,
        ),
        replayed: result.replayed,
      };
    },

    /** GET /faqs/:id/history：新的在前；卡的字段改动、位置、审核三类合在一条时间线上。 */
    async history(rawId: string): Promise<{
      faqId: string;
      version: number;
      review: FaqReviewState;
      history: FaqHistoryEntry[];
    }> {
      const id = faqId(rawId);
      const faq = await deps.faqs.get(id);
      const [{ revisions }, reviews, placements] = await Promise.all([
        deps.faqs.revisions(id),
        deps.reviews.all(id),
        deps.reviews.placements(id),
      ]);
      const people = await deps.reviews.people([
        ...revisions.map((r) => r.employeeId),
        ...reviews.map((r) => r.employeeId),
        ...placements.map((p) => p.employeeId),
      ]);
      const who = (employeeId: string | null) =>
        employeeId
          ? (people.get(employeeId) ?? { id: employeeId, name: '' })
          : null;
      const changes = cardChanges(revisions);
      const history: FaqHistoryEntry[] = [
        ...revisions.map((r) => ({
          kind: 'card' as const,
          at: r.at,
          by: who(r.employeeId),
          action: r.action,
          version: r.version,
          changes: changes.get(r.version) ?? [],
        })),
        ...placements.map((p) => ({
          kind: 'placement' as const,
          at: p.at,
          by: who(p.employeeId),
          action: p.action,
          nodeKey: p.nodeKey,
          primary: { before: p.before, after: p.after },
        })),
        ...reviews.map((r) => ({
          kind: 'review' as const,
          at: r.at,
          by: who(r.employeeId),
          action: r.status,
          version: r.faqVersion,
          note: r.note,
        })),
      ];
      history.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
      return {
        faqId: id,
        version: faq.version,
        review: reviewStateOf(faq, reviews[0] ?? null, people),
        history: history.slice(0, FAQ_REVIEW_LIMITS.historyMax),
      };
    },
  };
}

export type FaqReviewService = ReturnType<typeof createFaqReviewService>;
