import { syntaxTree } from '@codemirror/language'
import type { EditorState, Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { ImageWidget, InlineMathWidget, parseDestination } from './markdownWidgets'
import type { TextFn } from './markdownWidgets'

/**
 * Markdown「Live Preview」行内装饰层（2026-10-29，M2 + M3）。
 *
 * 只负责**行级样式**与**行内**（不跨行、不带 block）replace：
 * Heading / 粗体 / 斜体 / 删除线 / 行内代码 / 无序列表 / 行内公式 `$…$` / 行内图片。
 * 块级公式、GFM 表格、独立成行的图片由 `markdownBlockWidgets`（StateField）负责——
 * CM6 禁止 ViewPlugin 提供 block 装饰与跨行 replace。
 *
 * 关键取舍：
 * 1. 只处理 `view.visibleRanges`，保证大文档性能；
 * 2. 光标/选区与某范围相交时回退显示原始 Markdown（Typora 行为）；
 * 3. 行内公式用自写扫描器（拒绝 `$$`、货币、行内代码/链接/图片内部的 `$`）。
 */

const headingDeco = [1, 2, 3, 4, 5, 6].map((level) => Decoration.line({ class: `cm-md-h${level}` }))
const bulletLine = Decoration.line({ class: 'cm-md-li' })
const orderedLine = Decoration.line({ class: 'cm-md-oli' })
const tableLine = Decoration.line({ class: 'cm-md-table-row' })
const fenceLine = Decoration.line({ class: 'cm-md-fence' })

const strongMark = Decoration.mark({ class: 'cm-md-strong' })
const emMark = Decoration.mark({ class: 'cm-md-em' })
const strikeMark = Decoration.mark({ class: 'cm-md-strike' })
const codeMark = Decoration.mark({ class: 'cm-md-code' })
const hideMark = Decoration.replace({})

/** 含端点相交：行内语法——光标落在标记字符内部时也要回退为源码 */
function selectionTouches(state: EditorState, from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    if (range.from <= to && range.to >= from) return true
  }
  return false
}

/** 严格相交（不含端点）：行首标记隐藏判断用 */
function selectionOverlaps(state: EditorState, from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    if (range.from < to && range.to > from) return true
  }
  return false
}

function lineOccupied(occupied: Array<[number, number]>, lineNumber: number): boolean {
  return occupied.some(([from, to]) => lineNumber >= from && lineNumber <= to)
}

/** 收集可见范围内的代码块区间 */
function collectCodeRanges(view: EditorView): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const tree = syntaxTree(view.state)
  for (const visible of view.visibleRanges) {
    tree.iterate({
      from: visible.from,
      to: visible.to,
      enter: (node) => {
        if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
          ranges.push([node.from, node.to])
          return false
        }
        return undefined
      },
    })
  }
  return ranges
}

function inCodeRange(codeRanges: Array<[number, number]>, pos: number): boolean {
  return codeRanges.some(([from, to]) => pos >= from && pos < to)
}

/** 行级装饰：Heading / 列表 / 围栏（表格与块级 Widget 占用的行交给 StateField） */
function buildLineDecorations(
  view: EditorView,
  out: Range<Decoration>[],
  codeRanges: Array<[number, number]>,
  occupied: Array<[number, number]>,
) {
  const { state } = view
  const doc = state.doc
  const seen = new Set<number>()

  for (const visible of view.visibleRanges) {
    let pos = visible.from
    while (pos <= visible.to) {
      const line = doc.lineAt(pos)
      if (!seen.has(line.from) && !lineOccupied(occupied, line.number)) {
        seen.add(line.from)
        const text = line.text
        if (inCodeRange(codeRanges, line.from)) {
          if (/^\s*```/.test(text)) out.push(fenceLine.range(line.from))
        } else {
          const heading = /^(#{1,6})(\s)/.exec(text)
          const bullet = /^(\s*)([-*+])(\s)/.exec(text)
          const ordered = /^(\s*)(\d+[.)])(\s)/.exec(text)
          if (heading) {
            out.push(headingDeco[heading[1].length - 1].range(line.from))
            const end = line.from + heading[0].length
            if (!selectionOverlaps(state, line.from, end)) out.push(hideMark.range(line.from, end))
          } else if (bullet) {
            out.push(bulletLine.range(line.from))
            const from = line.from + bullet[1].length
            const end = line.from + bullet[0].length
            if (!selectionOverlaps(state, from, end)) out.push(hideMark.range(from, end))
          } else if (ordered) {
            out.push(orderedLine.range(line.from))
          } else if (/^\s*\|/.test(text)) {
            // 表格行（仅在未被块级 Widget 渲染时出现，作为源码态样式）
            out.push(tableLine.range(line.from))
          }
        }
      }
      if (line.to >= visible.to) break
      pos = line.to + 1
    }
  }
}

/** 行内排除区间：行内代码 / 链接 / URL / 图片 / HTML 标签内部的 `$` 不当作公式 */
function collectInlineExclusions(view: EditorView): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const tree = syntaxTree(view.state)
  for (const visible of view.visibleRanges) {
    tree.iterate({
      from: visible.from,
      to: visible.to,
      enter: (node) => {
        if (
          node.name === 'InlineCode' ||
          node.name === 'Link' ||
          node.name === 'Image' ||
          node.name === 'URL' ||
          node.name === 'Autolink' ||
          node.name === 'HTMLTag' ||
          node.name === 'Escape'
        ) {
          ranges.push([node.from, node.to])
          return false
        }
        return undefined
      },
    })
  }
  return ranges
}

interface InlineMathMatch {
  start: number
  end: number
  latex: string
}

/**
 * 行内公式扫描（相对行首偏移）：
 * - `$$` 定界符跳过；`\$` 转义跳过；
 * - 开 `$` 后不能是空白；闭 `$` 前不能是空白、后面不能紧跟数字（排除 `$100-$200`）。
 */
function findInlineMath(text: string): InlineMathMatch[] {
  const matches: InlineMathMatch[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch !== '$') {
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
        if (/\s/.test(text[j - 1])) {
          j++
          continue
        }
        if (/[0-9]/.test(text[j + 1] ?? '')) {
          j++
          continue
        }
        closed = j
        break
      }
      j++
    }
    if (closed < 0) break
    matches.push({ start: i, end: closed + 1, latex: text.slice(i + 1, closed) })
    i = closed + 1
  }
  return matches
}

/** 行内装饰：粗体 / 斜体 / 删除线 / 行内代码 / 行内公式 / 行内图片 */
function buildInlineDecorations(
  view: EditorView,
  out: Range<Decoration>[],
  occupied: Array<[number, number]>,
  codeRanges: Array<[number, number]>,
  getText: () => TextFn,
  getLocale: () => string,
) {
  const { state } = view
  const doc = state.doc
  const tree = syntaxTree(state)
  const text = getText()
  const locale = getLocale()
  const exclusions = collectInlineExclusions(view)
  const overlapsExclusion = (from: number, to: number) =>
    exclusions.some(([a, b]) => from < b && to > a)

  const pushMarks = (name: string, from: number, to: number) => {
    const deco =
      name === 'StrongEmphasis'
        ? strongMark
        : name === 'Emphasis'
          ? emMark
          : name === 'Strikethrough'
            ? strikeMark
            : codeMark
    out.push(deco.range(from, to))
    const markLen = name === 'StrongEmphasis' || name === 'Strikethrough' ? 2 : 1
    if (to - from <= markLen * 2) return
    if (selectionTouches(state, from, to)) return
    out.push(hideMark.range(from, from + markLen))
    out.push(hideMark.range(to - markLen, to))
  }

  const seenMarks = new Set<number>()
  const seenImages = new Set<number>()

  for (const visible of view.visibleRanges) {
    tree.iterate({
      from: visible.from,
      to: visible.to,
      enter: (node) => {
        if (
          node.name === 'StrongEmphasis' ||
          node.name === 'Emphasis' ||
          node.name === 'Strikethrough' ||
          node.name === 'InlineCode'
        ) {
          if (!seenMarks.has(node.from)) {
            seenMarks.add(node.from)
            const line = doc.lineAt(node.from)
            if (!lineOccupied(occupied, line.number) && !inCodeRangeFromTree(state, node.from)) {
              pushMarks(node.name, node.from, node.to)
            }
          }
          return false
        }
        if (node.name === 'Image') {
          if (seenImages.has(node.from)) return false
          seenImages.add(node.from)
          const slice = state.sliceDoc(node.from, node.to)
          const line = doc.lineAt(node.from)
          const singleLine = line.number === doc.lineAt(Math.max(node.from, node.to - 1)).number
          // 整行图片由块级 StateField 处理；这里只做「行内图片」
          if (!singleLine || line.text.trim() === slice.trim()) return false
          if (lineOccupied(occupied, line.number)) return false
          if (selectionTouches(state, node.from, node.to)) return false
          const parsed = /^!\[([^\]]*)\]\(([\s\S]*)\)$/.exec(slice.trim())
          if (!parsed) return false
          const src = parseDestination(parsed[2])
          if (!src) return false
          out.push(
            Decoration.replace({ widget: new ImageWidget(src, parsed[1], false, text, locale) }).range(
              node.from,
              node.to,
            ),
          )
          return false
        }
        return undefined
      },
    })
  }

  // 行内公式：逐可见行扫描（跳过被块级 Widget 占用 / 代码块 / 排除区间）
  for (const visible of view.visibleRanges) {
    let pos = visible.from
    while (pos <= visible.to) {
      const line = doc.lineAt(pos)
      if (
        !lineOccupied(occupied, line.number) &&
        !/^\s*\$\$/.test(line.text) &&
        !inCodeRange(codeRanges, line.from)
      ) {
        for (const match of findInlineMath(line.text)) {
          const from = line.from + match.start
          const to = line.from + match.end
          if (overlapsExclusion(from, to)) continue
          if (selectionTouches(state, from, to)) continue
          out.push(Decoration.replace({ widget: new InlineMathWidget(match.latex) }).range(from, to))
        }
      }
      if (line.to >= visible.to) break
      pos = line.to + 1
    }
  }
}

/** 是否处于代码块内（按语法树判定，供行内层与块级层保持一致） */
function inCodeRangeFromTree(state: EditorState, pos: number): boolean {
  let node = syntaxTree(state).resolveInner(pos, 1)
  while (node) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') return true
    node = node.parent as typeof node
  }
  return false
}

type GetOccupied = (state: EditorState) => Array<[number, number]>

export function createMarkdownLivePreview(
  getOccupiedLineRanges: GetOccupied,
  getText: () => TextFn,
  getLocale: () => string,
) {
  function buildDecorations(view: EditorView): DecorationSet {
    const out: Range<Decoration>[] = []
    const occupied = getOccupiedLineRanges(view.state)
    const codeRanges = collectCodeRanges(view)
    buildLineDecorations(view, out, codeRanges, occupied)
    buildInlineDecorations(view, out, occupied, codeRanges, getText, getLocale)
    return Decoration.set(out, true)
  }

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view)
      }

      update(update: ViewUpdate) {
        const treeChanged = syntaxTree(update.startState) !== syntaxTree(update.state)
        if (update.docChanged || update.selectionSet || update.viewportChanged || treeChanged) {
          this.decorations = buildDecorations(update.view)
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  )
}
