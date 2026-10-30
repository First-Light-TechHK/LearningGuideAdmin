import type {
  ConversationTurn,
  EvalConversation,
  TurnExpectation,
} from './conversations';

/**
 * 生成器写的 v5 评测集（/mnt/project-files/lg-helpdesk/eval-v5/long.jsonl、casual.jsonl）换成
 * conversations.ts 的格式。生成器按 FAQ 的 key 标注（库里的 id 是导入时才生成的 uuidv7），所以要一个
 * key → id 的对照（--release：从已导入并发布的库里读）。
 *
 *   {"id":"long-1-001","set":"long"|"casual","locale":"zh-CN"|"zh-TW"|"en-GB"|"mixed","persona":"…",
 *    "signals":[…]?,"turns":[{"learner":"…","expect":{"kind":"answer","faq":"<key>"}},
 *      {"learner":"…","expect":{"kind":"clarify","faq":"<key>","covered":true,"point":"…"}},
 *      {"learner":"…","expect":{"kind":"smalltalk","intent":"thanks"|"bye"|"farewell"|…}},
 *      {"learner":"…","expect":{"kind":"handover","why":"keyword"|"two_unsolved","also":{…}?}},
 *      {"learner":"…","expect":{"kind":"no_match"}}]}
 * answer 可另给 "acceptable":["<key>", …]（也算对的 FAQ）。
 *
 * 换法：set long → multi_turn；locale mixed → zh-CN + language mixed（混写的学员界面多半是中文）；
 * thanks / bye → farewell（pick_faq 的 farewell 就是「谢谢、再见」）；point / why / also / signals 只是
 * 生成器的说明，评测不用（signals 是 Portal 的 chips，不发给 Admin）。
 * 期望的是追问（非入口）FAQ 时，另带 entryIds（通向它的入口卡片）：学员新打的问题只在入口里检索
 *（graph design §4），出入口卡片再点追问也算对，报告单独数。
 */

type GeneratorExpect = {
  kind?: unknown;
  faq?: unknown;
  /** 也算对的其它 FAQ key（标注复核时加，说明写在 label-fixes 里）。 */
  acceptable?: unknown;
  intent?: unknown;
  covered?: unknown;
};

type GeneratorConversation = {
  id?: unknown;
  set?: unknown;
  locale?: unknown;
  persona?: unknown;
  turns?: { learner?: unknown; expect?: GeneratorExpect }[];
};

const INTENTS: Record<string, string> = {
  greeting: 'greeting',
  farewell: 'farewell',
  thanks: 'farewell',
  bye: 'farewell',
  vague: 'vague',
  off_topic: 'off_topic',
};

/** 这一行是不是生成器的格式（学员的话写在 learner 里）。 */
export function isGeneratorFormat(raw: unknown): boolean {
  const turns = (raw as GeneratorConversation | null)?.turns;
  return (
    Array.isArray(turns) &&
    turns.some((t) => typeof t === 'object' && t !== null && 'learner' in t)
  );
}

function expectation(
  raw: GeneratorExpect | undefined,
  id: (key: unknown) => string,
  entryAncestors: ReadonlyMap<string, string[]>,
): TurnExpectation | undefined {
  if (raw === undefined) return undefined;
  switch (raw.kind) {
    case 'answer': {
      const faqId = id(raw.faq);
      const acceptableFaqIds = Array.isArray(raw.acceptable)
        ? raw.acceptable.map(id)
        : [];
      const entryIds = [faqId, ...acceptableFaqIds]
        .flatMap((one) => entryAncestors.get(one) ?? [])
        .filter((one, i, all) => all.indexOf(one) === i);
      return {
        kind: 'answer',
        faqId,
        ...(acceptableFaqIds.length > 0 ? { acceptableFaqIds } : {}),
        ...(entryIds.length > 0 ? { entryIds } : {}),
      };
    }
    case 'clarify':
      return {
        kind: 'clarify',
        faqId: id(raw.faq),
        covered: raw.covered as boolean,
      };
    case 'smalltalk': {
      if (raw.intent === undefined) return { kind: 'smalltalk' };
      const named = typeof raw.intent === 'string' ? raw.intent : '';
      const intent = INTENTS[named];
      if (!intent)
        throw new Error(
          `unknown small-talk intent ${named || JSON.stringify(raw.intent)}`,
        );
      return { kind: 'smalltalk', intent } as TurnExpectation;
    }
    case 'no_match':
      return { kind: 'no_match' };
    case 'handover':
      return { kind: 'handover' };
    default:
      throw new Error(`unknown expected kind ${String(raw.kind)}`);
  }
}

/** 已发布的库：key → id，以及每个追问（非入口）节点往上最近的入口节点。 */
export type ReleasedLibrary = {
  idOfKey: ReadonlyMap<string, string>;
  entryAncestors: ReadonlyMap<string, string[]>;
};

/** 每个非入口节点沿边往上走，每条路上第一个入口节点（去重）。 */
export function entryAncestorsOf(
  nodes: { id: string; entry: boolean }[],
  edges: { parentId: string; childId: string }[],
): Map<string, string[]> {
  const entry = new Map(nodes.map((n) => [n.id, n.entry]));
  const parents = new Map<string, string[]>();
  for (const e of edges)
    parents.set(e.childId, [...(parents.get(e.childId) ?? []), e.parentId]);
  const out = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.entry) continue;
    const found = new Set<string>();
    const seen = new Set<string>([node.id]);
    let level = parents.get(node.id) ?? [];
    while (level.length > 0) {
      const up: string[] = [];
      for (const id of level) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (entry.get(id)) found.add(id);
        else up.push(...(parents.get(id) ?? []));
      }
      level = up;
    }
    out.set(node.id, [...found]);
  }
  return out;
}

/** 换一段对话；FAQ key 不在库里就报错（不悄悄丢用例）。 */
export function fromGeneratorFormat(
  raw: unknown,
  library: ReleasedLibrary,
): EvalConversation {
  const { idOfKey } = library;
  const c = raw as GeneratorConversation;
  const id = (key: unknown) => {
    const found = typeof key === 'string' ? idOfKey.get(key) : undefined;
    if (!found)
      throw new Error(`${String(c.id)}: unknown FAQ key ${String(key)}`);
    return found;
  };
  const mixed = c.locale === 'mixed';
  const turns: ConversationTurn[] = (c.turns ?? []).map((t) => {
    const expect = expectation(t.expect, id, library.entryAncestors);
    return {
      message: t.learner as string,
      ...(expect ? { expect } : {}),
    };
  });
  return {
    id: c.id as string,
    set: c.set === 'long' ? 'multi_turn' : (c.set as EvalConversation['set']),
    locale: mixed ? 'zh-CN' : (c.locale as EvalConversation['locale']),
    ...(mixed ? { language: 'mixed' as const } : {}),
    persona: c.persona as string,
    turns,
  };
}
