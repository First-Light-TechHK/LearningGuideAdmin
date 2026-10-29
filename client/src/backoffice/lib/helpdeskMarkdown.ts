/**
 * FAQ 答案的 Markdown 子集（Tickets v2 §1）：与 Portal modules/helpdesk/markdown.ts（学生端 Help Centre、
 * 聊天面板、提交弹窗共用的唯一渲染器）逐行相同的移植，因为 §1 要求 Preview 与学生端用同一个渲染器：
 * `**粗体**`、`1. ` / `1) ` 有序列表、`- ` / `* ` / `+ ` 无序列表（含紧随其后的续行与空行分隔的松散列表）、
 * `[文字](https://… | mailto:…)` 链接（地址里的成对括号算地址的一部分）、裸 http(s) 地址、段落。
 * 不解析任何原始 HTML（React 一律当文字转义）；safeHref 不认的链接只保留文字。
 * Server 的保存校验（server faqs/faqMarkdown.ts）是同一份移植，用 unsafeLinks 拒绝这些链接。
 * 三份由共用语料 client/tests/fixtures/helpdesk-markdown-corpus.json 锁定（与 Portal、Server 逐字节相同）。
 * 由 helpdesk/Markdown.tsx 渲染成 React 元素。
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'link'; href: string; external: boolean; children: Inline[] }
export type Line = Inline[]
export type Block =
  | { kind: 'paragraph'; lines: Line[] }
  | { kind: 'ordered'; start: number; items: Line[][] }
  | { kind: 'bullet'; items: Line[][] }

const ORDERED = /^ {0,3}(\d{1,9})[.)][ \t]+(.*)$/
const BULLET = /^ {0,3}[-*+][ \t]+(.*)$/
const BARE_URL = /^https?:\/\/[^\s<>"'`]+/i
const TRAILING = '.,;:!?)]}\'"'

const count = (text: string, char: string) => text.split(char).length - 1

/** 裸地址去掉结尾标点；结尾的 ) 与地址里的 ( 成对时保留。 */
function trimBareUrl(raw: string): string {
  let url = raw
  while (url && TRAILING.includes(url[url.length - 1])) {
    if (url.endsWith(')') && count(url, '(') >= count(url, ')')) break
    url = url.slice(0, -1)
  }
  return url
}

/** 链接地址的结束 )（计入嵌套括号）；没有则 -1。 */
function targetClose(source: string, start: number): number {
  let depth = 0
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1
    else if (source[i] === ')') {
      if (depth === 0) return i
      depth -= 1
    }
  }
  return -1
}

/** 带主机的绝对 http(s) 地址，或带地址的 mailto；其它一律 null。 */
export function safeHref(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (!raw || /[\s"'<>`\\\u0000-\u001f\u007f]/.test(raw)) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (!/^https?:\/\/[^/?#]/i.test(raw) || !url.hostname) return null
    return url.href
  }
  if (url.protocol === 'mailto:') return /^mailto:[^@]+@[^@]+$/i.test(raw) ? `mailto:${raw.slice(7)}` : null
  return null
}

function pushText(out: Inline[], text: string) {
  if (!text) return
  const last = out[out.length - 1]
  if (last && last.kind === 'text') last.text += text
  else out.push({ kind: 'text', text })
}

function link(href: string, children: Inline[]): Inline {
  return { kind: 'link', href, external: !href.startsWith('mailto:'), children }
}

/** 一行的行内 Markdown。inLink：链接文字里不再嵌套链接；rejected 收集被丢掉的链接地址。 */
export function parseInline(source: string, inLink = false, rejected?: string[]): Inline[] {
  const out: Inline[] = []
  let i = 0
  while (i < source.length) {
    const rest = source.slice(i)
    if (rest.startsWith('\\') && /^\\[\\*[\]()_`-]/.test(rest)) {
      pushText(out, rest[1])
      i += 2
      continue
    }
    if (rest.startsWith('**')) {
      const close = source.indexOf('**', i + 2)
      if (close > i + 2) {
        out.push({ kind: 'strong', children: parseInline(source.slice(i + 2, close), inLink, rejected) })
        i = close + 2
        continue
      }
      pushText(out, '**')
      i += 2
      continue
    }
    if (!inLink && rest.startsWith('[')) {
      const labelEnd = source.indexOf(']', i + 1)
      if (labelEnd > i + 1 && source[labelEnd + 1] === '(') {
        const targetEnd = targetClose(source, labelEnd + 2)
        if (targetEnd > labelEnd + 2) {
          const label = parseInline(source.slice(i + 1, labelEnd), true)
          const target = source.slice(labelEnd + 2, targetEnd).trim()
          const href = safeHref(target)
          if (!href) rejected?.push(target)
          if (href) out.push(link(href, label))
          else
            for (const part of label)
              if (part.kind === 'text') pushText(out, part.text)
              else out.push(part)
          i = targetEnd + 1
          continue
        }
      }
    }
    if (!inLink && (rest[0] === 'h' || rest[0] === 'H') && (i === 0 || !/[\p{L}\p{N}]/u.test(source[i - 1]))) {
      const match = BARE_URL.exec(rest)
      if (match) {
        const url = trimBareUrl(match[0])
        const href = safeHref(url)
        if (href) {
          out.push(link(href, [{ kind: 'text', text: url }]))
          i += url.length
          continue
        }
      }
    }
    pushText(out, source[i])
    i += 1
  }
  return out
}

type ListKind = 'ordered' | 'bullet'
type OpenList = { kind: ListKind; start: number; items: Line[][] }

export function parseMarkdown(source: string, rejected?: string[]): Block[] {
  const blocks: Block[] = []
  let paragraph: Line[] | null = null
  let list: OpenList | null = null
  let blankBefore = false
  const closeParagraph = () => {
    if (paragraph) blocks.push({ kind: 'paragraph', lines: paragraph })
    paragraph = null
  }
  const closeList = () => {
    const open = list as OpenList | null
    if (open)
      blocks.push(
        open.kind === 'ordered' ? { kind: 'ordered', start: open.start, items: open.items } : { kind: 'bullet', items: open.items },
      )
    list = null
  }
  for (const rawLine of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.replace(/[ \t]+$/, '')
    if (!line.trim()) {
      closeParagraph()
      blankBefore = true
      continue
    }
    const ordered = ORDERED.exec(line)
    const bullet = ordered ? null : BULLET.exec(line)
    if (ordered || bullet) {
      const kind: ListKind = ordered ? 'ordered' : 'bullet'
      const text = (ordered ? ordered[2] : (bullet as RegExpExecArray)[1]).trim()
      closeParagraph()
      if (list && (list as OpenList).kind !== kind) closeList()
      if (!list) list = { kind, start: ordered ? Number(ordered[1]) : 1, items: [] }
      ;(list as OpenList).items.push([parseInline(text, false, rejected)])
      blankBefore = false
      continue
    }
    const current = list as OpenList | null
    // 列表中：紧跟条目的一行是它的续行（lazy continuation）；空行之后缩进的一行也是。
    if (current && (!blankBefore || /^[ \t]/.test(line))) {
      current.items[current.items.length - 1].push(parseInline(line.trim(), false, rejected))
      blankBefore = false
      continue
    }
    closeList()
    ;(paragraph ??= []).push(parseInline(line.trim(), false, rejected))
    blankBefore = false
  }
  closeParagraph()
  closeList()
  return blocks
}

/** 渲染器会丢掉的 [文字](地址) 的地址；Server 拒绝保存含这些链接的答案，抽屉保存前先在本地拦住。 */
export function unsafeLinks(source: string): string[] {
  const rejected: string[] = []
  parseMarkdown(source, rejected)
  return rejected
}

function plain(parts: Inline[]): string {
  return parts.map((part) => (part.kind === 'text' ? part.text : plain(part.children))).join('')
}

/** Help Centre / FAQ 列表的副标题（§1）：答案第一行纯文字，去掉 Markdown，最多 max 个码点（含省略号）。 */
export function summaryLine(answer: string, max = 100): string {
  const first = parseMarkdown(answer)[0]
  if (!first) return ''
  const line = first.kind === 'paragraph' ? first.lines[0] : first.items[0][0]
  const text = plain(line).replace(/\s+/g, ' ').trim()
  const points = [...text]
  return points.length <= max ? text : `${points.slice(0, max - 1).join('').trimEnd()}…`
}
