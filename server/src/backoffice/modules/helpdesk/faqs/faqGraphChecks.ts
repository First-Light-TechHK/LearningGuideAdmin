import { FAQ_LIMITS } from './faqContracts';
import type {
  FaqReleaseSnapshot,
  FaqSnapshotEdge,
  FaqSnapshotNode,
} from './faqRelease';

/**
 * 发布前的图检查（helpdesk-v5-faq-graph-design §2.3）：纯函数，输入就是要冻结的快照，
 * 同一快照永远得到同样的结果。任何一条不过，这一版就不能发布。规则：
 * - edge_endpoint：每条边的两端都在快照里（快照只有已发布的节点，所以「没归档」也在这里）；
 * - duplicate_edge：同一对父子至多一条边；
 * - cycle：没有环（快照上 DFS；编辑时另有同事务的递归 CTE 拒绝成环的边）；
 * - depth：离最近的入口节点至多 FAQ_LIMITS.depthMax 条边；
 * - orphan：每个非入口节点都能从某个入口节点走到；
 * - option_parent：option 边只从 choice 节点出；follow_up 边只从 answer 节点出（choice_follow_up）；
 * - choice_options：choice 节点有 2–4 条 option 边；
 * - choice_prompt：choice 节点的提问（两种语言）不含数字、链接、邮箱；
 * - follow_ups：answer 节点至多 6 条 follow_up 边（展示 4 条）；
 * - language：两种语言的问题与答案都在；边的覆盖文字要么两种语言都给、要么都不给；
 * - label_length：解析后的选项文字 ≤ 24 中文字 / 40 英文字符，追问文字 ≤ 200；
 * - answer_blocks：answer 节点两种语言都切得出至少一个块。
 * 「归档一个还有父节点的节点」在编辑时就拒绝（faqService.archive），不在这里。
 */
export const GRAPH_RULES = [
  'edge_endpoint',
  'duplicate_edge',
  'cycle',
  'depth',
  'orphan',
  'option_parent',
  'choice_follow_up',
  'choice_options',
  'choice_prompt',
  'follow_ups',
  'language',
  'label_length',
  'answer_blocks',
] as const;
export type GraphRule = (typeof GRAPH_RULES)[number];

export type GraphProblem = {
  rule: GraphRule;
  /** 出问题的节点（边的问题是父节点；环是环上第一个节点）。 */
  nodeId: string | null;
  key: string | null;
  parentId?: string;
  childId?: string;
  /** 给员工看的一句话（英文；界面按 rule 显示本地化文字）。 */
  detail: string;
};

export type FaqGraphCheckResult = {
  passed: boolean;
  problems: GraphProblem[];
  counts: {
    nodes: number;
    entries: number;
    choices: number;
    edges: number;
    phrasings: number;
  };
  /** 离最近入口的最大距离（走不到的节点不算）。 */
  maxDepth: number;
};

const DIGIT = /[0-9０-９]/;
const LINK = /https?:\/\/|www\.|mailto:|\]\(|[^\s@]+@[^\s@]+\.[^\s@]+/i;

/** choice 节点的提问不陈述事实：含数字、链接或邮箱 → true。 */
export function choicePromptProblem(prompt: string): boolean {
  return DIGIT.test(prompt) || LINK.test(prompt);
}

function codePoints(text: string): number {
  return [...text].length;
}

function edgeKey(edge: Pick<FaqSnapshotEdge, 'parentId' | 'childId'>): string {
  return `${edge.parentId}>${edge.childId}`;
}

/** 解析后的边文字（与 publicRelease 一样：没有覆盖 = 子节点的问题）。 */
export function resolvedLabels(
  edge: FaqSnapshotEdge,
  child: FaqSnapshotNode | undefined,
): { en: string; zh: string } {
  return {
    en: edge.labelEn ?? child?.questionEn ?? '',
    zh: edge.labelZh ?? child?.questionZh ?? '',
  };
}

export function checkFaqGraph(
  snapshot: FaqReleaseSnapshot,
): FaqGraphCheckResult {
  const problems: GraphProblem[] = [];
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const keyOf = (id: string | null) =>
    id === null ? null : (nodes.get(id)?.key ?? null);
  const add = (
    rule: GraphRule,
    nodeId: string | null,
    detail: string,
    edge?: Pick<FaqSnapshotEdge, 'parentId' | 'childId'>,
  ) =>
    problems.push({
      rule,
      nodeId,
      key: keyOf(nodeId),
      ...(edge ? { parentId: edge.parentId, childId: edge.childId } : {}),
      detail,
    });

  // 边：两端都在、不重复；只有两端都在的边参与后面的图规则
  const seen = new Set<string>();
  const valid: FaqSnapshotEdge[] = [];
  for (const edge of snapshot.edges) {
    const missing = [edge.parentId, edge.childId].filter(
      (id) => !nodes.has(id),
    );
    if (missing.length > 0) {
      add(
        'edge_endpoint',
        nodes.has(edge.parentId) ? edge.parentId : null,
        `Edge ${edgeKey(edge)} points at a question that is archived or missing (${missing.join(', ')})`,
        edge,
      );
      continue;
    }
    if (seen.has(edgeKey(edge))) {
      add(
        'duplicate_edge',
        edge.parentId,
        `More than one edge from ${keyOf(edge.parentId)} to ${keyOf(edge.childId)}`,
        edge,
      );
      continue;
    }
    seen.add(edgeKey(edge));
    valid.push(edge);
  }

  const children = new Map<string, FaqSnapshotEdge[]>();
  for (const edge of valid) {
    const list = children.get(edge.parentId) ?? [];
    list.push(edge);
    children.set(edge.parentId, list);
  }

  // 环：三色 DFS，每个环报一次（环上第一个节点）
  const colour = new Map<string, 'grey' | 'black'>();
  const visit = (id: string, path: string[]): void => {
    colour.set(id, 'grey');
    path.push(id);
    for (const edge of children.get(id) ?? []) {
      const state = colour.get(edge.childId);
      if (state === 'grey') {
        const cycle = path.slice(path.indexOf(edge.childId));
        add(
          'cycle',
          edge.childId,
          `Cycle: ${[...cycle, edge.childId].map((n) => keyOf(n)).join(' → ')}`,
          edge,
        );
      } else if (state === undefined) {
        visit(edge.childId, path);
      }
    }
    path.pop();
    colour.set(id, 'black');
  };
  for (const node of snapshot.nodes)
    if (!colour.has(node.id)) visit(node.id, []);

  // 深度：从所有入口同时 BFS（最短距离）
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const node of snapshot.nodes)
    if (node.entry) {
      depth.set(node.id, 0);
      queue.push(node.id);
    }
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    const d = depth.get(id)!;
    for (const edge of children.get(id) ?? []) {
      if (depth.has(edge.childId)) continue;
      depth.set(edge.childId, d + 1);
      queue.push(edge.childId);
    }
  }
  let maxDepth = 0;
  for (const node of snapshot.nodes) {
    const d = depth.get(node.id);
    if (d === undefined) {
      add(
        'orphan',
        node.id,
        `${node.key} is not an entry and no entry question leads to it`,
      );
      continue;
    }
    maxDepth = Math.max(maxDepth, d);
    if (d > FAQ_LIMITS.depthMax)
      add(
        'depth',
        node.id,
        `${node.key} is ${d} steps from the nearest entry question (at most ${FAQ_LIMITS.depthMax})`,
      );
  }

  // 节点自己的规则
  for (const node of snapshot.nodes) {
    const out = children.get(node.id) ?? [];
    const options = out.filter((edge) => edge.kind === 'option');
    const followUps = out.filter((edge) => edge.kind === 'follow_up');
    if (node.type === 'choice') {
      if (followUps.length > 0)
        add(
          'choice_follow_up',
          node.id,
          `${node.key} is a choice question and cannot have follow-ups (it has ${followUps.length})`,
        );
      if (
        options.length < FAQ_LIMITS.optionsMin ||
        options.length > FAQ_LIMITS.optionsMax
      )
        add(
          'choice_options',
          node.id,
          `${node.key} needs ${FAQ_LIMITS.optionsMin}-${FAQ_LIMITS.optionsMax} options (it has ${options.length})`,
        );
      for (const [lang, prompt] of [
        ['en', node.answerEn],
        ['zh', node.answerZh],
      ] as const)
        if (choicePromptProblem(prompt))
          add(
            'choice_prompt',
            node.id,
            `${node.key}: the ${lang} prompt of a choice question must not contain digits, links or emails`,
          );
    } else {
      if (options.length > 0)
        add(
          'option_parent',
          node.id,
          `${node.key} is an answer and cannot have options (it has ${options.length})`,
        );
      if (followUps.length > FAQ_LIMITS.followUpsMax)
        add(
          'follow_ups',
          node.id,
          `${node.key} has ${followUps.length} follow-ups (at most ${FAQ_LIMITS.followUpsMax})`,
        );
      if (node.blocksEn.length === 0 || node.blocksZh.length === 0)
        add(
          'answer_blocks',
          node.id,
          `${node.key}: the answer must have text in both languages`,
        );
    }
    for (const [field, value] of [
      ['questionEn', node.questionEn],
      ['answerEn', node.answerEn],
      ['questionZh', node.questionZh],
      ['answerZh', node.answerZh],
    ] as const)
      if (value.trim() === '')
        add('language', node.id, `${node.key}: ${field} is empty`);
  }

  // 边的文字
  for (const edge of valid) {
    if ((edge.labelEn === null) !== (edge.labelZh === null))
      add(
        'language',
        edge.parentId,
        `Edge ${keyOf(edge.parentId)} → ${keyOf(edge.childId)} overrides the label in one language only`,
        edge,
      );
    const label = resolvedLabels(edge, nodes.get(edge.childId));
    const [maxEn, maxZh] =
      edge.kind === 'option'
        ? [FAQ_LIMITS.optionLabelMaxEn, FAQ_LIMITS.optionLabelMaxZh]
        : [FAQ_LIMITS.followUpLabelMax, FAQ_LIMITS.followUpLabelMax];
    if (codePoints(label.en) > maxEn || codePoints(label.zh) > maxZh)
      add(
        'label_length',
        edge.parentId,
        `The ${edge.kind === 'option' ? 'option' : 'follow-up'} label ${keyOf(edge.parentId)} → ${keyOf(edge.childId)} is too long (at most ${maxZh} zh / ${maxEn} en characters)`,
        edge,
      );
    if (label.en.trim() === '' || label.zh.trim() === '')
      add(
        'language',
        edge.parentId,
        `The label ${keyOf(edge.parentId)} → ${keyOf(edge.childId)} is empty`,
        edge,
      );
  }

  return {
    passed: problems.length === 0,
    problems,
    counts: {
      nodes: snapshot.nodes.length,
      entries: snapshot.nodes.filter((node) => node.entry).length,
      choices: snapshot.nodes.filter((node) => node.type === 'choice').length,
      edges: snapshot.edges.length,
      phrasings: snapshot.phrasings.length,
    },
    maxDepth,
  };
}
