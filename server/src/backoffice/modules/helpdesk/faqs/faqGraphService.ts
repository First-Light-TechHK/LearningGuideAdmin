import {
  FAQ_EDGE_KINDS,
  type FaqEdgeKind,
} from '../../../../contracts/helpdesk-qa';
import { isUuid } from '../../../../common/uuidv7';
import { HelpdeskError } from '../portalHelpdeskClient';
import {
  FAQ_LIMITS,
  PHRASING_LOCALES,
  type FaqActor,
  type FaqEdgeRevision,
  type FaqEdgeRow,
  type FaqPhrasing,
  type HelpdeskFaq,
  type PhrasingLocale,
  type PhrasingSource,
} from './faqContracts';
import { checkFaqGraph, type GraphProblem } from './faqGraphChecks';
import {
  createPgFaqGraphRepository,
  type EdgeLabels,
  type FaqGraphRepository,
  type FaqNodeSummary,
} from './faqGraphRepository';
import { freezeSnapshot } from './faqRelease';

/**
 * FAQ 问题树的编辑（helpdesk-v5-faq-graph-design §2.1、§5「追问与选项」与「树视图」）。只改工作表，
 * 学员看到的要等下一次发布。规则：
 * - 边：父子都要存在且已发布；kind 缺省按父节点类型（choice → option，answer → follow_up），给了不一致 → 400；
 *   同一对父子已有边 → 原样返回（幂等；内容不同 → 409 FAQ_EDGE_EXISTS）；choice 至多 4 个选项、
 *   answer 至多 6 条追问（409 FAQ_TOO_MANY_CHILDREN）；会成环 → 409 FAQ_EDGE_CYCLE（同一事务里的
 *   递归 CTE）；覆盖文字两种语言要么都给要么都不给，选项 ≤ 24 中文字 / 40 英文字符，追问 ≤ 200；
 * - 每次建 / 改 / 删 / 重排边都追加修订（谁、何时、改前 / 改后）；删已经没有的边 = 成功（幂等）；
 * - 问法：en-GB / zh-CN / zh-TW，≤ 200 字，每条 FAQ 至多 30 种；同一种再加一次返回已有的（幂等）；
 * - 树：从任一节点展开的缩进大纲；共享节点标出「也出现在 N 处」，工作表的图检查问题挂在节点上。
 */

function invalid(message: string): HelpdeskError {
  return new HelpdeskError(400, 'INVALID_INPUT', message);
}

function faqNotFound(): HelpdeskError {
  return new HelpdeskError(404, 'FAQ_NOT_FOUND', 'FAQ not found');
}

function record(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function uuid(raw: unknown, name: string): string {
  if (typeof raw !== 'string' || !isUuid(raw)) throw invalid(`Invalid ${name}`);
  return raw.toLowerCase();
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function codePoints(text: string): number {
  return [...text].length;
}

/** 覆盖文字：undefined = 没给；null / '' = 不覆盖（用子节点的问题）。 */
function label(
  value: unknown,
  name: string,
  max: number,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw invalid(`${name} must be text or null`);
  if (CONTROL.test(value)) throw invalid(`${name} has invalid characters`);
  const normalised = value.trim().replace(/\s+/g, ' ');
  if (normalised === '') return null;
  if (codePoints(normalised) > max)
    throw invalid(`${name} must be at most ${max} characters`);
  return normalised;
}

function labels(
  body: Record<string, unknown>,
  kind: FaqEdgeKind,
): EdgeLabels | undefined {
  const [maxEn, maxZh] =
    kind === 'option'
      ? [FAQ_LIMITS.optionLabelMaxEn, FAQ_LIMITS.optionLabelMaxZh]
      : [FAQ_LIMITS.followUpLabelMax, FAQ_LIMITS.followUpLabelMax];
  const labelEn = label(body.labelEn, 'labelEn', maxEn);
  const labelZh = label(body.labelZh, 'labelZh', maxZh);
  if (labelEn === undefined && labelZh === undefined) return undefined;
  const en = labelEn ?? null;
  const zh = labelZh ?? null;
  if ((en === null) !== (zh === null))
    throw invalid('Give the label in both languages, or in neither');
  return { labelEn: en, labelZh: zh };
}

function position(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 1000
  )
    throw invalid('position must be an integer 0-1000');
  return value;
}

export type EdgeView = {
  edge: FaqEdgeRow;
  node: FaqNodeSummary | null;
  /** 解析后的文字（没有覆盖 = 子节点的问题）。 */
  label: { en: string; zh: string };
};

export type FaqTreeNode = {
  node: FaqNodeSummary;
  /** 从父节点来的那条边（根节点为 null）。 */
  edge: FaqEdgeRow | null;
  label: { en: string; zh: string } | null;
  depth: number;
  /** 已发布的父节点个数；> 1 是共享节点。 */
  parentCount: number;
  /** 除了这条路径上的父节点，还出现在哪些父节点下（「也出现在 N 处」）。 */
  alsoAppearsIn: {
    id: string;
    key: string;
    questionEn: string;
    questionZh: string;
  }[];
  /** 这个节点的图检查问题（工作表）。 */
  warnings: GraphProblem[];
  /** 环（节点已在这条路径上）或超出展开深度：不再往下展开。 */
  cycle: boolean;
  truncated: boolean;
  children: FaqTreeNode[];
};

/** 树视图至多展开这么深（检查上限是 4，留出余量看到超深的分支）。 */
const TREE_DEPTH_MAX = 8;
const TREE_NODES_MAX = 600;

function summaryOf(faq: HelpdeskFaq): FaqNodeSummary {
  return {
    id: faq.id,
    key: faq.key,
    type: faq.type,
    entry: faq.entry,
    category: faq.category,
    questionEn: faq.questionEn,
    questionZh: faq.questionZh,
    status: faq.status,
  };
}

export type FaqGraphServiceOptions = { graph?: FaqGraphRepository };

export function createFaqGraphService(options: FaqGraphServiceOptions = {}) {
  const graph = options.graph ?? createPgFaqGraphRepository();

  async function liveNode(id: string): Promise<FaqNodeSummary> {
    const [found] = await graph.summaries([id]);
    if (!found || found.status !== 'published') throw faqNotFound();
    return found;
  }

  async function views(edges: FaqEdgeRow[], end: 'childId' | 'parentId') {
    const nodes = new Map(
      (await graph.summaries(edges.map((edge) => edge[end]))).map((node) => [
        node.id,
        node,
      ]),
    );
    return edges.map((edge): EdgeView => {
      const child = nodes.get(edge.childId) ?? null;
      const node = nodes.get(edge[end]) ?? null;
      return {
        edge,
        node,
        label: {
          en:
            edge.labelEn ??
            (end === 'childId' ? (child?.questionEn ?? '') : ''),
          zh:
            edge.labelZh ??
            (end === 'childId' ? (child?.questionZh ?? '') : ''),
        },
      };
    });
  }

  return {
    /** 一个节点的子节点（按顺序，带解析好的文字）与父节点。 */
    async edges(
      rawId: string,
    ): Promise<{ children: EdgeView[]; parents: EdgeView[] }> {
      const id = uuid(rawId, 'FAQ id');
      await liveNode(id);
      const { children, parents } = await graph.edgesOf(id);
      return {
        children: await views(children, 'childId'),
        parents: await views(parents, 'parentId'),
      };
    },

    async createEdge(
      actor: FaqActor,
      rawParentId: string,
      rawBody: unknown,
    ): Promise<{ edge: FaqEdgeRow; created: boolean }> {
      const parentId = uuid(rawParentId, 'FAQ id');
      const body = record(rawBody);
      const childId = uuid(body.childId, 'childId');
      if (childId === parentId)
        throw invalid('A question cannot follow itself');
      const parent = await liveNode(parentId);
      const expected: FaqEdgeKind =
        parent.type === 'choice' ? 'option' : 'follow_up';
      if (body.kind !== undefined) {
        if (!(FAQ_EDGE_KINDS as readonly unknown[]).includes(body.kind))
          throw invalid('kind must be follow_up or option');
        if (body.kind !== expected)
          throw invalid(
            parent.type === 'choice'
              ? 'A choice question only has options'
              : 'An answer only has follow-ups',
          );
      }
      const given = labels(body, expected);
      const result = await graph.createEdge(
        {
          parentId,
          childId,
          kind: expected,
          position: position(body.position),
          labelEn: given?.labelEn ?? null,
          labelZh: given?.labelZh ?? null,
        },
        expected === 'option' ? FAQ_LIMITS.optionsMax : FAQ_LIMITS.followUpsMax,
        actor.employeeId,
      );
      switch (result.kind) {
        case 'created':
          return { edge: result.edge, created: true };
        case 'exists': {
          const same =
            result.edge.kind === expected &&
            (given === undefined ||
              (given.labelEn === result.edge.labelEn &&
                given.labelZh === result.edge.labelZh));
          if (!same)
            throw new HelpdeskError(
              409,
              'FAQ_EDGE_EXISTS',
              'These two questions are already linked; edit that link instead',
            );
          return { edge: result.edge, created: false };
        }
        case 'missing':
          throw faqNotFound();
        case 'archived':
          throw new HelpdeskError(
            409,
            'FAQ_ARCHIVED',
            'An archived question cannot be linked',
          );
        case 'cycle':
          throw new HelpdeskError(
            409,
            'FAQ_EDGE_CYCLE',
            'This link would make a loop: the follow-up already leads back to this question',
          );
        case 'full':
          throw new HelpdeskError(
            409,
            'FAQ_TOO_MANY_CHILDREN',
            expected === 'option'
              ? `A choice question has at most ${FAQ_LIMITS.optionsMax} options`
              : `An answer has at most ${FAQ_LIMITS.followUpsMax} follow-ups`,
          );
      }
    },

    /** 改一条边的覆盖文字（labelEn / labelZh 都要给，null = 用子节点的问题）。 */
    async updateEdge(
      actor: FaqActor,
      rawEdgeId: string,
      rawBody: unknown,
    ): Promise<FaqEdgeRow> {
      const id = uuid(rawEdgeId, 'edge id');
      const current = await graph.getEdge(id);
      if (!current)
        throw new HelpdeskError(404, 'FAQ_EDGE_NOT_FOUND', 'Link not found');
      const body = record(rawBody);
      if (!('labelEn' in body) || !('labelZh' in body))
        throw invalid('labelEn and labelZh are required (null = no override)');
      const given = labels(body, current.kind) ?? {
        labelEn: null,
        labelZh: null,
      };
      const updated = await graph.updateEdgeLabels(id, given, actor.employeeId);
      if (!updated)
        throw new HelpdeskError(404, 'FAQ_EDGE_NOT_FOUND', 'Link not found');
      return updated.edge;
    },

    async deleteEdge(
      actor: FaqActor,
      rawEdgeId: string,
    ): Promise<{ deleted: boolean; edge: FaqEdgeRow | null }> {
      const id = uuid(rawEdgeId, 'edge id');
      const edge = await graph.deleteEdge(id, actor.employeeId);
      return { deleted: edge !== null, edge };
    },

    async reorder(
      actor: FaqActor,
      rawParentId: string,
      rawBody: unknown,
    ): Promise<{ children: EdgeView[] }> {
      const parentId = uuid(rawParentId, 'FAQ id');
      const body = record(rawBody);
      if (!Array.isArray(body.childIds))
        throw invalid('childIds must be a list');
      const childIds = body.childIds.map((raw) => uuid(raw, 'childId'));
      await liveNode(parentId);
      const result = await graph.reorder(parentId, childIds, actor.employeeId);
      if (result.kind === 'mismatch')
        throw new HelpdeskError(
          409,
          'FAQ_CHILDREN_CHANGED',
          'The follow-ups changed since you loaded them. Reload and try again.',
        );
      return { children: await views(result.edges, 'childId') };
    },

    async edgeRevisions(
      rawId: string,
    ): Promise<{ revisions: FaqEdgeRevision[] }> {
      const id = uuid(rawId, 'FAQ id');
      return { revisions: await graph.edgeRevisions(id) };
    },

    async phrasings(rawId: string): Promise<{ phrasings: FaqPhrasing[] }> {
      const id = uuid(rawId, 'FAQ id');
      await liveNode(id);
      return { phrasings: await graph.phrasingsOf(id) };
    },

    async addPhrasing(
      actor: FaqActor,
      rawId: string,
      rawBody: unknown,
      source: PhrasingSource = 'staff',
    ): Promise<{ phrasing: FaqPhrasing; created: boolean }> {
      const faqId = uuid(rawId, 'FAQ id');
      const body = record(rawBody);
      if (!(PHRASING_LOCALES as readonly unknown[]).includes(body.locale))
        throw invalid('locale must be en-GB, zh-CN or zh-TW');
      if (typeof body.text !== 'string') throw invalid('text is required');
      if (CONTROL.test(body.text)) throw invalid('text has invalid characters');
      const text = body.text.trim().replace(/\s+/g, ' ');
      if (text === '' || codePoints(text) > FAQ_LIMITS.phrasingMax)
        throw invalid(`text must be 1-${FAQ_LIMITS.phrasingMax} characters`);
      let picked = source;
      if (body.source !== undefined) {
        if (body.source !== 'staff' && body.source !== 'flywheel')
          throw invalid('source must be staff or flywheel');
        picked = body.source;
      }
      await liveNode(faqId);
      const existing = await graph.phrasingsOf(faqId);
      const same = existing.find(
        (p) =>
          p.locale === body.locale &&
          p.text.toLowerCase() === text.toLowerCase(),
      );
      if (same) return { phrasing: same, created: false };
      if (existing.length >= FAQ_LIMITS.phrasingsMax)
        throw new HelpdeskError(
          409,
          'FAQ_TOO_MANY_PHRASINGS',
          `A question has at most ${FAQ_LIMITS.phrasingsMax} phrasings`,
        );
      return graph.insertPhrasing({
        faqId,
        locale: body.locale as PhrasingLocale,
        text,
        source: picked,
        employeeId: actor.employeeId,
      });
    },

    async deletePhrasing(
      _actor: FaqActor,
      rawPhrasingId: string,
    ): Promise<{ deleted: boolean }> {
      const id = uuid(rawPhrasingId, 'phrasing id');
      return { deleted: (await graph.deletePhrasing(id)) !== null };
    },

    /**
     * 从一个节点展开的树（工作表）。每次出现都展开（DAG 的共享节点在每个父节点下都看得到），
     * 环与超深的分支停住并标出；节点总数有上限。
     */
    async tree(rawId: string): Promise<{ root: FaqTreeNode; nodes: number }> {
      const id = uuid(rawId, 'FAQ id');
      const working = await graph.working();
      const nodes = new Map(working.faqs.map((faq) => [faq.id, faq]));
      const rootFaq = nodes.get(id);
      if (!rootFaq) throw faqNotFound();
      const checks = checkFaqGraph(
        freezeSnapshot(working.faqs, working.edges, working.phrasings),
      );
      const warnings = new Map<string, GraphProblem[]>();
      for (const problem of checks.problems) {
        if (!problem.nodeId) continue;
        const list = warnings.get(problem.nodeId) ?? [];
        list.push(problem);
        warnings.set(problem.nodeId, list);
      }
      const children = new Map<string, FaqEdgeRow[]>();
      const parents = new Map<string, FaqEdgeRow[]>();
      for (const edge of working.edges) {
        if (!nodes.has(edge.parentId)) continue;
        children.set(edge.parentId, [
          ...(children.get(edge.parentId) ?? []),
          edge,
        ]);
        parents.set(edge.childId, [...(parents.get(edge.childId) ?? []), edge]);
      }
      let count = 0;
      const build = (
        faq: HelpdeskFaq,
        edge: FaqEdgeRow | null,
        depth: number,
        path: string[],
      ): FaqTreeNode => {
        count += 1;
        const ownParents = parents.get(faq.id) ?? [];
        const cycle = path.includes(faq.id);
        const truncated =
          !cycle && (depth >= TREE_DEPTH_MAX || count >= TREE_NODES_MAX);
        const out = cycle || truncated ? [] : (children.get(faq.id) ?? []);
        return {
          node: summaryOf(faq),
          edge,
          label: edge
            ? {
                en: edge.labelEn ?? faq.questionEn,
                zh: edge.labelZh ?? faq.questionZh,
              }
            : null,
          depth,
          parentCount: ownParents.length,
          alsoAppearsIn: ownParents
            .filter((parent) => parent.parentId !== edge?.parentId)
            .map((parent) => nodes.get(parent.parentId)!)
            .map((parent) => ({
              id: parent.id,
              key: parent.key,
              questionEn: parent.questionEn,
              questionZh: parent.questionZh,
            })),
          warnings: warnings.get(faq.id) ?? [],
          cycle,
          truncated: truncated && (children.get(faq.id) ?? []).length > 0,
          children: [...out]
            .sort(
              (a, b) =>
                a.position - b.position ||
                a.createdAt.localeCompare(b.createdAt),
            )
            .flatMap((child) => {
              const node = nodes.get(child.childId);
              return node
                ? [build(node, child, depth + 1, [...path, faq.id])]
                : [];
            }),
        };
      };
      return { root: build(rootFaq, null, 0, []), nodes: count };
    },
  };
}

export type FaqGraphService = ReturnType<typeof createFaqGraphService>;
