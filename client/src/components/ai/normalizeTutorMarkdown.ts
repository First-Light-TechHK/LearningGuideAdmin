/**
 * 将 AI Tutor 输出的纯文本做轻量预处理，使其能被 react-markdown / MDEditor.Markdown 正确渲染：
 *
 * 1. 行内 `[n]` 引用标记 → `<sup>[n]</sup>`
 *    只匹配独立的 `[数字]`，不匹配 markdown link `[text](url)` / `[text][ref]`。
 *
 * 2. 底部 "Sources" 章节 → 包裹在 `<div class="markdown-sources">` 里，
 *    便于 CSS 独立样式（灰色小字、左边框等）。
 *
 * 3. 安全清理：strip 常见危险标签 + event handler，给 rehype-raw 加一道保险。
 *
 * 设计原则：**纯函数、零依赖**，可在 Portal (Next.js) 和 BackOffice (Vite + AntD) 两边直接复用。
 */
export function normalizeTutorMarkdown(raw: string): string {
  if (!raw || typeof raw !== 'string') return ''
  let s = raw

  // Step 1: 行内 [n] → <sup>[n]</sup>
  // 匹配 `[数字]`，后面不跟 ( 或 [（排除 markdown link）
  s = s.replace(/\[(\d+)\](?![(\[])/g, '<sup>[$1]</sup>')

  // Step 2: 底部 Sources 章节包裹
  // 找到最后出现的 "Sources" 开头段落，把它和后续所有 [数字] 引用行包在 div 里
  s = s.replace(
    /\n?^Sources\s*\n((?:^\[\d+\].*$\n?)+)$/m,
    '\n<div class="markdown-sources">\nSources\n$1</div>\n',
  )

  // Step 3: 安全清理 — strip 常见危险标签
  s = s.replace(
    /<\s*(script|iframe|object|embed|link|meta|style|body|head|html)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
    '',
  )
  s = s.replace(
    /<\s*(script|iframe|object|embed|link|meta|style|body|head|html)[^>]*\/?\s*>/gi,
    '',
  )
  // strip 事件属性 onclick= onload= 等
  s = s.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
  s = s.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')

  return s
}
