import type { LlmStreamOptions } from '../providers/llm-provider.interface';

export function tutorModelPolicy(model: string, mode: 'LECTURE' | 'SOCRATIC') {
  const socratic = mode === 'SOCRATIC';
  const policies: Record<
    string,
    {
      budgets: [number, number];
      effort?: LlmStreamOptions['reasoningEffort'];
      enabled?: boolean;
    }
  > = {
    'deepseek/deepseek-v4.1-flash': { budgets: [8192, 4096], effort: 'low' },
    'deepseek/deepseek-r1-0528': { budgets: [16384, 8192] },
    'openai/gpt-4o-mini': { budgets: [4096, 2048] },
    'anthropic/claude-haiku-5.5': { budgets: [8192, 4096], effort: 'low' },
    'google/gemini-3.5-flash': {
      budgets: [8192, 4096],
      effort: socratic ? 'minimal' : 'low',
    },
    'qwen/qwen3.6-flash': { budgets: [8192, 4096], enabled: false },
    'google/gemma-4-31b-it': { budgets: [4096, 2048], enabled: false },
    'nvidia/nemotron-3-super-120b-a12b': {
      budgets: [8192, 4096],
      effort: 'low',
    },
  };
  const policy = policies[model] ?? { budgets: [4096, 2048] };
  return {
    maxOutputTokens: policy.budgets[socratic ? 1 : 0],
    reasoningEffort: policy.effort,
    reasoningEnabled: policy.enabled,
  };
}
