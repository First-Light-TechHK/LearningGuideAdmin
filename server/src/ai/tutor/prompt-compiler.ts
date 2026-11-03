import { createHash } from 'node:crypto';
import type { LlmMessage } from '../providers/llm-provider.interface';

export interface TutorPromptFields {
  roleRules: string;
  studentState: string;
  plannerSlice: string;
  courseContext: string;
  selectedKnowledge: string;
  modeContract: string;
  rubric?: string;
  outputContract: string;
  studentInput: string;
  action: 'study_question' | 'submitted_answer';
}

export interface CompiledTutorPrompt {
  messages: LlmMessage[];
  fieldHashes: Record<string, string>;
  promptHash: string;
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 编译后的输入仍需由调用方完成教学授权与安全校验。 */
export function compileTutorPrompt(
  fields: TutorPromptFields,
): CompiledTutorPrompt {
  if (fields.action === 'submitted_answer' && !fields.rubric?.trim()) {
    throw new Error('submitted_answer requires a rubric');
  }
  const blocks: Array<[string, string]> = [
    ['1', fields.roleRules],
    ['2', fields.studentState],
    ['2a', fields.plannerSlice],
    ['3', fields.courseContext],
    ['4', fields.selectedKnowledge],
    ['5', fields.modeContract],
  ];
  if (fields.action === 'submitted_answer') blocks.push(['6', fields.rubric!]);
  blocks.push(['7', fields.outputContract]);
  const fieldHashes = Object.fromEntries(
    [...blocks, ['8', fields.studentInput] as [string, string]].map(
      ([id, value]) => [id, hash(value)],
    ),
  );
  const messages: LlmMessage[] = [
    {
      role: 'system',
      content: blocks
        .map(([id, value]) => `FIELD ${id}\n${JSON.stringify(value)}`)
        .join('\n\n'),
    },
    { role: 'user', content: fields.studentInput },
  ];
  return {
    messages,
    fieldHashes,
    promptHash: hash(JSON.stringify(messages)),
  };
}
