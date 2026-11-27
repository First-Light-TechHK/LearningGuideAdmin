import { tutorModelPolicy } from './model-policy';
import { lectureLanguage, lectureLanguageName } from './lecture-language';
import { compileTutorPrompt } from './prompt-compiler';
import type {
  LlmStreamOptions,
  LlmMessage,
} from '../providers/llm-provider.interface';

const MAX_CONTEXT_MESSAGES = 20;

export function responseLanguage(
  input: string,
  previous = '',
  locale?: string | null,
) {
  const detect = (text: string) => {
    if (/(?:用|使用|请以)\s*英文|\bin English\b/i.test(text)) return 'en-GB';
    if (/(?:用|使用|请以)\s*中文|\bin Chinese\b/i.test(text)) return 'zh-CN';
    if (
      /^(?:what|why|how|when|which|can|could|please|explain|show|describe|is|does)\b/i.test(
        text.trim(),
      )
    )
      return 'en-GB';
    if (/\p{Script=Han}/u.test(text)) return 'zh-CN';
    return undefined;
  };
  return (
    detect(input) ??
    detect(previous) ??
    locale ??
    (/[a-z]/i.test(input) ? 'en-GB' : undefined)
  );
}

function languageGuard(
  input: string,
  mode: 'LECTURE' | 'SOCRATIC',
  previous?: string,
  locale?: string | null,
): string {
  if (mode === 'LECTURE') {
    const language = lectureLanguageName(
      lectureLanguage(input, previous, locale),
    );
    return `Response language rule for this turn:\nWrite the explanation in ${language}. Where helpful, keep the original course term on first mention. Preserve exhibit names, symbols, units and LaTeX as supplied.`;
  }
  const selected = responseLanguage(input, previous, locale);
  const language = selected === 'zh-CN' ? 'Chinese' : selected ? 'English' : '';
  if (!language) return '';
  return [
    'Response language rule for this turn:',
    `The latest student input language is ${language}.`,
    `Answer only in ${language}, regardless of the language used in internal course context, examples, or previous responses.`,
    "Do not translate the student's question unless they explicitly ask for translation.",
  ].join('\n');
}

interface ExhibitContext {
  allowedIds: string[];
  followUp: boolean;
}

function lectureOutputRules(exhibits?: ExhibitContext) {
  const rules = [
    'Preserve qualifications in course evidence: distinguish definitions from properties of a subtype, and a single observation from sufficient evidence. If the material gives only a necessary condition, state what it establishes and leave sufficiency open. State whether endpoints are included when explaining a range. Use the source that directly supports each claim.',
    'Answer the current question directly. If the student asks for just a definition, or asks for no examples, omit examples and analogies. If they ask for an example, give one relevant example. Otherwise add an example only when needed to explain the answer.',
  ];
  if (exhibits) {
    rules.push(
      'Use the supplied exhibit summaries, formulas and course passages for claims about an exhibit. If a requested detail is undocumented, say what the material establishes and what it leaves open. Never infer visual details or symbol meanings from a title alone.',
      'The application renders exhibits. Write a complete sentence before an exhibit marker and put the marker on its own line. Name the supplied course formula by its code when using it. Keep numbered source citations such as [1, 2] separate from exhibit markers. Never put markers or internal IDs in citations or the Sources list. Use only documented source titles. Do not write image URLs or duplicate a displayed equation unless the student asks to see it again.',
      exhibits.allowedIds.length
        ? `Where an exhibit explains the answer, use only its exact standalone marker from this list: ${exhibits.allowedIds.map((id) => `[[ref:${id}]]`).join(', ')}. Never show the ID as prose.`
        : 'Do not emit exhibit markers this turn.',
    );
    if (exhibits.followUp)
      rules.push(
        'Answer the specific follow-up using the previously displayed exhibit. Explain the requested detail without retelling the example or redisplaying the exhibit.',
      );
  }
  return rules.join('\n');
}

export function compileMotherbaseDialogue(input: {
  model?: string;
  basePrompt: string;
  modePrompt: string;
  knowledgeMarkdown: string;
  mode: 'LECTURE' | 'SOCRATIC';
  history: ReadonlyArray<LlmMessage>;
  message: string;
  locale?: string | null;
  exhibits?: ExhibitContext;
  reviewedLecture?: {
    planner: string;
    course: string;
    knowledge: string;
    outputContract: string;
  };
}): {
  messages: LlmMessage[];
  temperature?: number;
  maxOutputTokens: number;
  field4Hash?: string;
  reasoningEffort?: LlmStreamOptions['reasoningEffort'];
  reasoningEnabled?: boolean;
} {
  const question = input.message.trim();
  const guard = languageGuard(
    question,
    input.mode,
    input.history.findLast((item) => item.role === 'user')?.content,
    input.locale,
  );
  if (!question) throw new Error('Message is required.');
  const turnRules = [
    input.mode === 'LECTURE' ? lectureOutputRules(input.exhibits) : '',
    guard,
  ]
    .filter(Boolean)
    .join('\n\n');
  const prompt = [input.basePrompt, input.modePrompt]
    .filter(Boolean)
    .join('\n\n');
  const system = [
    prompt,
    input.knowledgeMarkdown
      ? `Current Knowledge Wiki release markdown:\n${input.knowledgeMarkdown}`
      : 'No KS Wiki context is enabled for this dialogue session.',
    turnRules,
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
  const reviewed = input.reviewedLecture;
  const compiled = reviewed
    ? compileTutorPrompt({
        action: 'study_question',
        roleRules: input.basePrompt,
        studentState: 'Use the recent conversation messages as context.',
        plannerSlice: reviewed.planner,
        courseContext: reviewed.course,
        selectedKnowledge: reviewed.knowledge,
        modeContract: input.modePrompt,
        outputContract: [reviewed.outputContract, turnRules]
          .filter(Boolean)
          .join('\n\n'),
        studentInput: question,
      })
    : undefined;
  const systemMessage = compiled?.messages[0] ?? {
    role: 'system' as const,
    content: system,
  };
  const socratic = input.mode === 'SOCRATIC';
  const policy = tutorModelPolicy(input.model ?? '', input.mode);
  return {
    messages: [
      systemMessage,
      ...history.map((item) => ({ role: item.role, content: item.content })),
      { role: 'user', content: question },
    ],
    ...(input.model === 'anthropic/claude-haiku-5.5'
      ? {}
      : { temperature: socratic ? 0.55 : 0.35 }),
    maxOutputTokens: policy.maxOutputTokens,
    ...(compiled ? { field4Hash: compiled.fieldHashes['4'] } : {}),
    ...(policy.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: policy.reasoningEffort }),
    ...(policy.reasoningEnabled === undefined
      ? {}
      : { reasoningEnabled: policy.reasoningEnabled }),
  };
}
