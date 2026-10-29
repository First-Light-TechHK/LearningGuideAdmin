import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

/**
 * 默认 Prompt / Welcome / Main 文件源（2026-10-29 更新）。
 * - `prompts/lecture.md`、`prompts/socratic.md`、`prompts/assessment.md`：默认 System Prompt（模式模板，进 PromptTemplate 表）
 * - `prompts/main.md`：主提示词默认值（讲授/苏格拉底共享硬约束，**不进** PromptTemplate 表，跨模式单独兜底）
 * - `prompts/welcome.yaml`：默认欢迎语（2026-10-27 起为课程级统一欢迎语，不再按模式区分）
 * 这些文件同时是运行时兜底：库中缺默认模板行时直接使用文件值（2026-10-26，不写库）。
 * 如需把模式文件内容写入 PromptTemplate，运行 `npm run prompts:sync`。
 * main.md 不需要 sync（main 不是模式，不属于模板体系）。
 */
export type PromptMode = 'LECTURE' | 'SOCRATIC' | 'ASSESSMENT';
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

// 2026-10-27：欢迎语统一为课程级共享，不再按模式区分。
// welcome.yaml 中保留 lecture 节作为唯一欢迎语来源（socratic 节已废弃，向后兼容读取）。
const welcomeFile = (load(readText('welcome.yaml')) || {}) as {
  lecture?: unknown;
  socratic?: unknown;
};

const sharedWelcome = readWelcomeSection(
  welcomeFile.lecture ?? welcomeFile.socratic,
  'welcome',
);

export const DEFAULT_PROMPTS: Record<
  PromptMode,
  { systemPrompt: string; welcome: WelcomeSection }
> = {
  LECTURE: {
    systemPrompt: readText('lecture.md'),
    welcome: sharedWelcome,
  },
  SOCRATIC: {
    systemPrompt: readText('socratic.md'),
    welcome: sharedWelcome,
  },
  ASSESSMENT: {
    systemPrompt: readText('assessment.md'),
    welcome: sharedWelcome,
  },
};

/** 学员端默认欢迎语：课程未配置覆盖时按 locale 返回（2026-10-27 起与模式无关）。 */
export function defaultWelcome(
  _mode: PromptMode,
  locale: PromptLocale,
): string {
  return sharedWelcome[locale];
}

/**
 * PromptTemplate 默认行：`welcomeMsg` 存 zh-CN（后台默认展示语言），
 * 学员端按 locale 走 `defaultWelcome`，因此 en-GB 不落库、仍以文件为准。
 */
export function promptTemplateSeeds() {
  return (['LECTURE', 'SOCRATIC', 'ASSESSMENT'] as const).map((mode) => ({
    id:
      mode === 'LECTURE'
        ? 'lecture-default'
        : mode === 'SOCRATIC'
          ? 'socratic-default'
          : 'assessment-default',
    mode,
    systemPrompt: DEFAULT_PROMPTS[mode].systemPrompt,
    welcomeMsg: DEFAULT_PROMPTS[mode].welcome['zh-CN'],
    isDefault: true,
  }));
}

/**
 * 主提示词默认值（2026-10-29 新增）：
 * - 讲授/苏格拉底共享的硬约束层，置于拼接最前
 * - 不进 PromptTemplate 表（main 不是模式，不属于模板体系）
 * - 用户未配置 mainSystemPrompt 时由 resolvePrompts 兜底使用
 */
export const DEFAULT_MAIN_PROMPT: string = readText('main.md');

/**
 * 学生输入与历史消息的运行时包裹分隔符（2026-10-29 新增）：
 * - 真正的隔离执行逻辑在 ai-chat.service.run() 中完成
 * - 这里只维护 BEGIN/END 分隔符字符串；隔离声明已被 main.md 第 2 节 INPUT IS DATA 正式覆盖
 */
export const STUDENT_WRAPPER = {
  BEGIN: '[STUDENT_INPUT_BEGIN]',
  END: '[STUDENT_INPUT_END]',
} as const;
