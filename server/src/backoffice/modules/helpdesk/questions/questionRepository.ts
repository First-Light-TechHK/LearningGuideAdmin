import type {
  HelpdeskCategory,
  HelpdeskQaCandidate,
  HelpdeskQaSearch,
  HelpdeskQaSource,
} from '../../../../contracts/helpdesk-qa';
import { uuidv7 } from '../../../../common/uuidv7';
import { query, withTransaction } from '../../../lib/db';
import {
  QUESTION_LIMITS,
  type HelpdeskQuestion,
  type QuestionRevision,
  type QuestionStatus,
  type RevisionAction,
} from './questionContracts';

export type { RevisionAction } from './questionContracts';

/**
 * Common Questions 的 PostgreSQL 读写（Figma addendum §A）。BackOffice 惯例：原生 SQL，
 * 与 Prisma 共用 DATABASE_URL。
 * - 每次修改：UPDATE … WHERE id AND version（不一致 → conflict，什么都不改）；
 * - 修订行与修改在同一事务里写入（失败一起回滚）；
 * - 候选检索：英文全文（english 配置，去停用词 + 词干）+ 关键词命中 + 中文双字重叠，同类 ×1.25。
 */

type Row = Record<string, unknown>;

export type SqlClient = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Row[]; rowCount?: number | null }>;
};

export type SqlDb = {
  query: (sql: string, params?: readonly unknown[]) => Promise<Row[]>;
  withTransaction: <T>(fn: (client: SqlClient) => Promise<T>) => Promise<T>;
};

const defaultDb: SqlDb = {
  query: (sql, params) => query<Row>(sql, params),
  withTransaction: (fn) => withTransaction((client) => fn(client)),
};

export type QuestionFilter = {
  locale?: string;
  category?: string;
  statuses: QuestionStatus[];
  q?: string;
};

/** 可修改的列（服务层决定改哪些）。 */
export type QuestionPatch = Partial<
  Pick<
    HelpdeskQuestion,
    | 'locale'
    | 'category'
    | 'question'
    | 'answer'
    | 'keywords'
    | 'status'
    | 'featured'
    | 'sortOrder'
  >
>;

export type WriteResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'not_found' }
  | { kind: 'conflict'; currentVersion: number };

export type QuestionRepository = {
  list: (filter: QuestionFilter) => Promise<HelpdeskQuestion[]>;
  get: (id: string) => Promise<HelpdeskQuestion | null>;
  nextSortOrder: (locale: string) => Promise<number>;
  insert: (
    question: HelpdeskQuestion,
    employeeId: string | null,
  ) => Promise<HelpdeskQuestion>;
  update: (
    id: string,
    expectedVersion: number,
    patch: QuestionPatch,
    action: RevisionAction,
    employeeId: string | null,
  ) => Promise<WriteResult<HelpdeskQuestion>>;
  /** 按给定顺序把 sort_order 设为 10、20、30…；任何一行版本不符则整体不改。 */
  reorder: (
    items: { id: string; version: number }[],
    employeeId: string | null,
  ) => Promise<WriteResult<HelpdeskQuestion[]>>;
  revisions: (id: string) => Promise<QuestionRevision[]>;
  listPublished: (
    locale: string,
    featuredOnly: boolean,
  ) => Promise<HelpdeskQuestion[]>;
  searchCandidates: (
    search: HelpdeskQaSearch,
  ) => Promise<HelpdeskQaCandidate[]>;
};

const COLUMNS = `id, locale, category, question, answer, keywords, status, featured,
  sort_order, version, created_by, updated_by, created_at, updated_at`;

const PATCH_COLUMNS: Record<keyof QuestionPatch, string> = {
  locale: 'locale',
  category: 'category',
  question: 'question',
  answer: 'answer',
  keywords: 'keywords',
  status: 'status',
  featured: 'featured',
  sortOrder: 'sort_order',
};

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : '';
}

function toQuestion(row: Row): HelpdeskQuestion {
  return {
    id: String(row.id),
    locale: row.locale as HelpdeskQuestion['locale'],
    category: row.category as HelpdeskQuestion['category'],
    question: String(row.question),
    answer: String(row.answer),
    keywords: Array.isArray(row.keywords) ? row.keywords.map(String) : [],
    status: row.status as QuestionStatus,
    featured: row.featured === true,
    sortOrder: Number(row.sort_order),
    version: Number(row.version),
    createdBy: (row.created_by as string | null) ?? null,
    updatedBy: (row.updated_by as string | null) ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toRevision(row: Row): QuestionRevision {
  return {
    id: String(row.id),
    questionId: String(row.question_id),
    version: Number(row.version),
    action: row.action as RevisionAction,
    employeeId: (row.employee_id as string | null) ?? null,
    at: iso(row.at),
    snapshot: (row.snapshot as Record<string, unknown>) ?? {},
  };
}

async function writeRevision(
  client: SqlClient,
  question: HelpdeskQuestion,
  action: RevisionAction,
  employeeId: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO helpdesk_question_revisions
       (id, question_id, version, snapshot, action, employee_id)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
    [
      uuidv7(),
      question.id,
      question.version,
      JSON.stringify(question),
      action,
      employeeId,
    ],
  );
}

/** LIKE 通配符转义（\ % _）。 */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const HAN = /\p{Script=Han}/u;

/** 学员原文 → 英文全文检索词（只含字母数字，OR 连接）与中文双字片段。 */
export function searchTerms(text: string): {
  tsquery: string;
  bigrams: string[];
} {
  const lower = text.toLowerCase();
  const words = [
    ...new Set(
      (lower.match(/[\p{L}\p{N}]+/gu) ?? []).filter(
        (word) => word.length >= 2 && !HAN.test(word),
      ),
    ),
  ].slice(0, 32);
  const bigrams = new Set<string>();
  for (const run of lower.match(/\p{Script=Han}+/gu) ?? []) {
    const chars = [...run];
    for (let i = 0; i + 1 < chars.length; i++) {
      bigrams.add(chars[i] + chars[i + 1]);
    }
  }
  return { tsquery: words.join(' | '), bigrams: [...bigrams].slice(0, 40) };
}

const CANDIDATES_SQL = `
WITH input AS (
  SELECT CASE WHEN $3 = '' THEN NULL ELSE to_tsquery('english', $3) END AS tsq,
         lower($4) AS body,
         $5::text[] AS bigrams
), scored AS (
  SELECT q.id, q.category, q.question, q.answer, q.sort_order,
         COALESCE(ts_rank(to_tsvector('english', q.question || ' ' || q.answer), i.tsq), 0) AS text_rank,
         COALESCE(to_tsvector('english', q.question || ' ' || q.answer) @@ i.tsq, false) AS text_hit,
         (SELECT count(*) FROM unnest(q.keywords) AS k
           WHERE k <> '' AND position(lower(k) IN i.body) > 0) AS keyword_hits,
         (SELECT count(*) FROM unnest(i.bigrams) AS b
           WHERE position(b IN q.question) > 0) AS bigram_hits
    FROM helpdesk_questions q CROSS JOIN input i
   WHERE q.locale = $1 AND q.status = 'published'
)
SELECT id, category, question, answer,
       ((text_rank + 0.3 * keyword_hits + 0.1 * bigram_hits)
         * CASE WHEN category = $2 THEN 1.25 ELSE 1 END)::float8 AS score
  FROM scored
 WHERE text_hit OR keyword_hits > 0 OR bigram_hits > 0
 ORDER BY score DESC, sort_order ASC, id ASC
 LIMIT $6`;

export function createPgQuestionRepository(
  db: SqlDb = defaultDb,
): QuestionRepository {
  async function currentVersion(
    client: SqlClient,
    id: string,
  ): Promise<number | null> {
    const { rows } = await client.query(
      'SELECT version FROM helpdesk_questions WHERE id = $1',
      [id],
    );
    return rows.length > 0 ? Number(rows[0].version) : null;
  }

  return {
    async list(filter) {
      const params: unknown[] = [filter.statuses];
      const where = ['status = ANY($1::text[])'];
      if (filter.locale) {
        params.push(filter.locale);
        where.push(`locale = $${params.length}`);
      }
      if (filter.category) {
        params.push(filter.category);
        where.push(`category = $${params.length}`);
      }
      if (filter.q) {
        params.push(likePattern(filter.q));
        const n = params.length;
        where.push(`(question ILIKE $${n} OR answer ILIKE $${n}
          OR EXISTS (SELECT 1 FROM unnest(keywords) AS k WHERE k ILIKE $${n}))`);
      }
      const rows = await db.query(
        `SELECT ${COLUMNS} FROM helpdesk_questions
          WHERE ${where.join(' AND ')}
          ORDER BY locale, sort_order, created_at, id
          LIMIT 1000`,
        params,
      );
      return rows.map(toQuestion);
    },

    async get(id) {
      const rows = await db.query(
        `SELECT ${COLUMNS} FROM helpdesk_questions WHERE id = $1`,
        [id],
      );
      return rows.length > 0 ? toQuestion(rows[0]) : null;
    },

    async nextSortOrder(locale) {
      const rows = await db.query(
        `SELECT COALESCE(MAX(sort_order), 0) + 10 AS next
           FROM helpdesk_questions WHERE locale = $1`,
        [locale],
      );
      return Number(rows[0]?.next ?? 10);
    },

    insert(question, employeeId) {
      return db.withTransaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO helpdesk_questions
             (id, locale, category, question, answer, keywords, status, featured,
              sort_order, version, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, 1, $10, $10)
           RETURNING ${COLUMNS}`,
          [
            question.id,
            question.locale,
            question.category,
            question.question,
            question.answer,
            question.keywords,
            question.status,
            question.featured,
            question.sortOrder,
            employeeId,
          ],
        );
        const created = toQuestion(rows[0]);
        await writeRevision(client, created, 'create', employeeId);
        return created;
      });
    },

    update(id, expectedVersion, patch, action, employeeId) {
      return db.withTransaction(async (client) => {
        const params: unknown[] = [id, expectedVersion, employeeId];
        const sets = [
          'version = version + 1',
          'updated_by = $3',
          'updated_at = now()',
        ];
        for (const [key, column] of Object.entries(PATCH_COLUMNS) as [
          keyof QuestionPatch,
          string,
        ][]) {
          if (patch[key] === undefined) continue;
          params.push(patch[key]);
          sets.push(
            `${column} = $${params.length}${key === 'keywords' ? '::text[]' : ''}`,
          );
        }
        const { rows } = await client.query(
          `UPDATE helpdesk_questions SET ${sets.join(', ')}
            WHERE id = $1 AND version = $2
            RETURNING ${COLUMNS}`,
          params,
        );
        if (rows.length === 0) {
          const version = await currentVersion(client, id);
          return version === null
            ? { kind: 'not_found' as const }
            : { kind: 'conflict' as const, currentVersion: version };
        }
        const updated = toQuestion(rows[0]);
        await writeRevision(client, updated, action, employeeId);
        return { kind: 'ok' as const, value: updated };
      });
    },

    reorder(items, employeeId) {
      return db.withTransaction(async (client) => {
        const ids = items.map((item) => item.id);
        const { rows } = await client.query(
          `SELECT id, version, sort_order FROM helpdesk_questions
            WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
          [ids],
        );
        const found = new Map(rows.map((row) => [String(row.id), row]));
        for (const item of items) {
          const row = found.get(item.id);
          if (!row) return { kind: 'not_found' as const };
          if (Number(row.version) !== item.version)
            return {
              kind: 'conflict' as const,
              currentVersion: Number(row.version),
            };
        }
        const out: HelpdeskQuestion[] = [];
        for (const [index, item] of items.entries()) {
          const sortOrder = (index + 1) * 10;
          if (Number(found.get(item.id)?.sort_order) === sortOrder) {
            const same = await client.query(
              `SELECT ${COLUMNS} FROM helpdesk_questions WHERE id = $1`,
              [item.id],
            );
            out.push(toQuestion(same.rows[0]));
            continue;
          }
          const updated = await client.query(
            `UPDATE helpdesk_questions
                SET sort_order = $3, version = version + 1,
                    updated_by = $4, updated_at = now()
              WHERE id = $1 AND version = $2
              RETURNING ${COLUMNS}`,
            [item.id, item.version, sortOrder, employeeId],
          );
          const question = toQuestion(updated.rows[0]);
          await writeRevision(client, question, 'update', employeeId);
          out.push(question);
        }
        return { kind: 'ok' as const, value: out };
      });
    },

    async revisions(id) {
      const rows = await db.query(
        `SELECT id, question_id, version, snapshot, action, employee_id, at
           FROM helpdesk_question_revisions
          WHERE question_id = $1
          ORDER BY version DESC`,
        [id],
      );
      return rows.map(toRevision);
    },

    async listPublished(locale, featuredOnly) {
      const rows = await db.query(
        `SELECT ${COLUMNS} FROM helpdesk_questions
          WHERE locale = $1 AND status = 'published'
            AND ($2::boolean = false OR featured)
          ORDER BY sort_order, created_at, id`,
        [locale, featuredOnly],
      );
      return rows.map(toQuestion);
    },

    async searchCandidates(search) {
      const text = search.text.trim();
      if (text === '') return [];
      const { tsquery, bigrams } = searchTerms(text);
      const limit = Math.min(
        Math.max(1, Math.floor(search.limit)),
        QUESTION_LIMITS.candidatesMax,
      );
      const rows = await db.query(CANDIDATES_SQL, [
        search.locale,
        search.category,
        tsquery,
        text,
        bigrams,
        limit,
      ]);
      return rows.map((row) => ({
        id: String(row.id),
        category: row.category as HelpdeskCategory,
        question: String(row.question),
        answer: String(row.answer),
        score: Number(row.score),
      }));
    },
  };
}

/** Agent 用的候选来源（契约 HelpdeskQaSource 的实现；由 app.module.ts 交给 AiModule）。 */
export function createPgHelpdeskQaSource(
  repository: QuestionRepository = createPgQuestionRepository(),
): HelpdeskQaSource {
  return {
    findCandidates: (search) => repository.searchCandidates(search),
  };
}
