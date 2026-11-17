import { tutorModelPolicy } from './model-policy';
import type {
  LlmStreamOptions,
  LlmMessage,
} from '../providers/llm-provider.interface';

const MAX_CONTEXT_MESSAGES = 20;

function languageGuard(input: string): string {
  const cjkCount = (input.match(/[\u3400-\u9fff]/g) || []).length;
  const latinCount = (input.match(/[A-Za-z]/g) || []).length;
  const language =
    latinCount > 0 && latinCount >= cjkCount * 2
      ? 'English'
      : cjkCount > 0
        ? 'Chinese'
        : '';
  if (!language) return '';
  return [
    'Response language rule for this turn:',
    `The latest student input language is ${language}.`,
    `Answer only in ${language}, regardless of the language used in internal course context, examples, or previous responses.`,
    "Do not translate the student's question unless they explicitly ask for translation.",
  ].join('\n');
}

export function compileMotherbaseDialogue(input: {
  model?: string;
  basePrompt: string;
  modePrompt: string;
  knowledgeMarkdown: string;
  mode: 'LECTURE' | 'SOCRATIC';
  history: ReadonlyArray<LlmMessage>;
  message: string;
}): {
  messages: LlmMessage[];
  temperature?: number;
  maxOutputTokens: number;
  reasoningEffort?: LlmStreamOptions['reasoningEffort'];
  reasoningEnabled?: boolean;
} {
  const question = input.message.trim();
  if (!question) throw new Error('Message is required.');
  const prompt = [input.basePrompt, input.modePrompt]
    .filter(Boolean)
    .join('\n\n');
  const system = [
    prompt,
    input.knowledgeMarkdown
      ? `Current Knowledge Wiki release markdown:\n${input.knowledgeMarkdown}`
      : 'No KS Wiki context is enabled for this dialogue session.',
    languageGuard(question),
  ]
    .filter(Boolean)
    .join('\n\n');
  const history = input.history
    .filter(
      (item) =>
        (item.role === 'user' || item.role === 'assistant') &&
        item.content?.trim(),
    )
    .slice(-MAX_CONTEXT_MESSAGES);
  const socratic = input.mode === 'SOCRATIC';
  const policy = tutorModelPolicy(input.model ?? '', input.mode);
  return {
    messages: [
      { role: 'system', content: system },
      ...history.map((item) => ({ role: item.role, content: item.content })),
      { role: 'user', content: question },
    ],
    ...(input.model === 'anthropic/claude-haiku-5.5'
      ? {}
      : { temperature: socratic ? 0.55 : 0.35 }),
    maxOutputTokens: policy.maxOutputTokens,
    ...(policy.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: policy.reasoningEffort }),
    ...(policy.reasoningEnabled === undefined
      ? {}
      : { reasoningEnabled: policy.reasoningEnabled }),
  };
}
