import type {
  FaqEdgeKind,
  FaqReleaseStatus,
} from '../../../../contracts/helpdesk-qa';
import { query, withTransaction } from '../../../lib/db';
import { uuidv7 } from '../../../../common/uuidv7';
import type {
  FaqEdgeRevision,
  FaqEdgeRevisionAction,
  FaqEdgeRow,
  FaqPhrasing,
  HelpdeskFaq,
  PhrasingLocale,
  PhrasingSource,
} from './faqContracts';
import type { FaqGraphCheckResult } from './faqGraphChecks';
import { phrasingSearchText } from './faqKeys';
import type { FaqReleaseSnapshot } from './faqRelease';
import { toFaq, type SqlClient, type SqlDb } from './faqRepository';

/**
 * v5 FAQ 问题树的 PostgreSQL 读写（helpdesk-v5-faq-graph-design §2，迁移 20261030150000）。原生 SQL，
 * 与 faqRepository.ts 同一个 SqlDb。
 * - 边的每次写入都先拿同一把事务级 advisory 锁（helpdesk_faq_graph），所以「成环检查（递归 CTE）+ 插入」
 *   与另一个并发的建边不会交错：两条互相指向的边不可能同时通过；
 * - 每次建 / 改 / 删边，同一事务里追加一行 helpdesk_faq_edge_revisions（改前 / 改后）；
 * - 问法按 (faq_id, locale, lower(text)) 唯一：同一个再加一次返回已有的那条；
 * - 发布版本：新建时版本号 = 最大 + 1（另一把锁 helpdesk_faq_releases），快照与它的检索行
 *   （helpdesk_faq_release_nodes）同一事务写入；发布 = 同一事务里旧的 published → superseded、
 *   新的 → published（部分唯一索引保证至多一行 published）。
 */

type Row = Record<string, unknown>;

const defaultDb: SqlDb = {
  query: (sql, params) => query<Row>(sql, params),
  withTransaction: (fn) => withTransaction((client) => fn(client)),
};

const GRAPH_LOCK = `SELECT pg_advisory_xact_lock(hashtext('helpdesk_faq_graph'))`;
const RELEASE_LOCK = `SELECT pg_advisory_xact_lock(hashtext('helpdesk_faq_releases'))`;

const EDGE_COLUMNS = `id, parent_id, child_id, kind, position, label_en, label_zh,
  created_by, created_at, updated_at`;

const FAQ_COLUMNS = `id, key, node_type, entry, category, popular, question_en, answer_en,
  question_zh, answer_zh, keywords, signals, status, version, created_by, updated_by,
  created_at, updated_at`;

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : '';
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function toEdge(row: Row): FaqEdgeRow {
  return {
    id: String(row.id),
    parentId: String(row.parent_id),
    childId: String(row.child_id),
    kind: row.kind as FaqEdgeKind,
    position: Number(row.position),
    labelEn: (row.label_en as string | null) ?? null,
    labelZh: (row.label_zh as string | null) ?? null,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toPhrasing(row: Row): FaqPhrasing {
  return {
    id: String(row.id),
    faqId: String(row.faq_id),
    locale: row.locale as PhrasingLocale,
    text: String(row.text),
    source: row.source as PhrasingSource,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: iso(row.created_at),
  };
}

function toEdgeRevision(row: Row): FaqEdgeRevision {
  return {
    id: String(row.id),
    edgeId: String(row.edge_id),
    parentId: String(row.parent_id),
    childId: String(row.child_id),
    action: row.action as FaqEdgeRevisionAction,
    before: (row.before as FaqEdgeRow | null) ?? null,
    after: (row.after as FaqEdgeRow | null) ?? null,
    employeeId: (row.employee_id as string | null) ?? null,
    at: iso(row.at),
  };
}

async function writeEdgeRevision(
  client: SqlClient,
  action: FaqEdgeRevisionAction,
  before: FaqEdgeRow | null,
  after: FaqEdgeRow | null,
  employeeId: string | null,
): Promise<void> {
  const edge = (after ?? before)!;
  await client.query(
    `INSERT INTO helpdesk_faq_edge_revisions
       (id, edge_id, parent_id, child_id, action, before, after, employee_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
    [
      uuidv7(),
      edge.id,
      edge.parentId,
      edge.childId,
      action,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      employeeId,
    ],
  );
}

/** 节点的一个摘要（列表、树、父节点清单用）。 */
export type FaqNodeSummary = Pick<
  HelpdeskFaq,
  | 'id'
  | 'key'
  | 'type'
  | 'entry'
  | 'category'
  | 'questionEn'
  | 'questionZh'
  | 'status'
>;

export type NewEdge = {
  parentId: string;
  childId: string;
  kind: FaqEdgeKind;
  /** 不给 = 排在最后。 */
  position: number | null;
  labelEn: string | null;
  labelZh: string | null;
};

export type CreateEdgeResult =
  | { kind: 'created'; edge: FaqEdgeRow }
  /** 这对父子已经有边（幂等：原样返回，什么都不写）。 */
  | { kind: 'exists'; edge: FaqEdgeRow }
  | { kind: 'missing'; ids: string[] }
  | { kind: 'archived'; ids: string[] }
  /** 子节点能走回父节点：加上就成环。 */
  | { kind: 'cycle' }
  | { kind: 'full'; count: number };

export type EdgeLabels = { labelEn: string | null; labelZh: string | null };

export type FaqReleaseRow = {
  id: string;
  version: number;
  status: FaqReleaseStatus;
  snapshotHash: string;
  checks: FaqGraphCheckResult;
  evalReport: unknown;
  sourceVersion: number | null;
  createdBy: string | null;
  createdAt: string;
  publishedBy: string | null;
  publishedAt: string | null;
};

export type FaqReleaseWithSnapshot = FaqReleaseRow & {
  snapshot: FaqReleaseSnapshot;
};

export type NewRelease = {
  snapshot: FaqReleaseSnapshot;
  snapshotHash: string;
  checks: FaqGraphCheckResult;
  status: FaqReleaseStatus;
  evalReport: unknown;
  sourceVersion: number | null;
  employeeId: string | null;
  /**
   * true（「发布新版本」）：在同一把锁里，最新的版本或当前发布的版本快照指纹一样 → 不新建，
   * 返回那一版（并发的两次点击也只有一个版本）。回滚是 false。
   */
  dedupe: boolean;
};

export type PublishResult =
  | { kind: 'published'; release: FaqReleaseRow; previous: number | null }
  | { kind: 'already'; release: FaqReleaseRow }
  | { kind: 'not_found' }
  | { kind: 'not_ready'; release: FaqReleaseRow }
  /** 版本比上线的旧，或评测时对比的不是现在上线的那一版。 */
  | { kind: 'stale'; release: FaqReleaseRow; published: number | null };

/** 能否发布（服务层判断，仓库在发布锁里带着当前上线的版本号调用）。 */
export type PublishReadiness = 'ok' | 'not_ready' | 'stale';

const RELEASE_COLUMNS = `id, version, status, snapshot_hash, checks, eval_report, source_version,
  created_by, created_at, published_by, published_at`;

function toRelease(row: Row): FaqReleaseRow {
  return {
    id: String(row.id),
    version: Number(row.version),
    status: row.status as FaqReleaseStatus,
    snapshotHash: String(row.snapshot_hash),
    checks: row.checks as FaqGraphCheckResult,
    evalReport: row.eval_report ?? null,
    sourceVersion:
      row.source_version === null || row.source_version === undefined
        ? null
        : Number(row.source_version),
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: iso(row.created_at),
    publishedBy: (row.published_by as string | null) ?? null,
    publishedAt: isoOrNull(row.published_at),
  };
}

/** 发布版本检索行的列（与 helpdesk_faqs 同名），由快照派生。 */
const RELEASE_NODE_RECORD = `id uuid, key text, type text, entry boolean, category text,
  popular boolean, "questionEn" text, "answerEn" text, "questionZh" text, "answerZh" text,
  keywords text[], signals text[], version int, "updatedAt" timestamptz, "phrasingText" text`;

export function createPgFaqGraphRepository(db: SqlDb = defaultDb) {
  async function edgeFor(
    client: SqlClient,
    id: string,
    lock = false,
  ): Promise<FaqEdgeRow | null> {
    const { rows } = await client.query(
      `SELECT ${EDGE_COLUMNS} FROM helpdesk_faq_edges WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return rows.length > 0 ? toEdge(rows[0]) : null;
  }

  return {
    // ----------------------------------------------------------------- 节点

    /** 冻结用：一致的一份工作表（REPEATABLE READ：节点、边、问法是同一时刻的）。 */
    working(): Promise<{
      faqs: HelpdeskFaq[];
      edges: FaqEdgeRow[];
      phrasings: FaqPhrasing[];
    }> {
      return db.withTransaction(async (client) => {
        await client.query(
          'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
        );
        const faqs = await client.query(
          `SELECT ${FAQ_COLUMNS} FROM helpdesk_faqs WHERE status = 'published' ORDER BY id`,
        );
        const edges = await client.query(
          `SELECT ${EDGE_COLUMNS} FROM helpdesk_faq_edges ORDER BY parent_id, position, created_at, id`,
        );
        const phrasings = await client.query(
          `SELECT p.id, p.faq_id, p.locale, p.text, p.source, p.created_by, p.created_at
             FROM helpdesk_faq_phrasings p
             JOIN helpdesk_faqs f ON f.id = p.faq_id AND f.status = 'published'
            ORDER BY p.faq_id, p.created_at, p.id`,
        );
        return {
          faqs: faqs.rows.map(toFaq),
          edges: edges.rows.map(toEdge),
          phrasings: phrasings.rows.map(toPhrasing),
        };
      });
    },

    async summaries(ids: readonly string[]): Promise<FaqNodeSummary[]> {
      if (ids.length === 0) return [];
      const rows = await db.query(
        `SELECT ${FAQ_COLUMNS} FROM helpdesk_faqs WHERE id = ANY ($1::uuid[])`,
        [[...new Set(ids)]],
      );
      return rows.map(toFaq);
    },

    /** 还在用这个节点的已发布父节点（归档前检查）。 */
    async liveParents(childId: string): Promise<FaqNodeSummary[]> {
      const rows = await db.query(
        `SELECT f.id, f.key, f.node_type, f.entry, f.category, f.popular, f.question_en,
                f.answer_en, f.question_zh, f.answer_zh, f.keywords, f.signals, f.status,
                f.version, f.created_by, f.updated_by, f.created_at, f.updated_at
           FROM helpdesk_faq_edges e
           JOIN helpdesk_faqs f ON f.id = e.parent_id AND f.status = 'published'
          WHERE e.child_id = $1
          ORDER BY e.created_at, e.id`,
        [childId],
      );
      return rows.map(toFaq);
    },

    // ----------------------------------------------------------------- 边

    async allEdges(): Promise<FaqEdgeRow[]> {
      const rows = await db.query(
        `SELECT ${EDGE_COLUMNS} FROM helpdesk_faq_edges ORDER BY parent_id, position, created_at, id`,
      );
      return rows.map(toEdge);
    },

    async edgesOf(
      faqId: string,
    ): Promise<{ children: FaqEdgeRow[]; parents: FaqEdgeRow[] }> {
      const rows = await db.query(
        `SELECT ${EDGE_COLUMNS} FROM helpdesk_faq_edges
          WHERE parent_id = $1 OR child_id = $1
          ORDER BY position, created_at, id`,
        [faqId],
      );
      const edges = rows.map(toEdge);
      return {
        children: edges.filter((edge) => edge.parentId === faqId),
        parents: edges.filter((edge) => edge.childId === faqId),
      };
    },

    async getEdge(id: string): Promise<FaqEdgeRow | null> {
      const rows = await db.query(
        `SELECT ${EDGE_COLUMNS} FROM helpdesk_faq_edges WHERE id = $1`,
        [id],
      );
      return rows.length > 0 ? toEdge(rows[0]) : null;
    },

    /**
     * 建边（同一事务、同一把锁）：两端都在且已发布 → 这对父子已有边就原样返回 → 父节点同类的边
     * 已满（maxChildren）→ 子节点能否走回父节点（递归 CTE，加上就成环）→ 插入（position 不给 = 最后）
     * 并追加修订。
     */
    createEdge(
      edge: NewEdge,
      maxChildren: number,
      employeeId: string | null,
    ): Promise<CreateEdgeResult> {
      return db.withTransaction(async (client) => {
        await client.query(GRAPH_LOCK);
        const ends = await client.query(
          `SELECT id, status FROM helpdesk_faqs WHERE id = ANY ($1::uuid[]) FOR SHARE`,
          [[edge.parentId, edge.childId]],
        );
        const found = new Map(
          ends.rows.map((row) => [String(row.id), String(row.status)]),
        );
        const missing = [edge.parentId, edge.childId].filter(
          (id) => !found.has(id),
        );
        if (missing.length > 0) return { kind: 'missing', ids: missing };
        const archived = [edge.parentId, edge.childId].filter(
          (id) => found.get(id) !== 'published',
        );
        if (archived.length > 0) return { kind: 'archived', ids: archived };
        const existing = await client.query(
          `SELECT ${EDGE_COLUMNS} FROM helpdesk_faq_edges WHERE parent_id = $1 AND child_id = $2`,
          [edge.parentId, edge.childId],
        );
        if (existing.rows.length > 0)
          return { kind: 'exists', edge: toEdge(existing.rows[0]) };
        const count = await client.query(
          `SELECT count(*)::int AS n FROM helpdesk_faq_edges WHERE parent_id = $1 AND kind = $2`,
          [edge.parentId, edge.kind],
        );
        const n = Number(count.rows[0].n);
        if (n >= maxChildren) return { kind: 'full', count: n };
        const cycle = await client.query(
          `WITH RECURSIVE reach(id) AS (
             SELECT $1::uuid
             UNION
             SELECT e.child_id FROM helpdesk_faq_edges e JOIN reach r ON e.parent_id = r.id
           )
           SELECT 1 FROM reach WHERE id = $2::uuid LIMIT 1`,
          [edge.childId, edge.parentId],
        );
        if (cycle.rows.length > 0) return { kind: 'cycle' };
        const { rows } = await client.query(
          `INSERT INTO helpdesk_faq_edges
             (id, parent_id, child_id, kind, position, label_en, label_zh, created_by)
           VALUES ($1, $2, $3, $4,
                   COALESCE($5::smallint,
                            (SELECT COALESCE(max(position) + 1, 0) FROM helpdesk_faq_edges
                              WHERE parent_id = $2)),
                   $6, $7, $8)
           RETURNING ${EDGE_COLUMNS}`,
          [
            uuidv7(),
            edge.parentId,
            edge.childId,
            edge.kind,
            edge.position,
            edge.labelEn,
            edge.labelZh,
            employeeId,
          ],
        );
        const created = toEdge(rows[0]);
        await writeEdgeRevision(client, 'create', null, created, employeeId);
        return { kind: 'created', edge: created };
      });
    },

    /** 改覆盖文字；内容一样什么都不写（幂等）。没有这条边 → null。 */
    updateEdgeLabels(
      id: string,
      labels: EdgeLabels,
      employeeId: string | null,
    ): Promise<{ edge: FaqEdgeRow; changed: boolean } | null> {
      return db.withTransaction(async (client) => {
        await client.query(GRAPH_LOCK);
        const before = await edgeFor(client, id, true);
        if (!before) return null;
        if (
          before.labelEn === labels.labelEn &&
          before.labelZh === labels.labelZh
        )
          return { edge: before, changed: false };
        const { rows } = await client.query(
          `UPDATE helpdesk_faq_edges SET label_en = $2, label_zh = $3, updated_at = now()
            WHERE id = $1 RETURNING ${EDGE_COLUMNS}`,
          [id, labels.labelEn, labels.labelZh],
        );
        const after = toEdge(rows[0]);
        await writeEdgeRevision(client, 'update', before, after, employeeId);
        return { edge: after, changed: true };
      });
    },

    /** 删边；已经没有了 → null（幂等）。 */
    deleteEdge(
      id: string,
      employeeId: string | null,
    ): Promise<FaqEdgeRow | null> {
      return db.withTransaction(async (client) => {
        await client.query(GRAPH_LOCK);
        const before = await edgeFor(client, id, true);
        if (!before) return null;
        await client.query('DELETE FROM helpdesk_faq_edges WHERE id = $1', [
          id,
        ]);
        await writeEdgeRevision(client, 'delete', before, null, employeeId);
        return before;
      });
    },

    /**
     * 重排一个父节点下的子节点：childIds 必须正好是现有的子节点（否则 mismatch，什么都不改），
     * position 改成 0..n-1；只给变了的边写修订。
     */
    reorder(
      parentId: string,
      childIds: readonly string[],
      employeeId: string | null,
    ): Promise<
      | { kind: 'ok'; edges: FaqEdgeRow[] }
      | { kind: 'mismatch'; current: string[] }
    > {
      return db.withTransaction(async (client) => {
        await client.query(GRAPH_LOCK);
        const { rows } = await client.query(
          `SELECT ${EDGE_COLUMNS} FROM helpdesk_faq_edges WHERE parent_id = $1
            ORDER BY position, created_at, id FOR UPDATE`,
          [parentId],
        );
        const current = rows.map(toEdge);
        const ids = current.map((edge) => edge.childId);
        if (
          ids.length !== childIds.length ||
          new Set(childIds).size !== childIds.length ||
          !childIds.every((id) => ids.includes(id))
        )
          return { kind: 'mismatch', current: ids };
        const out: FaqEdgeRow[] = [];
        for (const [position, childId] of childIds.entries()) {
          const before = current.find((edge) => edge.childId === childId)!;
          if (before.position === position) {
            out.push(before);
            continue;
          }
          const updated = await client.query(
            `UPDATE helpdesk_faq_edges SET position = $2, updated_at = now()
              WHERE id = $1 RETURNING ${EDGE_COLUMNS}`,
            [before.id, position],
          );
          const after = toEdge(updated.rows[0]);
          await writeEdgeRevision(client, 'update', before, after, employeeId);
          out.push(after);
        }
        return { kind: 'ok', edges: out };
      });
    },

    async edgeRevisions(faqId: string): Promise<FaqEdgeRevision[]> {
      const rows = await db.query(
        `SELECT id, edge_id, parent_id, child_id, action, before, after, employee_id, at
           FROM helpdesk_faq_edge_revisions
          WHERE parent_id = $1 OR child_id = $1
          ORDER BY at DESC, id DESC`,
        [faqId],
      );
      return rows.map(toEdgeRevision);
    },

    // ----------------------------------------------------------------- 问法

    async phrasingsOf(faqId: string): Promise<FaqPhrasing[]> {
      const rows = await db.query(
        `SELECT id, faq_id, locale, text, source, created_by, created_at
           FROM helpdesk_faq_phrasings WHERE faq_id = $1 ORDER BY created_at, id`,
        [faqId],
      );
      return rows.map(toPhrasing);
    },

    /** 加一种问法；同一条 FAQ、同一语言、不分大小写一样的已经有了 → 返回那条（created=false）。 */
    async insertPhrasing(phrasing: {
      faqId: string;
      locale: PhrasingLocale;
      text: string;
      source: PhrasingSource;
      employeeId: string | null;
    }): Promise<{ phrasing: FaqPhrasing; created: boolean }> {
      const rows = await db.query(
        `INSERT INTO helpdesk_faq_phrasings (id, faq_id, locale, text, search_text, source, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (faq_id, locale, lower(text)) DO NOTHING
         RETURNING id, faq_id, locale, text, source, created_by, created_at`,
        [
          uuidv7(),
          phrasing.faqId,
          phrasing.locale,
          phrasing.text,
          phrasingSearchText(phrasing.text),
          phrasing.source,
          phrasing.employeeId,
        ],
      );
      if (rows.length > 0)
        return { phrasing: toPhrasing(rows[0]), created: true };
      const existing = await db.query(
        `SELECT id, faq_id, locale, text, source, created_by, created_at
           FROM helpdesk_faq_phrasings
          WHERE faq_id = $1 AND locale = $2 AND lower(text) = lower($3)`,
        [phrasing.faqId, phrasing.locale, phrasing.text],
      );
      return { phrasing: toPhrasing(existing[0]), created: false };
    },

    async getPhrasing(id: string): Promise<FaqPhrasing | null> {
      const rows = await db.query(
        `SELECT id, faq_id, locale, text, source, created_by, created_at
           FROM helpdesk_faq_phrasings WHERE id = $1`,
        [id],
      );
      return rows.length > 0 ? toPhrasing(rows[0]) : null;
    },

    /** 删一种问法；已经没有了 → null（幂等）。 */
    async deletePhrasing(id: string): Promise<FaqPhrasing | null> {
      const rows = await db.query(
        `DELETE FROM helpdesk_faq_phrasings WHERE id = $1
         RETURNING id, faq_id, locale, text, source, created_by, created_at`,
        [id],
      );
      return rows.length > 0 ? toPhrasing(rows[0]) : null;
    },

    // ----------------------------------------------------------------- 发布版本

    async releases(): Promise<FaqReleaseRow[]> {
      const rows = await db.query(
        `SELECT ${RELEASE_COLUMNS} FROM helpdesk_faq_releases ORDER BY version DESC`,
      );
      return rows.map(toRelease);
    },

    async release(version: number): Promise<FaqReleaseWithSnapshot | null> {
      const rows = await db.query(
        `SELECT ${RELEASE_COLUMNS}, snapshot FROM helpdesk_faq_releases WHERE version = $1`,
        [version],
      );
      if (rows.length === 0) return null;
      return {
        ...toRelease(rows[0]),
        snapshot: rows[0].snapshot as FaqReleaseSnapshot,
      };
    },

    /** 当前发布的版本号与发布时间（没有 → null）：每次运行时读，一个索引查询。 */
    async published(): Promise<{
      id: string;
      version: number;
      publishedAt: string;
    } | null> {
      const rows = await db.query(
        `SELECT id, version, published_at FROM helpdesk_faq_releases WHERE status = 'published'`,
      );
      if (rows.length === 0) return null;
      return {
        id: String(rows[0].id),
        version: Number(rows[0].version),
        publishedAt: iso(rows[0].published_at),
      };
    },

    async latest(): Promise<FaqReleaseRow | null> {
      const rows = await db.query(
        `SELECT ${RELEASE_COLUMNS} FROM helpdesk_faq_releases ORDER BY version DESC LIMIT 1`,
      );
      return rows.length > 0 ? toRelease(rows[0]) : null;
    },

    /** 新建一个版本：版本号 = 最大 + 1；快照与派生的检索行同一事务写入。 */
    insertRelease(
      release: NewRelease,
    ): Promise<{ release: FaqReleaseRow; created: boolean }> {
      return db.withTransaction(async (client) => {
        await client.query(RELEASE_LOCK);
        if (release.dedupe) {
          const same = await client.query(
            `SELECT ${RELEASE_COLUMNS} FROM helpdesk_faq_releases
              WHERE snapshot_hash = $1
                AND (version = (SELECT max(version) FROM helpdesk_faq_releases)
                     OR status = 'published')
              ORDER BY version DESC LIMIT 1`,
            [release.snapshotHash],
          );
          if (same.rows.length > 0)
            return { release: toRelease(same.rows[0]), created: false };
        }
        const next = await client.query(
          'SELECT COALESCE(max(version), 0) + 1 AS v FROM helpdesk_faq_releases',
        );
        const version = Number(next.rows[0].v);
        const { rows } = await client.query(
          `INSERT INTO helpdesk_faq_releases
             (id, version, status, snapshot, snapshot_hash, checks, eval_report, source_version,
              created_by)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7::jsonb, $8, $9)
           RETURNING ${RELEASE_COLUMNS}`,
          [
            uuidv7(),
            version,
            release.status,
            JSON.stringify(release.snapshot),
            release.snapshotHash,
            JSON.stringify(release.checks),
            release.evalReport === null
              ? null
              : JSON.stringify(release.evalReport),
            release.sourceVersion,
            release.employeeId,
          ],
        );
        const phrasingText = new Map<string, string[]>();
        for (const phrasing of release.snapshot.phrasings) {
          const list = phrasingText.get(phrasing.faqId) ?? [];
          list.push(phrasingSearchText(phrasing.text));
          phrasingText.set(phrasing.faqId, list);
        }
        const records = release.snapshot.nodes.map((node) => ({
          ...node,
          phrasingText: (phrasingText.get(node.id) ?? []).join('\n'),
        }));
        await client.query(
          `INSERT INTO helpdesk_faq_release_nodes
             (release_version, id, key, node_type, entry, category, popular, question_en,
              answer_en, question_zh, answer_zh, keywords, signals, version, created_at,
              updated_at, phrasing_text)
           SELECT $1, n.id, n.key, n.type, n.entry, n.category, n.popular, n."questionEn",
                  n."answerEn", n."questionZh", n."answerZh", COALESCE(n.keywords, '{}'),
                  COALESCE(n.signals, '{}'), COALESCE(n.version, 1),
                  COALESCE(n."updatedAt", now()), COALESCE(n."updatedAt", now()),
                  COALESCE(n."phrasingText", '')
             FROM jsonb_to_recordset($2::jsonb) AS n(${RELEASE_NODE_RECORD})`,
          [version, JSON.stringify(records)],
        );
        return { release: toRelease(rows[0]), created: true };
      });
    },

    /** 只在当前状态是 from 之一时改状态（与评测报告）；不是 → null。 */
    async setStatus(
      version: number,
      from: readonly FaqReleaseStatus[],
      to: FaqReleaseStatus,
      evalReport?: unknown,
    ): Promise<FaqReleaseRow | null> {
      const rows = await db.query(
        `UPDATE helpdesk_faq_releases
            SET status = $3,
                eval_report = CASE WHEN $4::boolean THEN $5::jsonb ELSE eval_report END
          WHERE version = $1 AND status = ANY ($2::text[])
          RETURNING ${RELEASE_COLUMNS}`,
        [
          version,
          [...from],
          to,
          evalReport !== undefined,
          evalReport === undefined ? null : JSON.stringify(evalReport),
        ],
      );
      return rows.length > 0 ? toRelease(rows[0]) : null;
    },

    /**
     * 发布（原子）：同一事务里旧的 published → superseded、这一版 → published。已经是 published
     * → already（幂等）；不是 draft，或检查 / 评测没过 → not_ready；比上线的旧、或评测对比的不是
     * 现在上线的那一版 → stale（ready 由服务层判断，在锁里带着当前上线的版本号调用，并发发布也一致）。
     */
    publish(
      version: number,
      ready: (
        release: FaqReleaseRow,
        publishedVersion: number | null,
      ) => PublishReadiness,
      employeeId: string | null,
    ): Promise<PublishResult> {
      return db.withTransaction(async (client) => {
        await client.query(RELEASE_LOCK);
        const target = await client.query(
          `SELECT ${RELEASE_COLUMNS} FROM helpdesk_faq_releases WHERE version = $1 FOR UPDATE`,
          [version],
        );
        if (target.rows.length === 0) return { kind: 'not_found' };
        const release = toRelease(target.rows[0]);
        if (release.status === 'published') return { kind: 'already', release };
        const live = await client.query(
          `SELECT version FROM helpdesk_faq_releases WHERE status = 'published'`,
        );
        const published =
          live.rows.length > 0 ? Number(live.rows[0].version) : null;
        const readiness =
          release.status === 'draft' ? ready(release, published) : 'not_ready';
        if (readiness === 'not_ready') return { kind: 'not_ready', release };
        if (readiness === 'stale') return { kind: 'stale', release, published };
        const old = await client.query(
          `UPDATE helpdesk_faq_releases SET status = 'superseded'
            WHERE status = 'published' RETURNING version`,
        );
        const { rows } = await client.query(
          `UPDATE helpdesk_faq_releases
              SET status = 'published', published_by = $2, published_at = clock_timestamp()
            WHERE version = $1 RETURNING ${RELEASE_COLUMNS}`,
          [version, employeeId],
        );
        return {
          kind: 'published',
          release: toRelease(rows[0]),
          previous: old.rows.length > 0 ? Number(old.rows[0].version) : null,
        };
      });
    },
  };
}

export type FaqGraphRepository = ReturnType<typeof createPgFaqGraphRepository>;
