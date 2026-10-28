/**
 * FAQ 答案的 Markdown 子集（Tickets v2 §1，正好是抽屉工具栏写得出来的）：
 * `**粗体**`、有序列表 `1. `、无序列表 `- `、链接 `[文字](https://… | mailto:…)`、段落（空行分隔，
 * 段内换行保留）。只解析成数据结构，由 helpdesk/Markdown.tsx 渲染成 React 元素：
 * 不支持任何原始 HTML（React 一律当文字转义），链接只认 http(s) 与 mailto，与 Server 的保存校验
 * （faqService.ts 的 SAFE_URL）同一条规则。单测在 client/tests/helpdesk-markdown.test.tsx。
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }

export type Block =
  | { kind: 'paragraph'; lines: Inline[][] }
  | { kind: 'ordered' | 'bullet'; start: number; items: Inline[][] }

const SAFE_URL = /^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i
/** 与 Server 一致：[文字](地址)，文字不跨行、不含 ]，地址到第一个 ) 为止。 */
export const LINK_PATTERN = /\[([^\]\n]*)\]\(([^)\n]*)\)/g
const ORDERED = /^(\d{1,9})\.\s+(.*)$/
const BULLET = /^[-*]\s+(.*)$/

/** 只放行 http(s):// 与 mailto:（去首尾空白）；其它一律 null。 */
export function safeHref(raw: string): string | null {
  const url = raw.trim()
  return SAFE_URL.test(url) ? url : null
}

function pushText(out: Inline[], text: string) {
  if (text === '') return
  const last = out[out.length - 1]
  if (last && last.kind === 'text') last.text += text
  else out.push({ kind: 'text', text })
}

/** 行内：链接与成对的 ** 。不安全的链接、落单的 ** 原样当文字。 */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let rest = text
  while (rest !== '') {
    LINK_PATTERN.lastIndex = 0
    const link = LINK_PATTERN.exec(rest)
    const boldStart = rest.indexOf('**')
    const boldEnd = boldStart >= 0 ? rest.indexOf('**', boldStart + 2) : -1
    const hasBold = boldStart >= 0 && boldEnd > boldStart + 2
    if (link && (!hasBold || link.index < boldStart)) {
      pushText(out, rest.slice(0, link.index))
      const href = safeHref(link[2])
      if (href) out.push({ kind: 'link', href, children: parseInline(link[1]) })
      else pushText(out, link[0])
      rest = rest.slice(link.index + link[0].length)
      continue
    }
    if (hasBold) {
      pushText(out, rest.slice(0, boldStart))
      out.push({ kind: 'bold', children: parseInline(rest.slice(boldStart + 2, boldEnd)) })
      rest = rest.slice(boldEnd + 2)
      continue
    }
    pushText(out, rest)
    break
  }
  return out
}

/** 块级：空行分段；以 `1. ` / `- ` 开头的连续行是列表（不需要先空一行）。 */
export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = []
  let paragraph: Inline[][] | null = null
  let list: Extract<Block, { kind: 'ordered' | 'bullet' }> | null = null
  const close = () => {
    paragraph = null
    list = null
  }
  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    if (line === '') {
      close()
      continue
    }
    const ordered = ORDERED.exec(line)
    const bullet = ordered ? null : BULLET.exec(line)
    if (ordered || bullet) {
      const kind = ordered ? 'ordered' : 'bullet'
      const content = ordered ? ordered[2] : (bullet as RegExpExecArray)[1]
      if (!list || list.kind !== kind) {
        paragraph = null
        list = { kind, start: ordered ? Number(ordered[1]) : 1, items: [] }
        blocks.push(list)
      }
      list.items.push(parseInline(content))
      continue
    }
    list = null
    if (!paragraph) {
      paragraph = []
      blocks.push({ kind: 'paragraph', lines: paragraph })
    }
    paragraph.push(parseInline(line))
  }
  return blocks
}

function plain(inlines: Inline[]): string {
  return inlines.map((node) => (node.kind === 'text' ? node.text : plain(node.children))).join('')
}

/**
 * Help Centre / FAQ 列表的副标题（§1）：答案第一行非空文字，去掉 Markdown，超长截断加省略号。
 */
export function summaryLine(answer: string, max = 100): string {
  const first = parseMarkdown(answer)[0]
  if (!first) return ''
  const inlines = first.kind === 'paragraph' ? first.lines[0] : first.items[0]
  const text = plain(inlines).replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}
