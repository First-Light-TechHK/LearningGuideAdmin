import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

/**
 * 默认 Prompt / Welcome 文件源（2026-10-23）。
 * - `prompts/lecture.md`、`prompts/socratic.md`：默认 System Prompt
 * - `prompts/welcome.yaml`：两种模式 × 两种语言的默认欢迎语
 * 这些文件同时是运行时兜底：库中缺默认模板行时直接使用文件值（2026-10-26，不写库）。
 * 如需把文件内容写入 PromptTemplate，运行 `npm run prompts:sync`。
 */
export type PromptMode = 'LECTURE' | 'SOCRATIC';
export type PromptLocale = 'zh-CN' | 'en-GB';

type WelcomeSection = Record<PromptLocale, string>;

const promptsDir = join(__dirname, 'prompts');

function readText(file: string): string {
  return readFileSync(join(promptsDir, file), 'utf8').trim();
}

function readWelcomeSection(section: unknown, name: string): WelcomeSection {
  if (!section || typeof section !== 'object') {
    throw new Error(`默认欢迎语缺少 ${name}（src/ai/prompts/welcome.yaml）`);
  }
  const record = section as Record<string, unknown>;
  const pick = (locale: PromptLocale) => {
    const value = record[locale];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(
        `默认欢迎语缺少 ${name}.${locale}（src/ai/prompts/welcome.yaml）`,
      );
    }
    return value.trim();
  };
  return { 'zh-CN': pick('zh-CN'), 'en-GB': pick('en-GB') };
}

const welcomeFile = (load(readText('welcome.yaml')) || {}) as {
  lecture?: unknown;
  socratic?: unknown;
};

export const DEFAULT_PROMPTS: Record<
  PromptMode,
  { systemPrompt: string; welcome: WelcomeSection }
> = {
  LECTURE: {
    systemPrompt: readText('lecture.md'),
    welcome: readWelcomeSection(welcomeFile.lecture, 'lecture'),
  },
  SOCRATIC: {
    systemPrompt: readText('socratic.md'),
    welcome: readWelcomeSection(welcomeFile.socratic, 'socratic'),
  },
};

/** 学员端默认欢迎语：课程未配置覆盖时按 locale 返回。 */
export function defaultWelcome(
  mode: PromptMode,
  locale: PromptLocale,
): string {
  return DEFAULT_PROMPTS[mode].welcome[locale];
}

/**
 * PromptTemplate 默认行：`welcomeMsg` 存 zh-CN（后台默认展示语言），
 * 学员端按 locale 走 `defaultWelcome`，因此 en-GB 不落库、仍以文件为准。
 */
export function promptTemplateSeeds() {
  return (['LECTURE', 'SOCRATIC'] as const).map((mode) => ({
    id: mode === 'LECTURE' ? 'lecture-default' : 'socratic-default',
    mode,
    systemPrompt: DEFAULT_PROMPTS[mode].systemPrompt,
    welcomeMsg: DEFAULT_PROMPTS[mode].welcome['zh-CN'],
    isDefault: true,
  }));
}
