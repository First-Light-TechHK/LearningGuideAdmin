export interface TutorCandidate {
  id: string;
  courseId: string;
  releaseId: string;
  status: 'approved' | 'candidate';
  priority: number;
  score: number;
  tokenCount: number;
  requiredIds: string[];
}

export interface TutorSelection {
  /** 此原型不校验包绑定、教学资格与规则覆盖，不可作为运行时授权。 */
  coverageVerified: false;
  selected: TutorCandidate[];
  excluded: Array<{ id: string; reason: string }>;
  tokenCount: number;
}

/** 离线预算原型；接入运行时前必须完成包绑定、教学资格与规则覆盖验证。 */
export function selectTutorCandidates(input: {
  courseId: string;
  releaseId: string;
  candidates: TutorCandidate[];
  requiredIds: string[];
  maxTokens?: number;
}): TutorSelection {
  const maxTokens = input.maxTokens ?? 1100;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1)
    throw new Error('invalid token budget');
  const byId = new Map<string, TutorCandidate>();
  for (const card of input.candidates) {
    if (!card.id || byId.has(card.id))
      throw new Error('duplicate or empty card id');
    if (
      !Number.isFinite(card.priority) ||
      !Number.isFinite(card.score) ||
      !Number.isSafeInteger(card.tokenCount) ||
      card.tokenCount < 1
    )
      throw new Error('invalid card metadata');
    byId.set(card.id, card);
  }
  const eligible = (card: TutorCandidate) =>
    card.status === 'approved' &&
    card.courseId === input.courseId &&
    card.releaseId === input.releaseId;
  const selected = new Map<string, TutorCandidate>();
  const closure = (id: string, pending: Set<string>): void => {
    if (selected.has(id) || pending.has(id)) return;
    const card = byId.get(id);
    if (!card || !eligible(card))
      throw new Error(`required card unavailable: ${id}`);
    pending.add(id);
    for (const dependency of card.requiredIds) closure(dependency, pending);
  };
  const add = (id: string, required: boolean): boolean => {
    const pending = new Set<string>();
    try {
      closure(id, pending);
    } catch (error) {
      if (required) throw error;
      return false;
    }
    const cards = Array.from(pending, (key) => byId.get(key)!);
    const tokens =
      Array.from(selected.values()).reduce(
        (sum, card) => sum + card.tokenCount,
        0,
      ) + cards.reduce((sum, card) => sum + card.tokenCount, 0);
    if (selected.size + cards.length > 5 || tokens > maxTokens) {
      if (required) throw new Error('required cards exceed selection budget');
      return false;
    }
    for (const card of cards) selected.set(card.id, card);
    return true;
  };
  for (const id of [...new Set(input.requiredIds)].sort()) add(id, true);
  const ranked = input.candidates
    .filter(eligible)
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        b.score - a.score ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  for (const card of ranked) if (!selected.has(card.id)) add(card.id, false);
  if (selected.size < 2) throw new Error('insufficient eligible cards');
  const result = ranked.filter((card) => selected.has(card.id));
  return {
    coverageVerified: false,
    selected: result,
    excluded: input.candidates
      .filter((card) => !selected.has(card.id))
      .map((card) => ({
        id: card.id,
        reason: eligible(card) ? 'not_selected' : 'not_eligible',
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    tokenCount: result.reduce((sum, card) => sum + card.tokenCount, 0),
  };
}
