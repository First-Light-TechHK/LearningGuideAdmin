import { EditorSelection } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'

/**
 * Markdown 编辑命令（2026-10-29 M1/M2 / 2026-10-27 M5 行内格式 toggle / 2026-10-28 M5-bis 选区包含判定）。
 * 全部基于「包裹/剥离选区 / 行前缀切换 / 插入片段」，只改纯文本，不引入富文本模型。
 * 只读（View 角色）时所有命令直接 no-op：CM6 的 `readOnly` 只约束 DOM 输入，
 * 不拦 `dispatch`，因此必须在这里显式判断。
 */

/** 行内标记 → CM6 markdown 语法树节点名（`$` 无节点，走文本扫描） */
const MARKER_NODES: Record<string, string> = {
  '**': 'StrongEmphasis',
  '*': 'Emphasis',
  '~~': 'Strikethrough',
  '`': 'InlineCode',
}

/**
 * 判断 `text` 是否被 `[before, after]` 完整包裹（语法树未覆盖区域的兜底判定）。
 * 额外要求：剥离后的内层文本不以相同标记开头/结尾，避免 `*` 把 `**text**` 半剥离成 `*text*`。
 */
function isWrapped(text: string, before: string, after: string): boolean {
  if (text.length < before.length + after.length) return false
  if (!text.startsWith(before) || !text.endsWith(after)) return false
  const inner = text.slice(before.length, text.length - after.length)
  if (before.length && inner.startsWith(before)) return false
  if (after.length && inner.endsWith(after)) return false
  return true
}

/**
 * 在语法树中查找「包含选区」的目标格式节点（最内层）。
 * 选区非空：选区整体落在节点内容区间内才剥离（`**abc**` 中只选 `b` 算被包含；跨节点选区不命中 → 走包裹）。
 * 选区为空：光标落在内容区间 [innerFrom, innerTo] 内（含边界）即视为包含。
 */
function findContainingNode(
  state: Parameters<typeof syntaxTree>[0],
  from: number,
  to: number,
  nodeName: string,
  beforeLen: number,
  afterLen: number,
): { from: number; to: number } | null {
  let node = syntaxTree(state).resolveInner(from, 1)
  while (node) {
    if (node.name === nodeName) {
      const innerFrom = node.from + beforeLen
      const innerTo = node.to - afterLen
      const contained =
        from === to
          ? from >= innerFrom && from <= innerTo
          : from >= innerFrom && to <= innerTo
      if (contained) return { from: node.from, to: node.to }
    }
    node = node.parent as typeof node
  }
  return null
}

/** 行内公式 `$…$` 的行内扫描（规则与 Live Preview 层一致：跳过 `$$`、`\$`、货币数字） */
function findInlineMathInLine(text: string): Array<{ start: number; end: number }> {
  const matches: Array<{ start: number; end: number }> = []
  let i = 0
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2
      continue
    }
    if (text[i] !== '$') {
      i++
      continue
    }
    if (text[i + 1] === '$') {
      i += 2
      continue
    }
    if (i + 1 >= text.length || /\s/.test(text[i + 1])) {
      i++
      continue
    }
    let j = i + 1
    let closed = -1
    while (j < text.length) {
      if (text[j] === '\\') {
        j += 2
        continue
      }
      if (text[j] === '$') {
        if (text[j + 1] === '$') {
          j += 2
          continue
        }
        if (/\s/.test(text[j - 1]) || /[0-9]/.test(text[j + 1] ?? '')) {
          j++
          continue
        }
        closed = j
        break
      }
      j++
    }
    if (closed < 0) break
    matches.push({ start: i, end: closed + 1 })
    i = closed + 1
  }
  return matches
}

/** 查找包含选区 [from, to] 的行内公式区间（绝对位置） */
function findContainingMath(
  state: { doc: { lineAt: (p: number) => { number: number; from: number; text: string } } },
  from: number,
  to: number,
): { from: number; to: number } | null {
  const line = state.doc.lineAt(from)
  if (state.doc.lineAt(to).number !== line.number) return null // 行内公式不跨行
  const lineFrom = line.from
  for (const m of findInlineMathInLine(line.text)) {
    const absFrom = lineFrom + m.start
    const absTo = lineFrom + m.end
    const innerFrom = absFrom + 1
    const innerTo = absTo - 1
    const contained =
      from === to ? from >= innerFrom && from <= innerTo : from >= innerFrom && to <= innerTo
    if (contained) return { from: absFrom, to: absTo }
  }
  return null
}

/** 把选区位置映射到「剥离首尾标记后」的新位置 */
function mapPosAfterStrip(
  pos: number,
  nodeFrom: number,
  innerFrom: number,
  innerTo: number,
  beforeLen: number,
): number {
  if (pos <= innerFrom) return nodeFrom
  if (pos >= innerTo) return nodeFrom + (innerTo - innerFrom)
  return pos - beforeLen
}

/**
 * 切换行内格式标记（粗体 / 斜体 / 删除线 / 行内代码 / 行内公式）。
 *  - 若选区落在某一同类格式范围内（含只选中部分内容）→ 剥离该格式的首尾标记。
 *  - 否则 → 包裹选区；空选区插入 `before+after` 并把光标放在中间。
 * 判定优先用语法树节点（`**`/`*`/`~~`/`` ` ``）；`$` 用行内扫描；都未命中时退化为选区文本首尾匹配。
 */
export function toggleWrap(view: EditorView, before: string, after: string = before) {
  if (view.state.readOnly) return
  const { state } = view
  const main = state.selection.main
  const beforeLen = before.length
  const afterLen = after.length

  // 1) 先按主选区判定是否要「剥离」（整张表/格式节点只剥一次，避免多选区重复剥离同一节点）
  let strip: { from: number; to: number; innerFrom: number; innerTo: number } | null = null

  const nodeName = MARKER_NODES[before]
  if (nodeName) {
    const n = findContainingNode(state, main.from, main.to, nodeName, beforeLen, afterLen)
    if (n) strip = { from: n.from, to: n.to, innerFrom: n.from + beforeLen, innerTo: n.to - afterLen }
  } else if (before === '$') {
    const n = findContainingMath(state, main.from, main.to)
    if (n) strip = { from: n.from, to: n.to, innerFrom: n.from + 1, innerTo: n.to - 1 }
  }

  // 2) 语法树懒解析未覆盖区域兜底：选区文本本身已被同一对标记包裹
  if (!strip) {
    const text = state.sliceDoc(main.from, main.to)
    if (!main.empty && isWrapped(text, before, after)) {
      strip = {
        from: main.from,
        to: main.to,
        innerFrom: main.from + beforeLen,
        innerTo: main.to - afterLen,
      }
    }
  }

  if (strip) {
    const inner = state.sliceDoc(strip.innerFrom, strip.innerTo)
    const selFrom = mapPosAfterStrip(main.from, strip.from, strip.innerFrom, strip.innerTo, beforeLen)
    const selTo = mapPosAfterStrip(main.to, strip.from, strip.innerFrom, strip.innerTo, beforeLen)
    view.dispatch({
      changes: { from: strip.from, to: strip.to, insert: inner },
      selection: EditorSelection.range(selFrom, selTo),
      scrollIntoView: true,
      userEvent: 'input.unwrap',
    })
    view.focus()
    return
  }

  // 3) 否则包裹每个选区
  const changes = state.changeByRange((range) => {
    if (range.empty) {
      const insert = before + after
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(range.from + beforeLen),
      }
    }
    const text = state.sliceDoc(range.from, range.to)
    const insert = before + text + after
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(range.from + beforeLen, range.from + beforeLen + text.length),
    }
  })
  view.dispatch(changes, { scrollIntoView: true, userEvent: 'input.wrap' })
  view.focus()
}

/** 兼容旧名（部分调用点可能仍引用） */
export const wrapSelection = toggleWrap

/**
 * 切换行前缀（如 `# ` / `- ` / `> `）。
 * 选区中若已有同类前缀 → 全部移除（空行不写入前缀）；否则逐行添加。
 */
export function toggleLinePrefix(view: EditorView, makePrefix: (index: number) => string, match: RegExp) {
  const { state } = view
  if (state.readOnly) return

  // 先收集受影响的行（多选区去重）
  const lines: Array<{ from: number; text: string }> = []
  const seen = new Set<number>()
  for (const range of state.selection.ranges) {
    const startLine = state.doc.lineAt(range.from).number
    const endLine = state.doc.lineAt(range.to).number
    for (let n = startLine; n <= endLine; n++) {
      if (seen.has(n)) continue
      seen.add(n)
      const line = state.doc.line(n)
      lines.push({ from: line.from, text: line.text })
    }
  }
  if (!lines.length) return

  // 已有任何一行命中前缀 → 视为「移除」方向；移除时跳过空行
  const removing = lines.some((l) => l.text.trim() && match.test(l.text))
  const changes: Array<{ from: number; to: number; insert: string }> = []
  let index = 0

  for (const line of lines) {
    const m = match.exec(line.text)
    if (m) {
      const indent = /^\s*/.exec(line.text)?.[0].length ?? 0
      changes.push({ from: line.from + indent, to: line.from + m[0].length, insert: '' })
    } else if (!line.text.trim()) {
      // 空行：仅在「添加」方向补前缀
      if (!removing) changes.push({ from: line.from, to: line.from, insert: makePrefix(index++) })
    } else {
      changes.push({ from: line.from, to: line.from, insert: makePrefix(index++) })
    }
  }

  if (!changes.length) return
  view.dispatch({ changes, userEvent: 'input.togglePrefix' })
  view.focus()
}

/** 切换标题级别（1-6；0 表示恢复普通段落） */
export function setHeading(view: EditorView, level: number) {
  const { state } = view
  if (state.readOnly) return
  const changes: Array<{ from: number; to: number; insert: string }> = []
  const seen = new Set<number>()
  for (const range of state.selection.ranges) {
    const startLine = state.doc.lineAt(range.from).number
    const endLine = state.doc.lineAt(range.to).number
    for (let n = startLine; n <= endLine; n++) {
      if (seen.has(n)) continue
      seen.add(n)
      const line = state.doc.line(n)
      const existing = /^(#{1,6})(\s+)/.exec(line.text)
      if (level === 0) {
        if (existing) changes.push({ from: line.from, to: line.from + existing[0].length, insert: '' })
      } else if (existing) {
        if (existing[1].length !== level) {
          changes.push({ from: line.from, to: line.from + existing[1].length, insert: '#'.repeat(level) })
        }
      } else {
        changes.push({ from: line.from, to: line.from, insert: `${'#'.repeat(level)} ` })
      }
    }
  }
  if (!changes.length) return
  view.dispatch({ changes, userEvent: 'input.heading' })
  view.focus()
}

interface InsertSnippetOptions {
  /** 插入后要选中的片段内相对区间（相对 snippet 起点，不含自动补的换行） */
  select?: { from: number; to?: number }
  /** 块级片段（表格/公式块/代码块/图片/分割线）：自动断行，避免与相邻文本黏连 */
  block?: boolean
}

/**
 * 在光标处插入片段。
 * - 块级片段：光标在行中时前面补空行；行首且上一行非空时补一个换行（否则 `---` 会把上一段变成
 *   Setext 标题、表格会与上一段黏连）；插入点之后若还有同行内容，末尾补换行避免结构被吞。
 */
export function insertSnippet(view: EditorView, snippet: string, options: InsertSnippetOptions = {}) {
  const { state } = view
  if (state.readOnly) return
  const range = state.selection.main
  const line = state.doc.lineAt(range.from)
  const endLine = state.doc.lineAt(range.to)

  let prefix = ''
  let suffix = ''
  if (options.block) {
    if (range.from > line.from) {
      prefix = '\n\n'
    } else {
      const prev = line.number > 1 ? state.doc.line(line.number - 1) : null
      if (prev && prev.text.trim()) prefix = '\n'
    }
    if (endLine.to > range.to) suffix = '\n'
  }

  const insert = prefix + snippet + suffix
  const base = range.from + prefix.length
  const selection = options.select
    ? EditorSelection.range(base + options.select.from, base + (options.select.to ?? options.select.from))
    : EditorSelection.cursor(base + snippet.length)

  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection,
    scrollIntoView: true,
    userEvent: 'input.snippet',
  })
  view.focus()
}
