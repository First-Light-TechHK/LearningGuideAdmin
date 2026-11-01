/**
 * FAQ 答案 Markdown 子集的解析器：与 Portal modules/helpdesk/markdown.ts（学生端唯一的渲染器）逐行相同的移植，
 * 以及 client/src/backoffice/lib/helpdeskMarkdown.ts（Preview 与 AI 块）。三份由同一份语料
 * tests/fixtures/helpdesk-markdown-corpus.json（三处逐字节相同，sha256 固定）锁定。Server 只用它做保存校验：
 * 渲染器会丢掉的 [文字](地址) 链接（unsafeLinks）一律拒绝保存，保证坐席预览的就是学生看到的。
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'link'; href: string; external: boolean; children: Inline[] };
export type Line = Inline[];
export type MarkdownBlock =
  | { kind: 'paragraph'; lines: Line[] }
  | { kind: 'ordered'; start: number; items: Line[][] }
  | { kind: 'bullet'; items: Line[][] };

/** 编号列表项与无序列表项（faqBlocks.ts 切块用同一对规则）。 */
export const ORDERED = /^ {0,3}(\d{1,9})[.)][ \t]+(.*)$/;
export const BULLET = /^ {0,3}[-*+][ \t]+(.*)$/;
const BARE_URL = /^https?:\/\/[^\s<>"'`]+/i;
const TRAILING = '.,;:!?)]}\'"';

const count = (text: string, char: string) => text.split(char).length - 1;

/** A bare URL without trailing punctuation; a closing ")" stays when it balances an "(" in the URL. */
function trimBareUrl(raw: string): string {
  let url = raw;
  while (url && TRAILING.includes(url[url.length - 1])) {
    if (url.endsWith(')') && count(url, '(') >= count(url, ')')) break;
    url = url.slice(0, -1);
  }
  return url;
}

/** The index of the ")" that closes a link target opened just before start, counting nested parentheses; -1 if none. */
function targetClose(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

/** The link target if it is an absolute http(s) URL with a host or a mailto with an address; otherwise null. */
export function safeHref(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (!raw || /[\s"'<>`\\\u0000-\u001f\u007f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (!/^https?:\/\/[^/?#]/i.test(raw) || !url.hostname) return null;
    return url.href;
  }
  if (url.protocol === 'mailto:')
    return /^mailto:[^@]+@[^@]+$/i.test(raw) ? `mailto:${raw.slice(7)}` : null;
  return null;
}

function pushText(out: Inline[], text: string) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === 'text') last.text += text;
  else out.push({ kind: 'text', text });
}

function link(href: string, children: Inline[]): Inline {
  return {
    kind: 'link',
    href,
    external: !href.startsWith('mailto:'),
    children,
  };
}

/** Inline Markdown of one line. inLink: no nested links or autolinks inside a link label. rejected collects dropped link targets. */
export function parseInline(
  source: string,
  inLink = false,
  rejected?: string[],
): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    if (rest.startsWith('\\') && /^\\[\\*[\]()_`-]/.test(rest)) {
      pushText(out, rest[1]);
      i += 2;
      continue;
    }
    if (rest.startsWith('**')) {
      const close = source.indexOf('**', i + 2);
      if (close > i + 2) {
        out.push({
          kind: 'strong',
          children: parseInline(source.slice(i + 2, close), inLink, rejected),
        });
        i = close + 2;
        continue;
      }
      pushText(out, '**');
      i += 2;
      continue;
    }
    if (!inLink && rest.startsWith('[')) {
      const labelEnd = source.indexOf(']', i + 1);
      if (labelEnd > i + 1 && source[labelEnd + 1] === '(') {
        const targetEnd = targetClose(source, labelEnd + 2);
        if (targetEnd > labelEnd + 2) {
          const label = parseInline(source.slice(i + 1, labelEnd), true);
          const target = source.slice(labelEnd + 2, targetEnd).trim();
          const href = safeHref(target);
          if (!href) rejected?.push(target);
          if (href) out.push(link(href, label));
          else
            for (const part of label)
              if (part.kind === 'text') pushText(out, part.text);
              else out.push(part);
          i = targetEnd + 1;
          continue;
        }
      }
    }
    if (
      !inLink &&
      (rest[0] === 'h' || rest[0] === 'H') &&
      (i === 0 || !/[\p{L}\p{N}]/u.test(source[i - 1]))
    ) {
      const match = BARE_URL.exec(rest);
      if (match) {
        const url = trimBareUrl(match[0]);
        const href = safeHref(url);
        if (href) {
          out.push(link(href, [{ kind: 'text', text: url }]));
          i += url.length;
          continue;
        }
      }
    }
    pushText(out, source[i]);
    i += 1;
  }
  return out;
}

type ListKind = 'ordered' | 'bullet';

export function parseMarkdown(
  source: string,
  rejected?: string[],
): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let paragraph: Line[] | null = null;
  let list: { kind: ListKind; start: number; items: Line[][] } | null = null;
  let blankBefore = false;
  const closeParagraph = () => {
    if (paragraph) blocks.push({ kind: 'paragraph', lines: paragraph });
    paragraph = null;
  };
  const closeList = () => {
    if (list)
      blocks.push(
        list.kind === 'ordered'
          ? { kind: 'ordered', start: list.start, items: list.items }
          : { kind: 'bullet', items: list.items },
      );
    list = null;
  };
  for (const rawLine of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.replace(/[ \t]+$/, '');
    if (!line.trim()) {
      closeParagraph();
      blankBefore = true;
      continue;
    }
    const ordered = ORDERED.exec(line);
    const bullet = ordered ? null : BULLET.exec(line);
    if (ordered || bullet) {
      const kind: ListKind = ordered ? 'ordered' : 'bullet';
      const text = (ordered ? ordered[2] : bullet![1]).trim();
      closeParagraph();
      if (list && (list as { kind: ListKind }).kind !== kind) closeList();
      if (!list)
        list = { kind, start: ordered ? Number(ordered[1]) : 1, items: [] };
      (list as { items: Line[][] }).items.push([
        parseInline(text, false, rejected),
      ]);
      blankBefore = false;
      continue;
    }
    const current = list as { items: Line[][] } | null;
    // In a list: a line straight after an item continues it (lazy continuation), as does an indented line after a blank line.
    if (current && (!blankBefore || /^[ \t]/.test(line))) {
      current.items[current.items.length - 1].push(
        parseInline(line.trim(), false, rejected),
      );
      blankBefore = false;
      continue;
    }
    closeList();
    (paragraph ??= []).push(parseInline(line.trim(), false, rejected));
    blankBefore = false;
  }
  closeParagraph();
  closeList();
  return blocks;
}

/** The [label](target) targets the renderer drops because safeHref refuses them; Admin refuses to save an answer with any. */
export function unsafeLinks(source: string): string[] {
  const rejected: string[] = [];
  parseMarkdown(source, rejected);
  return rejected;
}
