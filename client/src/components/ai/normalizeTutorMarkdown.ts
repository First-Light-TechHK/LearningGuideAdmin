/** 只规范显示语法；代码和公式均保留原文，引用交由 Markdown AST 处理。 */
export function normalizeTutorMarkdown(raw: string): string {
  if (!raw || typeof raw !== 'string') return ''
  const protectedToken = /(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1[ \t]*(?=\n|$)|$)|(`+)[^\n]*?\2|\\\[[\s\S]*?(?:\\\]|$)|\\\([\s\S]*?(?:\\\)|$)|(?<!\\)\$\$[\s\S]*?(?:\$\$|$)|(?<!\\)\$(?!\$)[^$\n]*(?:\$|(?=\n|$))/g
  const prose = (text: string) => text
    .replace(/^(?: {4,}|\t+)(?=(?:\*\*|[-*] |Sources[ \t]*$|\[\d+\][ \t]))/gm, '')
    .replace(
      /^Sources[ \t]*\n((?:\[\d+\][^\n]*(?:\n|$))+)[ \t]*$/m,
      (_match, entries: string) => `> Sources\n>\n${entries.trimEnd().replace(/[ \t]+(?=\[\d+\][ \t])/g, '\n').split('\n').map((line) => `> ${line}`).join('\n>\n')}\n`,
    )
  let result = '', start = 0
  for (const match of raw.matchAll(protectedToken)) {
    result += prose(raw.slice(start, match.index))
    let token = match[0]
    if (token.startsWith('\\[') && token.endsWith('\\]')) {
      token = `\n$$\n${token.slice(2, -2)}\n$$\n`
    } else if (token.startsWith('\\(') && token.endsWith('\\)')) {
      token = `$${token.slice(2, -2)}$`
    } else if (/^\$\d/.test(token) && /\s/.test(token) && !/[=+*/^_\\{}<>-]/.test(token.slice(1, -1))) {
      token = token.replace(/\$/g, '\\$')
    }
    result += token
    start = match.index + match[0].length
  }
  return result + prose(raw.slice(start))
}
