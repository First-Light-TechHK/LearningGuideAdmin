import { BadRequestException } from '@nestjs/common';

function readTitle(
  source: string,
): { start: number; end: number; value: string } | null {
  const command = /\\title\s*\{/.exec(source);
  if (!command) return null;
  const start = command.index;
  const contentStart = start + command[0].length;
  let depth = 1;
  for (let index = contentStart; index < source.length; index++) {
    if (source[index - 1] === '\\') continue;
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0)
      return {
        start,
        end: index + 1,
        value: source.slice(contentStart, index),
      };
  }
  return null;
}

/** 单文件 LaTeX 的保守转换：无法保真处理的命令保留在预览中。 */
export function latexToMarkdown(source: string): string {
  if (source.includes('\uFFFD') || source.includes('\0'))
    throw new BadRequestException('LaTeX 文件必须为有效的 UTF-8 文本');
  let text = source
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ');
  text = text.replace(/(^|[^\\])%[^\n]*/g, '$1');
  const titleCommand = readTitle(text);
  let title = titleCommand?.value.trim();
  if (titleCommand)
    text = text.slice(0, titleCommand.start) + text.slice(titleCommand.end);
  if (title) {
    let previous: string;
    do {
      previous = title;
      title = title.replace(/\\(?:textbf|textit|emph)\{([^{}]*)\}/g, '$1');
    } while (title !== previous);
    title = title.replace(/^\*\*(.*?)\*\*$/, '$1').trim();
  }
  const document = text.match(/\\begin\{document\}([\s\S]*?)\\end\{document\}/);
  if (document) text = document[1];
  const lines = text.split('\n');
  const indent = lines.reduce(
    (minimum, line) =>
      line.trim()
        ? Math.min(minimum, line.match(/^[ \t]*/)?.[0].length ?? 0)
        : minimum,
    Infinity,
  );
  if (indent > 0 && Number.isFinite(indent))
    text = lines
      .map((line) =>
        line.slice(Math.min(indent, line.match(/^[ \t]*/)?.[0].length ?? 0)),
      )
      .join('\n');
  // 某些编辑器复制展示公式时把行首的 \[ 和 \] 额外转义一次。
  text = text.replace(/^([ \t]*)\\\\(?=\[|\])/gm, '$1\\');
  text = text.replace(/\\(?:author|date)\{([^{}]*)\}/g, '');
  text = text.replace(/\\maketitle\b/g, '');
  const labels = new Map<string, string>();
  text.replace(
    /\\(?:chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{([^{}]*)\}\s*\\label\{([^{}]*)\}/g,
    (_match, heading: string, label: string) => {
      labels.set(label, heading);
      return '';
    },
  );
  text = text.replace(
    /\\(?:auto|eq)?ref\{([^{}]*)\}/g,
    (match, label: string) => labels.get(label) ?? match,
  );
  text = text.replace(/[ \t]*\\footnote\{([^{}]*)\}/g, ' (Note: $1)');
  text = text.replace(
    /\\begin\{quote\}([\s\S]*?)\\end\{quote\}/g,
    (_match, body: string) =>
      `\n\n${body
        .trim()
        .split('\n')
        .map((line) => `> ${line.trim()}`)
        .join('\n')}\n\n`,
  );
  text = text.replace(
    /\\begin\{tabular\}\{[^{}]*\}([\s\S]*?)\\end\{tabular\}/g,
    (match, body: string) => {
      const rows = body
        .replace(/\\hline\b/g, '')
        .split(/\\\\/)
        .map((row) => row.trim())
        .filter(Boolean);
      const cells = rows.map((row) =>
        row.split(/(?<!\\)&/).map((cell) => cell.trim()),
      );
      const columns = cells[0]?.length ?? 0;
      if (
        rows.length < 2 ||
        columns < 2 ||
        cells.some((row) => row.length !== columns)
      )
        return match;
      const table = cells.map((row) => `| ${row.join(' | ')} |`);
      table.splice(1, 0, `| ${Array(columns).fill('---').join(' | ')} |`);
      return `\n\n${table.join('\n')}\n\n`;
    },
  );
  text = text.replace(/\\label\{[^{}]*\}|\\phantomsection\b/g, '');
  text = text.replace(
    /\\(?:begin|end)\{(?:center|flushleft|flushright|abstract)\}/g,
    '\n\n',
  );
  text = text.replace(/\\(?:vspace|hspace)\*?\{[^{}]*\}/g, '');
  text = text.replace(
    /\\(?:smallskip|medskip|bigskip|newpage|clearpage|pagebreak)\b/g,
    '',
  );
  text = text.replace(
    /\\(?:chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{([^{}]*)\}/g,
    (match, heading: string) => {
      const kind = match.match(/^\\([a-z]+)/)?.[1];
      const level =
        (
          {
            chapter: 1,
            section: 2,
            subsection: 3,
            subsubsection: 4,
            paragraph: 5,
            subparagraph: 6,
          } as Record<string, number>
        )[kind ?? ''] ?? 2;
      return `\n\n${'#'.repeat(level)} ${heading}\n\n`;
    },
  );
  text = text.replace(
    /\\(?:textbf|emph|textit|textsc|underline|texttt)\{([^{}]*)\}/g,
    (match, value: string) =>
      /\\(?:textbf|textsc|underline)/.test(match)
        ? `**${value}**`
        : match.startsWith('\\texttt')
          ? `\`${value}\``
          : `*${value}*`,
  );
  text = text.replace(/\\href\{([^{}]*)\}\{([^{}]*)\}/g, '[$2]($1)');
  text = text.replace(/\\url\{([^{}]*)\}/g, '<$1>');
  text = text.replace(
    /\\\[([\s\S]*?)\\\]/g,
    (_match, formula: string) => `\n\n$$\n${formula.trim()}\n$$\n\n`,
  );
  text = text.replace(
    /\\\(([\s\S]*?)\\\)/g,
    (_match, formula: string) => `$${formula.trim()}$`,
  );
  text = text.replace(
    /\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|displaymath)\}([\s\S]*?)\\end\{\1\}/g,
    (_match, kind: string, formula: string) => {
      const environment =
        kind.startsWith('align') || kind.startsWith('multline')
          ? 'aligned'
          : kind.startsWith('gather')
            ? 'gathered'
            : null;
      const body = environment
        ? `\\begin{${environment}}\n${formula.trim()}\n\\end{${environment}}`
        : formula.trim();
      return `\n\n$$\n${body}\n$$\n\n`;
    },
  );
  const stack: string[] = [];
  text = text.replace(
    /\\(begin|end)\{(itemize|enumerate)\}|\\item\b[ \t]*/g,
    (match, action: string, kind?: string) => {
      if (action === 'begin') {
        stack.push(kind!);
        return '\n';
      }
      if (action === 'end') {
        if (stack.at(-1) !== kind) return match;
        stack.pop();
        return '\n';
      }
      if (!stack.length) return match;
      return `\n${'  '.repeat(stack.length - 1)}${stack.at(-1) === 'enumerate' ? '1.' : '-'} `;
    },
  );
  text = text.replace(/\\(%|\{|\}|&|#|_)/g, '$1');
  text = text
    .replace(/\\(?:par|noindent)\b/g, '\n\n')
    .replace(/\\(?:newline|linebreak)\b/g, '\n')
    .replace(/\\(?:quad|qquad)\b/g, ' ');
  text = text.replace(/~/g, ' ');
  if (title) text = `# ${title}\n\n${text}`;
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n\n[ \t]+/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
