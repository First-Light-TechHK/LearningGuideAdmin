import { syntaxTree } from '@codemirror/language'
import { EditorState, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { BlockMathWidget, ImageWidget, TableWidget, parseDestination } from './markdownWidgets'

/**
 * 块级 Widget 层（2026-10-29 M3 / 2026-10-27 M4 表格可编辑）。
 *
 * CM6 硬约束：**ViewPlugin 不得提供 block 装饰、也不得提供跨行 replace**
 * （`Block decorations may not be specified via plugins` /
 * `Decorations that replace line breaks may not be specified via plugins`），
 * 因此块级公式、GFM 表格、独立成行的图片必须由 StateField 提供。
 *
 * M4 表格编辑：通过 `setEditingTable` StateEffect 锁定某张表格的范围，
 * 锁定期间「选区接触 → 回退源码」的规则对该表失效，Widget 内部自行管理
 * contentEditable 与行列增删；提交时直接 dispatch 文档变更替换该范围。
 */

export const setEditingTable = StateEffect.define<{ from: number; to: number } | null>()

interface BlockRange {
  from: number
  to: number
  kind: 'math' | 'table' | 'image'
  payload: string
  fromLine: number
  toLine: number
}

interface BlockWidgetState {
  blocks: BlockRange[]
  decorations: DecorationSet
  occupied: Array<[number, number]>
  /** 当前正在编辑的表格范围（锁定中，不回退源码） */
  editing: { from: number; to: number } | null
}

const MAX_BLOCK_MATH_LINES = 500

function touchesSelection(state: EditorState, from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    if (range.from <= to && range.to >= from) return true
  }
  return false
}

function codeRangesOf(state: EditorState): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
        ranges.push([node.from, node.to])
        return false
      }
      return undefined
    },
  })
  return ranges
}

function inRanges(ranges: Array<[number, number]>, pos: number): boolean {
  return ranges.some(([from, to]) => pos >= from && pos < to)
}

function scanBlockMath(state: EditorState, codeRanges: Array<[number, number]>): BlockRange[] {
  const doc = state.doc
  const blocks: BlockRange[] = []
  let i = 1
  while (i <= doc.lines) {
    const line = doc.line(i)
    if (inRanges(codeRanges, line.from)) {
      i++
      continue
    }
    const trimmed = line.text.trim()
    if (!trimmed.startsWith('$$')) {
      i++
      continue
    }
    const single = /^\$\$(.+)\$\$$/.exec(trimmed)
    if (single && single[1].trim()) {
      blocks.push({
        from: line.from,
        to: line.to,
        kind: 'math',
        payload: single[1].trim(),
        fromLine: i,
        toLine: i,
      })
      i++
      continue
    }
    if (trimmed !== '$$') {
      i++
      continue
    }
    let j = i + 1
    let end = -1
    const limit = Math.min(doc.lines, i + MAX_BLOCK_MATH_LINES)
    while (j <= limit) {
      const next = doc.line(j)
      if (inRanges(codeRanges, next.from)) break
      if (next.text.trim() === '$$') {
        end = j
        break
      }
      j++
    }
    if (end < 0) {
      i++
      continue
    }
    const endLine = doc.line(end)
    const markerOffset = line.text.indexOf('$$')
    const latexStart = line.from + (markerOffset >= 0 ? markerOffset : 0) + 2
    const latex = doc.sliceString(latexStart, endLine.from).trim()
    if (!latex) {
      i = end + 1
      continue
    }
    blocks.push({
      from: line.from,
      to: endLine.to,
      kind: 'math',
      payload: latex,
      fromLine: i,
      toLine: end,
    })
    i = end + 1
  }
  return blocks
}

function scanTables(state: EditorState): BlockRange[] {
  const doc = state.doc
  const blocks: BlockRange[] = []
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'Table') return undefined
      const firstLine = doc.lineAt(node.from)
      if (!/^\s*\|/.test(firstLine.text)) return false
      const lastLine = doc.lineAt(Math.max(node.from, node.to - 1))
      blocks.push({
        from: firstLine.from,
        to: lastLine.to,
        kind: 'table',
        payload: doc.sliceString(firstLine.from, lastLine.to),
        fromLine: firstLine.number,
        toLine: lastLine.number,
      })
      return false
    },
  })
  return blocks
}

function scanBlockImages(state: EditorState): BlockRange[] {
  const doc = state.doc
  const blocks: BlockRange[] = []
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'Image') return undefined
      const slice = state.sliceDoc(node.from, node.to)
      const line = doc.lineAt(node.from)
      if (line.number !== doc.lineAt(Math.max(node.from, node.to - 1)).number) return false
      if (line.text.trim() !== slice.trim()) return false
      blocks.push({
        from: line.from,
        to: line.to,
        kind: 'image',
        payload: slice,
        fromLine: line.number,
        toLine: line.number,
      })
      return false
    },
  })
  return blocks
}

function collectBlocks(state: EditorState): BlockRange[] {
  const codeRanges = codeRangesOf(state)
  const all = [...scanBlockMath(state, codeRanges), ...scanTables(state), ...scanBlockImages(state)]
  const sorted = [...all].sort((a, b) => a.from - b.from)
  const kept: BlockRange[] = []
  for (const block of sorted) {
    if (kept.some((k) => block.from < k.to && block.to > k.from)) continue
    kept.push(block)
  }
  return kept
}

function buildRanges(blocks: BlockRange[]) {
  return blocks.map((b) => [b.fromLine, b.toLine] as [number, number])
}

interface BuildDeps {
  getView: () => EditorView | null
}

function decorateActive(
  state: EditorState,
  blocks: BlockRange[],
  editing: { from: number; to: number } | null,
): BlockRange[] {
  return blocks.filter((block) => {
    // 正在编辑的表格：永远渲染（不回退源码）
    if (editing && block.from === editing.from && block.to === editing.to) return true
    return !touchesSelection(state, block.from, block.to)
  })
}

function decorate(
  state: EditorState,
  active: BlockRange[],
  editing: { from: number; to: number } | null,
  deps: BuildDeps,
): { decorations: DecorationSet; rendered: BlockRange[] } {
  const ranges = []
  const rendered: BlockRange[] = []
  const readOnly = state.readOnly
  const setEditing = (range: { from: number; to: number } | null) => {
    const view = deps.getView()
    if (!view) return
    view.dispatch({ effects: setEditingTable.of(range) })
  }
  // 单次 dispatch 同时提交文档变更与编辑锁（避免两次事务间 Widget 闪烁/失焦）
  const applyChange = (opts: { from: number; to: number; md: string; keepEditing: boolean }) => {
    const view = deps.getView()
    if (!view) return
    if (view.state.readOnly) return
    const newTo = opts.from + opts.md.length
    view.dispatch({
      changes: { from: opts.from, to: opts.to, insert: opts.md },
      effects: setEditingTable.of(opts.keepEditing ? { from: opts.from, to: newTo } : null),
      userEvent: 'input.table',
    })
  }
  for (const block of active) {
    if (block.kind === 'math') {
      ranges.push(
        Decoration.replace({ widget: new BlockMathWidget(block.payload), block: true }).range(
          block.from,
          block.to,
        ),
      )
      rendered.push(block)
    } else if (block.kind === 'table') {
      const isEditing = !!editing && editing.from === block.from && editing.to === block.to
      ranges.push(
        Decoration.replace({
          widget: new TableWidget(
            block.payload,
            block.from,
            block.to,
            isEditing,
            readOnly,
            deps.getView,
            setEditing,
            applyChange,
          ),
          block: true,
        }).range(block.from, block.to),
      )
      rendered.push(block)
    } else {
      const parsed = /^!\[([^\]]*)\]\(([\s\S]*)\)$/.exec(block.payload.trim())
      if (!parsed) continue
      const src = parseDestination(parsed[2])
      if (!src) continue
      ranges.push(
        Decoration.replace({
          widget: new ImageWidget(src, parsed[1], true),
          block: true,
        }).range(block.from, block.to),
      )
      rendered.push(block)
    }
  }
  return { decorations: Decoration.set(ranges, true), rendered }
}

export function createMarkdownBlockWidgets(getView: () => EditorView | null) {
  const deps: BuildDeps = { getView }

  function build(state: EditorState, editing: { from: number; to: number } | null): BlockWidgetState {
    const blocks = collectBlocks(state)
    const active = decorateActive(state, blocks, editing)
    const { decorations, rendered } = decorate(state, active, editing, deps)
    return {
      blocks,
      decorations,
      occupied: buildRanges(rendered),
      editing,
    }
  }

  const field = StateField.define<BlockWidgetState>({
    create: (state) => build(state, null),
    update(value, tr) {
      let editing = value.editing
      let editingChanged = false
      for (const e of tr.effects) {
        if (e.is(setEditingTable)) {
          editing = e.value
          editingChanged = true
        }
      }
      const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state)
      if (tr.docChanged) {
        // 外部文档变更（非表格自身提交）时编辑锁失效；
        // 表格自身的 keepEditing 提交会带 setEditingTable effect，此时 editing 已是新范围
        return build(tr.state, editingChanged ? editing : null)
      }
      if (treeChanged) {
        // 语法树推进（初始懒解析）不影响编辑锁
        return build(tr.state, editing)
      }
      if (editingChanged || tr.selection) {
        const active = decorateActive(tr.state, value.blocks, editing)
        const { decorations, rendered } = decorate(tr.state, active, editing, deps)
        return { ...value, decorations, occupied: buildRanges(rendered), editing }
      }
      return value
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
  })

  function getOccupiedLineRanges(state: EditorState): Array<[number, number]> {
    const v = state.field(field, false)
    return v ? v.occupied : []
  }

  return { field, getOccupiedLineRanges }
}
