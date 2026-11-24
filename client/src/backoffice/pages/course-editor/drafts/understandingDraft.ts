import type { Lesson } from '../../../contracts/course';
import { keepIfDirty } from './merge';

export type UnderstandingQuestionDraft = { code: string; question: string; referenceAnswer: string };

/** 理解面板的全部本地草稿（知识测试 + 应用测试）。 */
export type UnderstandingDraft = {
  knowledgeEnabled: boolean;
  questions: UnderstandingQuestionDraft[];
  applicationEnabled: boolean;
  applicationScenario: string;
  applicationAnswer: string;
};

function questionCode(code: string | null | undefined, index: number): string {
  return code ?? `K-${String(index + 1).padStart(4, '0')}`;
}

/** 服务器快照 → 理解面板草稿。 */
export function understandingDraftOf(lesson: Lesson): UnderstandingDraft {
  return {
    knowledgeEnabled: true,
    questions: lesson.questions.map((question, index) => ({
      code: questionCode(question.code, index),
      question: question.question,
      referenceAnswer: question.referenceAnswer ?? '',
    })),
    applicationEnabled: Boolean(lesson.applicationTest),
    applicationScenario: lesson.applicationTest?.scenario ?? '',
    applicationAnswer: lesson.applicationTest?.referenceAnswer ?? '',
  };
}

/** 重载后的合并：题目数组整体比较，其余逐字段（与 6a833b2 的数组语义一致）。 */
export function mergeUnderstandingDraft(current: UnderstandingDraft, snapshot: UnderstandingDraft, server: UnderstandingDraft): UnderstandingDraft {
  return {
    knowledgeEnabled: keepIfDirty(current.knowledgeEnabled, snapshot.knowledgeEnabled, server.knowledgeEnabled),
    questions: keepIfDirty(current.questions, snapshot.questions, server.questions),
    applicationEnabled: keepIfDirty(current.applicationEnabled, snapshot.applicationEnabled, server.applicationEnabled),
    applicationScenario: keepIfDirty(current.applicationScenario, snapshot.applicationScenario, server.applicationScenario),
    applicationAnswer: keepIfDirty(current.applicationAnswer, snapshot.applicationAnswer, server.applicationAnswer),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** 存储里的理解草稿：外部输入在边界解析一次；形状不符 → 整条按损坏处理。 */
export function parseUnderstandingDraft(raw: unknown): UnderstandingDraft | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.knowledgeEnabled !== 'boolean' || typeof raw.applicationEnabled !== 'boolean') return null;
  if (!isString(raw.applicationScenario) || !isString(raw.applicationAnswer)) return null;
  if (!Array.isArray(raw.questions)) return null;
  const questions: UnderstandingQuestionDraft[] = [];
  for (const row of raw.questions) {
    if (!isRecord(row) || !isString(row.code) || !isString(row.question) || !isString(row.referenceAnswer)) return null;
    questions.push({ code: row.code, question: row.question, referenceAnswer: row.referenceAnswer });
  }
  return {
    knowledgeEnabled: raw.knowledgeEnabled,
    questions,
    applicationEnabled: raw.applicationEnabled,
    applicationScenario: raw.applicationScenario,
    applicationAnswer: raw.applicationAnswer,
  };
}
