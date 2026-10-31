import { uuidv7 } from '../../../../common/uuidv7';
import { query, withTransaction } from '../../../lib/db';
import { HelpdeskError } from '../portalHelpdeskClient';
import type { FaqActor } from './faqContracts';
import {
  isPlaceable,
  MAP_NODE_KINDS,
  type FaqMapNode,
  type FaqMapNodeKind,
  type FaqPlacement,
} from './faqMap';
import { ATTRIBUTES, type Attribute } from './locator/questionType';
import type { SqlClient, SqlDb } from './faqRepository';

/**
 * 流程树与对象表的 PostgreSQL 读写（迁移 20261031120000，设计文档第五节）。原生 SQL，与 faqRepository.ts
 * 同一个 SqlDb；Prisma 只管表结构与迁移。
 * - 每次写都先拿同一把事务级 advisory 锁（helpdesk_faq_map）：「检查父节点的种类 + 插入」不会和另一个
 *   并发的「改种类」交错（触发器在 READ COMMITTED 下看不到对方没提交的行）；
 * - 每次建 / 改 / 删节点或挂载，同一事务里追加一行 helpdesk_faq_map_revisions（谁、何时、改前 / 改后）；
 * - 幂等：按 key 建节点，同样的内容再建一次什么都不写；挂载按「这张卡应该挂在哪」整组给，只写差异；
 * - 乐观锁：改节点要带读到的 version，别人先改了 → 409 FAQ_MAP_CONFLICT。
 */

type Row = Record<string, unknown>;

const defaultDb: SqlDb = {
  query: (sql, params) => query<Row>(sql, params),
  withTransaction: (fn) => withTransaction((client) => fn(client)),
};

const MAP_LOCK = `SELECT pg_advisory_xact_lock(hashtext('helpdesk_faq_map'))`;

export const MAP_NODE_COLUMNS = `id, key, kind, parent_id, stage_id, attribute, position, label_en,
  label_zh, version, created_by, updated_by, created_at, updated_at`;
export const PLACEMENT_COLUMNS = `id, faq_id, node_id, is_primary, created_by, created_at`;

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : '';
}

const idOrNull = (value: unknown) => (typeof value === 'string' ? value : null);

export function toMapNode(row: Row): FaqMapNode {
  return {
    id: String(row.id),
    key: String(row.key),
    kind: row.kind as FaqMapNodeKind,
    parentId: idOrNull(row.parent_id),
    stageId: idOrNull(row.stage_id),
    attribute: (row.attribute ?? null) as Attribute | null,
    position: Number(row.position),
    labelEn: String(row.label_en),
    labelZh: String(row.label_zh),
    version: Number(row.version),
    createdBy: idOrNull(row.created_by),
    updatedBy: idOrNull(row.updated_by),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toPlacement(row: Row): FaqPlacement {
  return {
    id: String(row.id),
    faqId: String(row.faq_id),
    nodeId: String(row.node_id),
    primary: row.is_primary === true,
    createdBy: idOrNull(row.created_by),
    createdAt: iso(row.created_at),
  };
}

/** 建节点用：父节点、所属阶段按 key 给（种子文件和界面都按 key 说话）。 */
export type MapNodeInput = {
  key: string;
  kind: FaqMapNodeKind;
  parentKey: string | null;
  stageKey: string | null;
  attribute: Attribute | null;
  position: number;
  labelEn: string;
  labelZh: string;
};

export type MapNodePatch = Partial<
  Pick<MapNodeInput, 'position' | 'labelEn' | 'labelZh'>
>;

export type PlacementInput = { nodeKey: string; primary: boolean };

export type MapRevision = {
  id: string;
  entity: 'node' | 'placement';
  entityId: string;
  action: 'create' | 'update' | 'delete';
  before: unknown;
  after: unknown;
  employeeId: string | null;
  at: string;
};

const invalid = (message: string) =>
  new HelpdeskError(400, 'INVALID_INPUT', message);
const conflict = (message: string) =>
  new HelpdeskError(409, 'FAQ_MAP_CONFLICT', message);

async function revision(
  client: SqlClient,
  entity: MapRevision['entity'],
  entityId: string,
  action: MapRevision['action'],
  before: unknown,
  after: unknown,
  actor: FaqActor,
): Promise<void> {
  await client.query(
    `INSERT INTO helpdesk_faq_map_revisions (id, entity, entity_id, action, before, after, employee_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
    [
      uuidv7(),
      entity,
      entityId,
      action,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      actor.employeeId,
    ],
  );
}

async function nodeByKey(
  client: SqlClient,
  key: string,
): Promise<FaqMapNode | null> {
  const { rows } = await client.query(
    `SELECT ${MAP_NODE_COLUMNS} FROM helpdesk_faq_map_nodes WHERE key = $1`,
    [key],
  );
  return rows.length > 0 ? toMapNode(rows[0]) : null;
}

/** 数据库的约束 / 触发器错误 → 400（形状不对）或 409（还有卡或子节点挂着）。 */
function mapDbError(error: unknown): never {
  const code = (error as { code?: string }).code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === '23503')
    throw conflict('Cards or child nodes still hang on this node');
  if (code === '23505') throw conflict('That place is already taken');
  if (code === '23514' || code === 'P0001') throw invalid(message);
  throw error;
}

export type FaqMapRepository = ReturnType<typeof createPgFaqMapRepository>;

export function createPgFaqMapRepository(db: SqlDb = defaultDb) {
  return {
    async nodes(): Promise<FaqMapNode[]> {
      const rows = await db.query(
        `SELECT ${MAP_NODE_COLUMNS} FROM helpdesk_faq_map_nodes ORDER BY key`,
      );
      return rows.map(toMapNode);
    },

    async placements(faqId?: string): Promise<FaqPlacement[]> {
      const rows = await db.query(
        `SELECT ${PLACEMENT_COLUMNS} FROM helpdesk_faq_placements
          WHERE $1::uuid IS NULL OR faq_id = $1::uuid
          ORDER BY faq_id, node_id`,
        [faqId ?? null],
      );
      return rows.map(toPlacement);
    },

    async revisions(entityId: string): Promise<MapRevision[]> {
      const rows = await db.query(
        `SELECT id, entity, entity_id, action, before, after, employee_id, at
           FROM helpdesk_faq_map_revisions WHERE entity_id = $1
          ORDER BY at DESC, id DESC`,
        [entityId],
      );
      return rows.map((row) => ({
        id: String(row.id),
        entity: row.entity as MapRevision['entity'],
        entityId: String(row.entity_id),
        action: row.action as MapRevision['action'],
        before: row.before ?? null,
        after: row.after ?? null,
        employeeId: idOrNull(row.employee_id),
        at: iso(row.at),
      }));
    },

    /**
     * 按 key 建节点；已有同 key 的：内容一样 → 原样返回（created: false），位置或文字不同 → 改掉
     * （记一条 update），种类或父节点不同 → 400（要搬节点请先删再建，免得挂着的卡悄悄换了地方）。
     */
    upsertNode(
      input: MapNodeInput,
      actor: FaqActor,
    ): Promise<{ node: FaqMapNode; created: boolean; changed: boolean }> {
      if (!(MAP_NODE_KINDS as readonly string[]).includes(input.kind))
        return Promise.reject(invalid(`Unknown map node kind ${input.kind}`));
      if (
        input.attribute !== null &&
        !(ATTRIBUTES as readonly string[]).includes(input.attribute)
      )
        return Promise.reject(invalid(`Unknown attribute ${input.attribute}`));
      return db
        .withTransaction(async (client) => {
          await client.query(MAP_LOCK);
          const parent = input.parentKey
            ? await nodeByKey(client, input.parentKey)
            : null;
          if (input.parentKey && !parent)
            throw invalid(`Parent ${input.parentKey} is not in the map`);
          const stage = input.stageKey
            ? await nodeByKey(client, input.stageKey)
            : null;
          if (input.stageKey && !stage)
            throw invalid(`Stage ${input.stageKey} is not in the map`);
          const existing = await nodeByKey(client, input.key);
          if (existing) {
            if (
              existing.kind !== input.kind ||
              existing.parentId !== (parent?.id ?? null) ||
              existing.stageId !== (stage?.id ?? null) ||
              existing.attribute !== input.attribute
            )
              throw invalid(
                `${input.key} already exists as a ${existing.kind} somewhere else; delete it first to move it`,
              );
            const same =
              existing.position === input.position &&
              existing.labelEn === input.labelEn &&
              existing.labelZh === input.labelZh;
            if (same) return { node: existing, created: false, changed: false };
            const { rows } = await client.query(
              `UPDATE helpdesk_faq_map_nodes
                  SET position = $2, label_en = $3, label_zh = $4, version = version + 1,
                      updated_by = $5, updated_at = now()
                WHERE id = $1
                RETURNING ${MAP_NODE_COLUMNS}`,
              [
                existing.id,
                input.position,
                input.labelEn,
                input.labelZh,
                actor.employeeId,
              ],
            );
            const node = toMapNode(rows[0]);
            await revision(
              client,
              'node',
              node.id,
              'update',
              existing,
              node,
              actor,
            );
            return { node, created: false, changed: true };
          }
          const { rows } = await client.query(
            `INSERT INTO helpdesk_faq_map_nodes
               (id, key, kind, parent_id, stage_id, attribute, position, label_en, label_zh,
                created_by, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
             RETURNING ${MAP_NODE_COLUMNS}`,
            [
              uuidv7(),
              input.key,
              input.kind,
              parent?.id ?? null,
              stage?.id ?? null,
              input.attribute,
              input.position,
              input.labelEn,
              input.labelZh,
              actor.employeeId,
            ],
          );
          const node = toMapNode(rows[0]);
          await revision(client, 'node', node.id, 'create', null, node, actor);
          return { node, created: true, changed: true };
        })
        .catch(mapDbError);
    },

    /** 改位置或文字；expectedVersion 不是现在的 version → 409（别人先改了，重新读再改）。 */
    updateNode(
      id: string,
      patch: MapNodePatch,
      expectedVersion: number,
      actor: FaqActor,
    ): Promise<FaqMapNode> {
      return db
        .withTransaction(async (client) => {
          await client.query(MAP_LOCK);
          const { rows: found } = await client.query(
            `SELECT ${MAP_NODE_COLUMNS} FROM helpdesk_faq_map_nodes WHERE id = $1 FOR UPDATE`,
            [id],
          );
          if (found.length === 0)
            throw new HelpdeskError(
              404,
              'FAQ_MAP_NODE_NOT_FOUND',
              'Map node not found',
            );
          const before = toMapNode(found[0]);
          if (before.version !== expectedVersion)
            throw conflict(
              `${before.key} was changed by someone else (version ${before.version}, you had ${expectedVersion})`,
            );
          const { rows } = await client.query(
            `UPDATE helpdesk_faq_map_nodes
                SET position = COALESCE($2, position), label_en = COALESCE($3, label_en),
                    label_zh = COALESCE($4, label_zh), version = version + 1,
                    updated_by = $5, updated_at = now()
              WHERE id = $1
              RETURNING ${MAP_NODE_COLUMNS}`,
            [
              id,
              patch.position ?? null,
              patch.labelEn ?? null,
              patch.labelZh ?? null,
              actor.employeeId,
            ],
          );
          const node = toMapNode(rows[0]);
          await revision(client, 'node', id, 'update', before, node, actor);
          return node;
        })
        .catch(mapDbError);
    },

    /** 删节点；还有子节点或挂着卡 → 409；已经没有了 → null（幂等）。 */
    deleteNode(id: string, actor: FaqActor): Promise<FaqMapNode | null> {
      return db
        .withTransaction(async (client) => {
          await client.query(MAP_LOCK);
          const { rows } = await client.query(
            `DELETE FROM helpdesk_faq_map_nodes WHERE id = $1 RETURNING ${MAP_NODE_COLUMNS}`,
            [id],
          );
          if (rows.length === 0) return null;
          const node = toMapNode(rows[0]);
          await revision(client, 'node', id, 'delete', node, null, actor);
          return node;
        })
        .catch(mapDbError);
    },

    /**
     * 一张卡挂在哪（整组）：给的就是全部位置，至多一个 primary；只写差异（加的、去掉的、主位置换了的），
     * 每条差异一行修订。同样的一组再给一次什么都不写。空数组 = 从结构里拿下来。
     */
    setPlacements(
      faqId: string,
      wanted: readonly PlacementInput[],
      actor: FaqActor,
    ): Promise<{ placements: FaqPlacement[]; changed: number }> {
      if (wanted.filter((p) => p.primary).length > 1)
        return Promise.reject(invalid('A card has at most one primary place'));
      if (new Set(wanted.map((p) => p.nodeKey)).size !== wanted.length)
        return Promise.reject(invalid('The same place is listed twice'));
      return db
        .withTransaction(async (client) => {
          await client.query(MAP_LOCK);
          const targets = new Map<string, FaqMapNode>();
          for (const p of wanted) {
            const node = await nodeByKey(client, p.nodeKey);
            if (!node) throw invalid(`${p.nodeKey} is not in the map`);
            if (!isPlaceable(node.kind))
              throw invalid(
                `A card hangs on a step, a deviation or a cell, not on a ${node.kind} (${p.nodeKey})`,
              );
            targets.set(node.id, node);
          }
          const { rows } = await client.query(
            `SELECT ${PLACEMENT_COLUMNS} FROM helpdesk_faq_placements WHERE faq_id = $1 FOR UPDATE`,
            [faqId],
          );
          const current = new Map(
            rows.map(toPlacement).map((p) => [p.nodeId, p]),
          );
          const primaryOf = new Map(
            wanted.map((p) => [
              [...targets.values()].find((n) => n.key === p.nodeKey)!.id,
              p.primary,
            ]),
          );
          let changed = 0;
          // 先去掉和降级，再加和升级：部分唯一索引（每张卡至多一个主位置）在每一步都成立
          for (const p of current.values()) {
            if (!primaryOf.has(p.nodeId)) {
              await client.query(
                'DELETE FROM helpdesk_faq_placements WHERE id = $1',
                [p.id],
              );
              await revision(
                client,
                'placement',
                p.id,
                'delete',
                p,
                null,
                actor,
              );
              changed += 1;
            } else if (p.primary && !primaryOf.get(p.nodeId)) {
              await client.query(
                'UPDATE helpdesk_faq_placements SET is_primary = false WHERE id = $1',
                [p.id],
              );
              await revision(
                client,
                'placement',
                p.id,
                'update',
                p,
                { ...p, primary: false },
                actor,
              );
              changed += 1;
            }
          }
          for (const [nodeId, primary] of primaryOf) {
            const old = current.get(nodeId);
            if (!old) {
              const { rows: inserted } = await client.query(
                `INSERT INTO helpdesk_faq_placements (id, faq_id, node_id, is_primary, created_by)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING ${PLACEMENT_COLUMNS}`,
                [uuidv7(), faqId, nodeId, primary, actor.employeeId],
              );
              const p = toPlacement(inserted[0]);
              await revision(
                client,
                'placement',
                p.id,
                'create',
                null,
                p,
                actor,
              );
              changed += 1;
            } else if (!old.primary && primary) {
              await client.query(
                'UPDATE helpdesk_faq_placements SET is_primary = true WHERE id = $1',
                [old.id],
              );
              await revision(
                client,
                'placement',
                old.id,
                'update',
                old,
                { ...old, primary: true },
                actor,
              );
              changed += 1;
            }
          }
          const { rows: after } = await client.query(
            `SELECT ${PLACEMENT_COLUMNS} FROM helpdesk_faq_placements WHERE faq_id = $1 ORDER BY node_id`,
            [faqId],
          );
          return { placements: after.map(toPlacement), changed };
        })
        .catch(mapDbError);
    },
  };
}
