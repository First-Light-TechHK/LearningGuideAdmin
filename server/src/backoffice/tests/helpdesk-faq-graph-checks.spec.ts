import type {
  HelpdeskFaq,
  FaqEdgeRow,
} from '../modules/helpdesk/faqs/faqContracts';
import {
  checkFaqGraph,
  choicePromptProblem,
  GRAPH_RULES,
  type GraphRule,
} from '../modules/helpdesk/faqs/faqGraphChecks';
import { faqKeySlug } from '../modules/helpdesk/faqs/faqKeys';
import {
  diffSnapshots,
  freezeNode,
  freezeSnapshot,
  snapshotHash,
  type FaqReleaseSnapshot,
  type FaqSnapshotEdge,
  type FaqSnapshotNode,
} from '../modules/helpdesk/faqs/faqRelease';

/**
 * v5 问题树的图检查（helpdesk-v5-faq-graph-design §2.3）、冻结与差异：纯函数，每条规则一个用例，
 * 一个合格的图没有任何问题。数据库那一半（编辑时拒绝成环、发布的原子性）见 helpdesk-faq-graph.pg.spec.ts。
 */

let n = 0;
function node(
  key: string,
  overrides: Partial<Omit<FaqSnapshotNode, 'blocksEn' | 'blocksZh'>> = {},
): FaqSnapshotNode {
  n += 1;
  return freezeNode({
    id: `0192dddd-0000-7000-8000-${String(n).padStart(12, '0')}`,
    key,
    type: 'answer',
    entry: false,
    category: 'payments_subscriptions',
    popular: false,
    questionEn: `Question ${key}?`,
    answerEn: `Answer for ${key}.`,
    questionZh: `问题 ${key}？`,
    answerZh: `答案 ${key}。`,
    signals: [],
    keywords: [],
    version: 1,
    updatedAt: '2026-10-30T00:00:00.000Z',
    ...overrides,
  });
}

function edge(
  parent: FaqSnapshotNode,
  child: FaqSnapshotNode,
  overrides: Partial<FaqSnapshotEdge> = {},
): FaqSnapshotEdge {
  return {
    parentId: parent.id,
    childId: child.id,
    kind: parent.type === 'choice' ? 'option' : 'follow_up',
    position: 0,
    labelEn: null,
    labelZh: null,
    ...overrides,
  };
}

/** 一个合格的图：choice 入口（两个选项）→ 两个答案；其中一个答案有两层追问，共享的联系客服节点两个父节点。 */
function goodGraph() {
  const choice = node('pay', {
    type: 'choice',
    entry: true,
    answerEn: 'Which of these is it?',
    answerZh: '你遇到的是哪种情况？',
  });
  const failed = node('failed', { entry: true });
  const notActive = node('not-active');
  const retry = node('retry');
  const contact = node('contact', { entry: true });
  const deep = node('deep');
  const snapshot: FaqReleaseSnapshot = {
    nodes: [choice, failed, notActive, retry, contact, deep],
    edges: [
      edge(choice, failed, { labelEn: 'Failed', labelZh: '付款失败' }),
      edge(choice, notActive, {
        position: 1,
        labelEn: 'Not active',
        labelZh: '没开通',
      }),
      edge(failed, retry),
      edge(retry, deep),
      edge(failed, contact, { position: 1 }),
      edge(notActive, contact),
    ],
    phrasings: [],
  };
  return { snapshot, choice, failed, notActive, retry, contact, deep };
}

function rules(snapshot: FaqReleaseSnapshot): GraphRule[] {
  return checkFaqGraph(snapshot).problems.map((p) => p.rule);
}

describe('FAQ graph checks (§2.3, pure)', () => {
  it('passes a well-formed DAG with a choice node and a shared node, and counts it', () => {
    const { snapshot } = goodGraph();
    const result = checkFaqGraph(snapshot);
    expect(result.problems).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.counts).toEqual({
      nodes: 6,
      entries: 3,
      choices: 1,
      edges: 6,
      phrasings: 0,
    });
    expect(result.maxDepth).toBe(2);
  });

  it('edge_endpoint: an edge to a question that is not in the snapshot (archived or missing)', () => {
    const { snapshot, failed } = goodGraph();
    const gone = node('gone');
    snapshot.edges.push(edge(failed, gone, { position: 2 }));
    const result = checkFaqGraph(snapshot);
    expect(result.passed).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({
        rule: 'edge_endpoint',
        nodeId: failed.id,
        key: 'failed',
        childId: gone.id,
      }),
    ]);
  });

  it('duplicate_edge: two edges for the same parent and child', () => {
    const { snapshot, failed, retry } = goodGraph();
    snapshot.edges.push(edge(failed, retry, { position: 5 }));
    expect(rules(snapshot)).toEqual(['duplicate_edge']);
  });

  it('cycle: a loop is found by DFS and reported once', () => {
    const { snapshot, deep, failed } = goodGraph();
    snapshot.edges.push(edge(deep, failed));
    const result = checkFaqGraph(snapshot);
    const cycles = result.problems.filter((p) => p.rule === 'cycle');
    expect(cycles).toHaveLength(1);
    expect(cycles[0].detail).toContain('failed → retry → deep → failed');
  });

  it('depth: at most 4 steps from the nearest entry; an entry deeper down resets the depth', () => {
    const root = node('root', { entry: true });
    const chain = [root];
    for (let i = 1; i <= 5; i++) chain.push(node(`level-${i}`));
    const edges = chain.slice(1).map((child, i) => edge(chain[i], child));
    const deep: FaqReleaseSnapshot = { nodes: chain, edges, phrasings: [] };
    const result = checkFaqGraph(deep);
    expect(result.problems).toEqual([
      expect.objectContaining({ rule: 'depth', key: 'level-5' }),
    ]);
    expect(result.maxDepth).toBe(5);
    // level-2 is also an entry: level-5 is now 3 steps from the nearest entry
    chain[2].entry = true;
    expect(checkFaqGraph(deep).problems).toEqual([]);
  });

  it('orphan: a non-entry node that no entry leads to', () => {
    const { snapshot } = goodGraph();
    snapshot.nodes.push(node('lonely'));
    expect(checkFaqGraph(snapshot).problems).toEqual([
      expect.objectContaining({ rule: 'orphan', key: 'lonely' }),
    ]);
  });

  it('choice_options: a choice node needs 2-4 options', () => {
    const { snapshot, choice } = goodGraph();
    const one = { ...snapshot, edges: snapshot.edges.slice(1) };
    expect(rules(one)).toEqual(expect.arrayContaining(['choice_options']));
    const extra = [1, 2, 3].map((i) => node(`extra-${i}`));
    const five = {
      ...snapshot,
      nodes: [...snapshot.nodes, ...extra],
      edges: [
        ...snapshot.edges,
        ...extra.map((child, i) =>
          edge(choice, child, {
            position: i + 2,
            labelEn: `E${'x'.repeat(i)}`,
            labelZh: `额外${'外'.repeat(i)}`,
          }),
        ),
      ],
    };
    expect(rules(five)).toEqual(['choice_options']);
  });

  it('choice_options boundaries: exactly 4 options passes, no options fails', () => {
    const { snapshot, choice } = goodGraph();
    const extra = [1, 2].map((i) => node(`extra-${i}`));
    const four = {
      ...snapshot,
      nodes: [...snapshot.nodes, ...extra],
      edges: [
        ...snapshot.edges,
        ...extra.map((child, i) =>
          edge(choice, child, {
            position: i + 2,
            labelEn: `Extra ${i}`,
            labelZh: `额外${i}`,
          }),
        ),
      ],
    };
    expect(rules(four)).toEqual([]);
    const none = {
      ...snapshot,
      edges: snapshot.edges.filter((e) => e.parentId !== choice.id),
    };
    expect(rules(none)).toContain('choice_options');
  });

  it('cycle: an edge from a node to itself is a cycle', () => {
    const { snapshot, retry } = goodGraph();
    snapshot.edges.push(edge(retry, retry, { position: 1 }));
    expect(rules(snapshot)).toContain('cycle');
  });

  it('depth: a shared node uses its shortest path from an entry', () => {
    const root = node('root', { entry: true });
    const chain = [root];
    for (let i = 1; i <= 5; i++) chain.push(node(`level-${i}`));
    const edges = chain.slice(1).map((child, i) => edge(chain[i], child));
    const shared = node('shared');
    // reachable at depth 6 through the chain, and at depth 2 through a short branch
    edges.push(edge(chain[5], shared));
    edges.push(edge(chain[1], shared, { position: 1 }));
    const result = checkFaqGraph({
      nodes: [...chain, shared],
      edges,
      phrasings: [],
    });
    expect(result.problems.map((p) => [p.rule, p.key])).toEqual([
      ['depth', 'level-5'],
    ]);
  });

  it('choice_follow_up and option_parent: options only from a choice, follow-ups only from an answer', () => {
    const { snapshot, choice, failed, retry, deep } = goodGraph();
    snapshot.edges.push({
      ...edge(choice, deep),
      kind: 'follow_up',
      position: 2,
    });
    snapshot.edges.push({
      ...edge(failed, node('x')),
      childId: deep.id,
      kind: 'option',
      position: 3,
    });
    void retry;
    expect(rules(snapshot)).toEqual(
      expect.arrayContaining(['choice_follow_up', 'option_parent']),
    );
  });

  it('choice_prompt: the prompt of a choice question states no facts (no digits, links or emails)', () => {
    for (const prompt of [
      'Is it about order 12?',
      '是第１个吗？',
      'See https://example.com',
      'Mail help@example.com',
      'See [here](https://example.com)',
    ])
      expect(choicePromptProblem(prompt)).toBe(true);
    expect(choicePromptProblem('你遇到的是哪种情况？')).toBe(false);
    const { snapshot, choice } = goodGraph();
    snapshot.nodes[snapshot.nodes.indexOf(choice)] = {
      ...choice,
      answerZh: '是哪一种？退款需 3 天',
    };
    expect(checkFaqGraph(snapshot).problems).toEqual([
      expect.objectContaining({ rule: 'choice_prompt', key: 'pay' }),
    ]);
  });

  it('follow_ups: an answer has at most 6 follow-ups', () => {
    const { snapshot, contact } = goodGraph();
    const kids = Array.from({ length: 7 }, (_, i) => node(`kid-${i}`));
    const many = {
      ...snapshot,
      nodes: [...snapshot.nodes, ...kids],
      edges: [
        ...snapshot.edges,
        ...kids.map((kid, i) => edge(contact, kid, { position: i })),
      ],
    };
    expect(rules(many)).toEqual(['follow_ups']);
    const six = {
      ...many,
      nodes: many.nodes.slice(0, -1),
      edges: many.edges.slice(0, -1),
    };
    expect(rules(six)).toEqual([]);
  });

  it('language: both languages present, and a label override in both languages or neither', () => {
    const { snapshot, retry, failed } = goodGraph();
    snapshot.nodes[snapshot.nodes.indexOf(retry)] = {
      ...retry,
      questionZh: ' ',
    };
    const one = snapshot.edges.findIndex((e) => e.parentId === failed.id);
    snapshot.edges[one] = {
      ...snapshot.edges[one],
      labelEn: 'Retry?',
      labelZh: null,
    };
    const found = checkFaqGraph(snapshot).problems.filter(
      (p) => p.rule === 'language',
    );
    // the empty zh question, the one-language override, and the zh label that resolves to it
    expect(found.map((p) => p.detail)).toEqual([
      'retry: questionZh is empty',
      'Edge failed → retry overrides the label in one language only',
      'The label failed → retry is empty',
    ]);
  });

  it('label_length: options are at most 24 zh / 40 en characters (resolved), follow-ups 200', () => {
    const { snapshot } = goodGraph();
    const [first] = snapshot.edges;
    snapshot.edges[0] = {
      ...first,
      labelEn: 'x'.repeat(40),
      labelZh: '字'.repeat(24),
    };
    expect(rules(snapshot)).toEqual([]);
    snapshot.edges[0] = {
      ...first,
      labelEn: 'x'.repeat(41),
      labelZh: '字'.repeat(24),
    };
    expect(rules(snapshot)).toEqual(['label_length']);
    // no override: the child's question is the label, and it is too long for a button
    snapshot.edges[0] = { ...first, labelEn: null, labelZh: null };
    const child = snapshot.nodes.find((x) => x.id === first.childId)!;
    child.questionZh = '这'.repeat(25);
    expect(rules(snapshot)).toEqual(['label_length']);
  });

  it('answer_blocks: an answer node has text that splits into at least one block in both languages', () => {
    const { snapshot, deep } = goodGraph();
    snapshot.nodes[snapshot.nodes.indexOf(deep)] = { ...deep, blocksZh: [] };
    expect(rules(snapshot)).toEqual(['answer_blocks']);
  });

  it('names every rule it can report', () => {
    expect(GRAPH_RULES).toHaveLength(13);
  });
});

const EMP = '0192aaaa-0000-7000-8000-000000000001';
function faq(id: string, overrides: Partial<HelpdeskFaq> = {}): HelpdeskFaq {
  return {
    id,
    key: `k-${id.slice(-4)}`,
    type: 'answer',
    entry: true,
    category: 'other',
    popular: false,
    questionEn: 'Q?',
    answerEn: 'First paragraph.\n\n- one\n- two',
    questionZh: '问？',
    answerZh: '第一段。',
    keywords: ['k'],
    signals: [],
    status: 'published',
    version: 2,
    createdBy: EMP,
    updatedBy: EMP,
    createdAt: '2026-10-29T00:00:00.000Z',
    updatedAt: '2026-10-29T00:00:00.000Z',
    ...overrides,
  };
}
function row(
  parentId: string,
  childId: string,
  position: number,
  createdAt: string,
): FaqEdgeRow {
  return {
    id: `${parentId}-${childId}`,
    parentId,
    childId,
    kind: 'follow_up',
    position,
    labelEn: null,
    labelZh: null,
    createdBy: EMP,
    createdAt,
    updatedAt: createdAt,
  };
}

describe('freezing the working tables into a snapshot (§2.2, pure)', () => {
  const A = '0192eeee-0000-7000-8000-00000000000a';
  const B = '0192eeee-0000-7000-8000-00000000000b';
  const C = '0192eeee-0000-7000-8000-00000000000c';
  const D = '0192eeee-0000-7000-8000-00000000000d';

  it('keeps published nodes only, splits answer blocks, renumbers positions and drops edges of archived parents', () => {
    const snapshot = freezeSnapshot(
      [faq(C), faq(A), faq(B), faq(D, { status: 'archived' })],
      [
        row(A, C, 5, '2026-10-29T00:00:02Z'),
        row(A, B, 5, '2026-10-29T00:00:01Z'),
        row(D, A, 0, '2026-10-29T00:00:00Z'),
        row(B, D, 0, '2026-10-29T00:00:00Z'),
      ],
      [
        { faqId: B, locale: 'zh-TW', text: '問題' },
        { faqId: D, locale: 'en-GB', text: 'archived' },
      ],
    );
    expect(snapshot.nodes.map((x) => x.id)).toEqual([A, B, C]);
    expect(snapshot.nodes[0].blocksEn).toEqual([
      { id: 'b1', text: 'First paragraph.' },
      { id: 'b2', text: '- one\n- two' },
    ]);
    expect(snapshot.nodes[0]).toMatchObject({ keywords: ['k'], version: 2 });
    expect(
      snapshot.edges.map((e) => [e.parentId, e.childId, e.position]),
    ).toEqual([
      [A, B, 0],
      [A, C, 1],
      // the child is archived: kept, so the checks report it
      [B, D, 0],
    ]);
    expect(snapshot.phrasings).toEqual([
      { faqId: B, locale: 'zh-TW', text: '問題' },
    ]);
    expect(checkFaqGraph(snapshot).problems.map((p) => p.rule)).toEqual([
      'edge_endpoint',
    ]);
  });

  it('a choice node has no blocks', () => {
    const snapshot = freezeSnapshot([faq(A, { type: 'choice' })], [], []);
    expect(snapshot.nodes[0].blocksEn).toEqual([]);
  });

  it('the same working tables give the same snapshot and hash, whatever order they are read in', () => {
    const one = freezeSnapshot([faq(A), faq(B)], [row(A, B, 0, 'x')], []);
    const two = freezeSnapshot([faq(B), faq(A)], [row(A, B, 0, 'x')], []);
    expect(snapshotHash(one)).toBe(snapshotHash(two));
    const three = freezeSnapshot(
      [faq(B), faq(A, { answerZh: '改了。' })],
      [row(A, B, 0, 'x')],
      [],
    );
    expect(snapshotHash(three)).not.toBe(snapshotHash(one));
  });

  it('diffs two snapshots: nodes and edges added, changed and removed, phrasings counted', () => {
    const base = freezeSnapshot(
      [faq(A), faq(B), faq(C)],
      [row(A, B, 0, 'x'), row(A, C, 1, 'y')],
      [{ faqId: A, locale: 'en-GB', text: 'one' }],
    );
    const head = freezeSnapshot(
      [faq(A, { questionEn: 'New?' }), faq(B), faq(D)],
      [row(A, B, 0, 'x'), row(A, D, 1, 'z'), { ...row(B, D, 0, 'w') }],
      [{ faqId: A, locale: 'en-GB', text: 'two' }],
    );
    const diff = diffSnapshots(base, head);
    expect(diff.same).toBe(false);
    expect(diff.nodes.added.map((x) => x.id)).toEqual([D]);
    expect(diff.nodes.removed.map((x) => x.id)).toEqual([C]);
    expect(diff.nodes.changed).toEqual([
      expect.objectContaining({ id: A, fields: ['questionEn'] }),
    ]);
    expect(diff.edges.added.map((e) => e.childId)).toEqual([D, D]);
    expect(diff.edges.removed.map((e) => e.childId)).toEqual([C]);
    expect(diff.phrasings).toEqual({ added: 1, removed: 1 });
    expect(diffSnapshots(head, head).same).toBe(true);
    expect(diffSnapshots(null, head).nodes.added).toHaveLength(3);
  });
});

describe('FAQ key slugs (same rule as the SQL backfill)', () => {
  it('lowercases, drops apostrophes, joins words with -, trims and caps at 60', () => {
    expect(faqKeySlug('How do I reset my password?')).toBe(
      'how-do-i-reset-my-password',
    );
    expect(faqKeySlug("I can't sign in — what’s wrong?")).toBe(
      'i-cant-sign-in-whats-wrong',
    );
    expect(faqKeySlug('如何重置密码？')).toBe('faq');
    const long = faqKeySlug(`${'word '.repeat(20)}end`);
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long).not.toMatch(/-$/);
  });
});
