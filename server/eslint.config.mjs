// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  // 三域边界（docs/Engine_Split_Implementation.md）：Agent、KS、BackOffice 互不 import 实现，
  // Agent 读 KS 只能经 src/ks/contract。组装只在 app.module.ts 做；单测可跨域造数据。
  {
    files: ['src/ai/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            regex: '(^|/)(courses|pages|releases|sync|tags|files|backoffice)(/|$)',
            message: 'Agent 不能 import KS 或 BackOffice 的实现',
          },
          {
            regex: '(^|/)ks/(?!contract/)',
            message: 'Agent 读 KS 只能经 src/ks/contract',
          },
        ],
      }],
    },
  },
  {
    files: ['src/{courses,pages,releases,sync,tags,files,ks}/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            regex: '(^|/)(ai|backoffice)(/|$)',
            message: 'KS 不能 import Agent 或 BackOffice 的实现',
          },
        ],
      }],
    },
  },
  {
    files: ['src/backoffice/**/*.ts'],
    ignores: ['**/*.spec.ts', 'src/backoffice/tests/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            regex: '(^|/)(ai|ks|courses|pages|releases|sync|tags|files)(/|$)',
            message: 'BackOffice 不能 import Agent 或 KS 的实现',
          },
        ],
      }],
    },
  },
);
