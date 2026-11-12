export type EvaluationMode = 'LECTURE' | 'SOCRATIC';
export type EvaluationLocale = 'zh-CN' | 'en-GB';
export type EvaluationKind = 'single' | 'multi';
export interface EvaluationQuestion {
  conversationId: string;
  turn: number;
  question: string;
  notes: string;
}
export interface EvaluationResult extends EvaluationQuestion {
  mode: EvaluationMode;
  status: 'pending' | 'running' | 'success' | 'failed';
  answer: string;
  error: string | null;
  latencyMs: number;
}
export const MAX_EVALUATION_ANSWERS = 200;

export function validateQuestions(
  questions: EvaluationQuestion[],
  modes: EvaluationMode[],
  kind: EvaluationKind,
): string[] {
  const errors: string[] = [];
  if (!['single', 'multi'].includes(kind)) errors.push('INVALID_KIND');
  if (
    !modes.length ||
    new Set(modes).size !== modes.length ||
    modes.some((mode) => !['LECTURE', 'SOCRATIC'].includes(mode))
  )
    errors.push('INVALID_MODES');
  if (!questions.length) errors.push('EMPTY_FILE');
  if (questions.length * modes.length > MAX_EVALUATION_ANSWERS)
    errors.push('TOO_MANY_ANSWERS');
  const groups = new Map<string, Set<number>>();
  questions.forEach((q, index) => {
    const row = index + 2;
    if (
      !q ||
      typeof q.conversationId !== 'string' ||
      typeof q.question !== 'string' ||
      typeof q.notes !== 'string'
    ) {
      errors.push(`${row}:INVALID_ROW`);
      return;
    }
    if (!q.conversationId?.trim() || q.conversationId.length > 100)
      errors.push(`${row}:INVALID_ID`);
    if (!q.question?.trim() || q.question.length > 8000)
      errors.push(`${row}:INVALID_QUESTION`);
    if (
      !Number.isSafeInteger(q.turn) ||
      q.turn < 1 ||
      (kind === 'single' && q.turn !== 1)
    )
      errors.push(`${row}:INVALID_TURN`);
    const turns = groups.get(q.conversationId) ?? new Set<number>();
    if (turns.has(q.turn)) errors.push(`${row}:DUPLICATE_TURN`);
    turns.add(q.turn);
    groups.set(q.conversationId, turns);
  });
  for (const [id, turns] of groups) {
    if (
      [...turns].sort((a, b) => a - b).some((turn, index) => turn !== index + 1)
    )
      errors.push(`${id}:TURN_GAP`);
  }
  return errors;
}

export function createResults(
  questions: EvaluationQuestion[],
  modes: EvaluationMode[],
): EvaluationResult[] {
  return modes.flatMap((mode) =>
    [...questions]
      .sort(
        (a, b) =>
          a.conversationId.localeCompare(b.conversationId) || a.turn - b.turn,
      )
      .map((q) => ({
        ...q,
        mode,
        status: 'pending' as const,
        answer: '',
        error: null,
        latencyMs: 0,
      })),
  );
}

export function stopResults(results: EvaluationResult[]): EvaluationResult[] {
  return results.map((r) =>
    r.status === 'pending' || r.status === 'running'
      ? {
          ...r,
          status: 'failed',
          error:
            r.status === 'running'
              ? 'USER_STOPPED_INCOMPLETE'
              : 'USER_STOPPED_NOT_EXECUTED',
        }
      : { ...r },
  );
}
