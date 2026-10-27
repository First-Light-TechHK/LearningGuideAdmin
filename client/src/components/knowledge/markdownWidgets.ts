import katex from 'katex'
import { WidgetType } from '@codemirror/view'
import type { EditorView } from '@codemirror/view'

/**
 * Markdown Live Preview 的 Widget（2026-10-29 M3 / 2026-10-27 M4 表格可编辑）。
 *  - 公式 / 图片：只读渲染，光标进入范围回退源码
 *  - GFM 表格：就地可编辑 Widget（预览态 → 点击进入编辑态 → 单元格 contentEditable + 行列增删 → 完成写回 contentMd）
 * 所有 Widget 底层仍是纯 Markdown 文本，contentMd 是唯一真源。
 */

/** KaTeX 渲染结果缓存：同一 latex 不重复渲染（避免大文档滚动时反复计算） */
const mathCache = new Map<string, string>()

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * URL scheme 白名单：仅允许 http/https/mailto 与相对路径；
 * 拦截 javascript:/data:/vbscript: 等可执行 scheme，防止预览态链接 XSS。
 */
function safeUrl(url: string): string {
  try {
    const u = new URL(url, window.location.href)
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') return url
    return ''
  } catch {
    // 解析失败：若含显式 scheme 视为危险，否则当相对路径放行
    return /^[a-z][a-z0-9+.-]*:/i.test(url) ? '' : url
  }
}

export function renderMath(latex: string, displayMode: boolean): string {
  const key = `${displayMode ? 'D' : 'I'}:${latex}`
  const cached = mathCache.get(key)
  if (cached !== undefined) {
    mathCache.delete(key)
    mathCache.set(key, cached)
    return cached
  }
  let html: string
  try {
    html = katex.renderToString(latex, {
      displayMode,
      throwOnError: false,
      strict: false,
      output: 'htmlAndMathml',
    })
  } catch {
    html = `<code>${escapeHtml(latex)}</code>`
  }
  if (mathCache.size > 500) {
    const oldest = mathCache.keys().next().value
    if (oldest !== undefined) mathCache.delete(oldest)
  }
  mathCache.set(key, html)
  return html
}

/** 解析 CommonMark 链接目标：`<url>`、`url "title"`、含平衡括号的 url */
export function parseDestination(raw: string): string {
  let dest = raw.trim()
  const withTitle = /^(\S+)\s+("[^"]*"|'[^']*')$/.exec(dest)
  if (withTitle) dest = withTitle[1]
  if (dest.startsWith('<') && dest.endsWith('>')) dest = dest.slice(1, -1)
  return dest
}

/** 行内公式 `$…$` */
export class InlineMathWidget extends WidgetType {
  readonly latex: string

  constructor(latex: string) {
    super()
    this.latex = latex
  }

  eq(other: InlineMathWidget) {
    return other.latex === this.latex
  }

  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-md-math-inline'
    span.innerHTML = renderMath(this.latex, false)
    return span
  }

  ignoreEvent() {
    return false
  }
}

/** 块级公式 `$$…$$` */
export class BlockMathWidget extends WidgetType {
  readonly latex: string

  constructor(latex: string) {
    super()
    this.latex = latex
  }

  eq(other: BlockMathWidget) {
    return other.latex === this.latex
  }

  toDOM() {
    const div = document.createElement('div')
    div.className = 'cm-md-math-block'
    div.innerHTML = renderMath(this.latex, true)
    return div
  }

  ignoreEvent() {
    return false
  }
}

/** 图片 `![alt](url)` */
export class ImageWidget extends WidgetType {
  readonly src: string
  readonly alt: string
  readonly block: boolean

  constructor(src: string, alt: string, block: boolean) {
    super()
    this.src = src
    this.alt = alt
    this.block = block
  }

  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt && other.block === this.block
  }

  toDOM() {
    const wrap = document.createElement(this.block ? 'div' : 'span')
    wrap.className = this.block ? 'cm-md-image-block' : 'cm-md-image-inline'
    const img = document.createElement('img')
    // 外链图片常有防盗链（按 Referer 拒绝），不带 Referer 请求（BUG-0224）
    img.referrerPolicy = 'no-referrer'
    img.src = this.src
    img.alt = this.alt
    img.loading = 'lazy'
    // 加载失败：不显示浏览器的破图图标，改为明确的失败提示 + 链接，便于作者检查地址
    img.addEventListener('error', () => {
      const failed = document.createElement('span')
      failed.className = 'cm-md-image-failed'
      failed.textContent = `图片加载失败：${this.src}`
      failed.title = this.src
      img.replaceWith(failed)
    })
    wrap.appendChild(img)
    if (this.alt) {
      const caption = document.createElement('span')
      caption.className = 'cm-md-image-alt'
      caption.textContent = this.alt
      wrap.appendChild(caption)
    }
    return wrap
  }

  ignoreEvent() {
    return false
  }
}

// ========================== 表格：解析 / 序列化 / 渲染 ==========================

export type Align = 'left' | 'right' | 'center' | null

export interface ParsedTable {
  header: string[]
  align: Align[]
  rows: string[][]
}

/** 拆一行 GFM 表格：支持可选首尾管道、转义 `\|`（返回未转义的单元格内容） */
function splitRow(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|')) text = text.slice(0, -1)
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\' && text[i + 1] === '|') {
      current += '|'
      i++
      continue
    }
    if (ch === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  cells.push(current.trim())
  return cells
}

/** 把 GFM 表格源码解析为二维结构；分隔行不合法返回 null */
export function parseTable(markdown: string): ParsedTable | null {
  const lines = markdown
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length < 2) return null
  const header = splitRow(lines[0])
  const sep = splitRow(lines[1])
  if (!sep.every((c) => /^:?-+:?$/.test(c))) return null
  const align: Align[] = sep.map((c) => {
    const l = c.startsWith(':')
    const r = c.endsWith(':')
    if (l && r) return 'center'
    if (r) return 'right'
    if (l) return 'left'
    return null
  })
  const n = header.length
  // 补齐 align 到表头列数（分隔行列数不足时兜底）
  while (align.length < n) align.push(null)
  align.length = n
  const norm = (row: string[]) => {
    const out = row.slice(0, n)
    while (out.length < n) out.push('')
    return out
  }
  const rows = lines.slice(2).map(splitRow).map(norm)
  return { header, align, rows }
}

/** 把二维结构序列化为 GFM 表格（单元格内 `|` 转义为 `\|`） */
export function serializeTable(t: ParsedTable): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|')
  const sep = t.align.map((a) => {
    switch (a) {
      case 'center':
        return ':---:'
      case 'right':
        return '---:'
      case 'left':
        return ':---'
      default:
        return '---'
    }
  })
  const lines = [
    '| ' + t.header.map(esc).join(' | ') + ' |',
    '| ' + sep.join(' | ') + ' |',
    ...t.rows.map((r) => '| ' + r.map(esc).join(' | ') + ' |'),
  ]
  return lines.join('\n')
}

// ---------- 单元格内行内 Markdown 渲染（预览态） ----------

function findBracketClose(text: string, start: number): number {
  let depth = 1
  let i = start
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2
      continue
    }
    if (text[i] === '[') depth++
    else if (text[i] === ']') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

/** 渲染单元格内行内 Markdown：行内代码 / 公式 / 图片 / 链接 / 粗体 / 斜体 / 删除线 */
export function renderInline(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    // 行内代码 `...`
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1)
      if (end > i) {
        out += `<code>${escapeHtml(text.slice(i + 1, end))}</code>`
        i = end + 1
        continue
      }
    }
    // 行内公式 $...$
    if (text[i] === '$' && text[i + 1] !== '$') {
      let j = i + 1
      let found = -1
      while (j < n) {
        if (text[j] === '\\') {
          j += 2
          continue
        }
        if (text[j] === '$') {
          if (text[j + 1] === '$') break
          found = j
          break
        }
        j++
      }
      if (found > i) {
        const latex = text.slice(i + 1, found)
        if (latex.trim()) {
          out += renderMath(latex, false)
          i = found + 1
          continue
        }
      }
    }
    // 图片 ![alt](url)
    if (text[i] === '!' && text[i + 1] === '[') {
      const close = findBracketClose(text, i + 2)
      if (close > 0 && text[close + 1] === '(') {
        const pend = text.indexOf(')', close + 2)
        if (pend > close + 1) {
          const alt = text.slice(i + 2, close)
          const url = parseDestination(text.slice(close + 2, pend))
          const src = safeUrl(url)
          if (src) {
            out += `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" referrerpolicy="no-referrer" />`
          } else {
            out += escapeHtml(`![${alt}](${url})`)
          }
          i = pend + 1
          continue
        }
      }
    }
    // 链接 [text](url)
    if (text[i] === '[' && text[i - 1] !== '!') {
      const close = findBracketClose(text, i + 1)
      if (close > 0 && text[close + 1] === '(') {
        const pend = text.indexOf(')', close + 2)
        if (pend > close + 1) {
          const label = text.slice(i + 1, close)
          const url = parseDestination(text.slice(close + 2, pend))
          const href = safeUrl(url)
          out += href
            ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${renderInline(label)}</a>`
            : escapeHtml(`[${label}](${url})`)
          i = pend + 1
          continue
        }
      }
    }
    // 粗体 **...**
    if (text[i] === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2)
      if (end > i + 1) {
        out += `<strong>${renderInline(text.slice(i + 2, end))}</strong>`
        i = end + 2
        continue
      }
    }
    // 斜体 *...*（单个 *，不与 ** 混淆）
    if (text[i] === '*' && text[i + 1] !== '*' && (i === 0 || text[i - 1] !== '*')) {
      let j = i + 1
      let found = -1
      while (j < n) {
        if (text[j] === '\\') {
          j += 2
          continue
        }
        if (text[j] === '*' && text[j + 1] !== '*' && text[j - 1] !== '*') {
          found = j
          break
        }
        j++
      }
      if (found > i) {
        out += `<em>${renderInline(text.slice(i + 1, found))}</em>`
        i = found + 1
        continue
      }
    }
    // 删除线 ~~...~~
    if (text[i] === '~' && text[i + 1] === '~') {
      const end = text.indexOf('~~', i + 2)
      if (end > i + 1) {
        out += `<del>${renderInline(text.slice(i + 2, end))}</del>`
        i = end + 2
        continue
      }
    }
    // 转义 \x
    if (text[i] === '\\' && i + 1 < n) {
      out += escapeHtml(text[i + 1])
      i += 2
      continue
    }
    out += escapeHtml(text[i])
    i++
  }
  return out
}

// ---------- 可编辑表格 Widget ----------

/** 进入/退出表格编辑态的 StateEffect（由 markdownBlockWidgets 提供并处理） */
export interface SetEditingTableEffect {
  from: number
  to: number
}

/**
 * 编辑态跨 Widget 重建的焦点记忆（B4：实时提交会重建 Widget，需记住用户正在编辑的单元格）。
 * 模块级单例：同一时刻只有一张表处于编辑态。
 */
let editingFocusHint: { row: number; col: number } | null = null

export class TableWidget extends WidgetType {
  readonly markdown: string
  readonly from: number
  readonly to: number
  readonly editing: boolean
  readonly readOnly: boolean
  readonly getView: () => EditorView | null
  readonly setEditing: (range: { from: number; to: number } | null) => void
  readonly applyChange: (opts: { from: number; to: number; md: string; keepEditing: boolean }) => void

  constructor(
    markdown: string,
    from: number,
    to: number,
    editing: boolean,
    readOnly: boolean,
    getView: () => EditorView | null,
    setEditing: (range: { from: number; to: number } | null) => void,
    applyChange: (opts: { from: number; to: number; md: string; keepEditing: boolean }) => void,
  ) {
    super()
    this.markdown = markdown
    this.from = from
    this.to = to
    this.editing = editing
    this.readOnly = readOnly
    this.getView = getView
    this.setEditing = setEditing
    this.applyChange = applyChange
  }

  eq(other: TableWidget) {
    // markdown / editing / readOnly 任一变化都重建 DOM
    return (
      other.markdown === this.markdown &&
      other.editing === this.editing &&
      other.readOnly === this.readOnly
    )
  }

  ignoreEvent() {
    // 表格 Widget 自己处理所有交互（点击、键盘、焦点），不让 CM6 抢选区
    return true
  }

  toDOM() {
    const parsed = parseTable(this.markdown)
    const wrap = document.createElement('div')
    wrap.className = 'cm-md-table-widget' + (this.editing ? ' cm-md-table-editing' : '')

    if (!parsed) {
      // 解析失败：退回源码展示（不致崩溃）
      wrap.textContent = this.markdown
      return wrap
    }

    // 可变的表格数据（编辑态下直接修改）
    let table: ParsedTable = {
      header: [...parsed.header],
      align: [...parsed.align],
      rows: parsed.rows.map((r) => [...r]),
    }
    let focused = { row: -1, col: -1 } // row: -1=header, 0..=body; col: 0..
    // 工具条按钮点击期间抑制 focusout 自动提交（B3）
    let suppressCommit = false

    const enterEdit = () => {
      if (this.editing || this.readOnly) return
      this.setEditing({ from: this.from, to: this.to })
    }

    const exitEdit = () => {
      editingFocusHint = null
      this.setEditing(null)
    }

    /** 提交整张表到文档；keepEditing=true 时保留编辑态并锁定新范围（实时输入用） */
    const commit = (keepEditing = false) => {
      if (this.readOnly) return
      const md = serializeTable(table)
      this.applyChange({ from: this.from, to: this.to, md, keepEditing })
      if (!keepEditing) editingFocusHint = null
    }

    // ---- 渲染表格 DOM ----
    const buildTable = (): HTMLTableElement => {
      const tbl = document.createElement('table')
      tbl.className = 'cm-md-table'
      const thead = document.createElement('thead')
      const hrow = document.createElement('tr')
      table.header.forEach((h, ci) => {
        const th = document.createElement('th')
        const a = table.align[ci]
        if (a) th.style.textAlign = a
        th.appendChild(this.editing ? makeCell(h, -1, ci) : makePreviewCell(h, a))
        hrow.appendChild(th)
      })
      thead.appendChild(hrow)
      tbl.appendChild(thead)
      if (table.rows.length) {
        const tbody = document.createElement('tbody')
        table.rows.forEach((row, ri) => {
          const tr = document.createElement('tr')
          row.forEach((cell, ci) => {
            const td = document.createElement('td')
            const a = table.align[ci]
            if (a) td.style.textAlign = a
            td.appendChild(this.editing ? makeCell(cell, ri, ci) : makePreviewCell(cell, a))
            tr.appendChild(td)
          })
          tbody.appendChild(tr)
        })
        tbl.appendChild(tbody)
      }
      return tbl
    }

    const makePreviewCell = (text: string, align: Align): HTMLSpanElement => {
      const span = document.createElement('span')
      span.className = 'cm-md-table-cell-preview'
      if (align) span.style.textAlign = align
      span.innerHTML = renderInline(text)
      return span
    }

    const makeCell = (text: string, row: number, col: number): HTMLDivElement => {
      const div = document.createElement('div')
      div.className = 'cm-md-table-cell-edit'
      div.contentEditable = 'true'
      div.spellcheck = false
      div.textContent = text
      div.addEventListener('focus', () => {
        focused = { row, col }
        editingFocusHint = { row, col }
      })
      // 实时同步 + 提交到文档（B4：外部文档变更/切页时不丢单元格输入）
      div.addEventListener('input', () => {
        const val = div.textContent ?? ''
        if (row < 0) table.header[col] = val
        else table.rows[row][col] = val
        commit(true)
      })
      div.addEventListener('keydown', (e) => onCellKey(e, row, col, div))
      return div
    }

    const onCellKey = (
      e: KeyboardEvent,
      row: number,
      col: number,
      el: HTMLDivElement,
    ) => {
      if (e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        const cells = collectEditCells()
        const idx = cells.indexOf(el)
        if (e.shiftKey) {
          const prev = idx > 0 ? cells[idx - 1] : cells[cells.length - 1]
          prev?.focus()
        } else {
          if (idx === cells.length - 1) {
            addRow()
            // addRow 已 commit(true) 重建 Widget，直接设焦点记忆，新 Widget 的 rAF 会聚焦新行首格
            editingFocusHint = { row: table.rows.length - 1, col: 0 }
          } else {
            cells[idx + 1]?.focus()
          }
        }
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        if (e.shiftKey) return // Shift+Enter：不插入换行（GFM 单元格不支持换行）
        const next = row + 1
        if (row === table.rows.length - 1) {
          addRow()
          // 同上：重建后靠焦点记忆定位
          editingFocusHint = { row: next, col }
        } else {
          const cells = collectEditCells()
          const target = cells[table.header.length + next * table.header.length + col]
          target?.focus()
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        exitEdit()
        return
      }
    }

    const collectEditCells = (): HTMLDivElement[] => {
      return Array.from(wrap.querySelectorAll('.cm-md-table-cell-edit')) as HTMLDivElement[]
    }

    // ---- 行列操作 ----
    const addRow = () => {
      table.rows.push(new Array(table.header.length).fill(''))
      refreshTable()
    }
    const addCol = () => {
      table.header.push('')
      table.align.push(null)
      table.rows.forEach((r) => r.push(''))
      refreshTable()
    }
    const removeRow = () => {
      if (focused.row < 0 || table.rows.length <= 1) return
      table.rows.splice(focused.row, 1)
      focused = { row: -1, col: -1 }
      editingFocusHint = null
      refreshTable()
    }
    const removeCol = () => {
      if (table.header.length <= 1) return
      const ci = focused.col >= 0 ? focused.col : table.header.length - 1
      table.header.splice(ci, 1)
      table.align.splice(ci, 1)
      table.rows.forEach((r) => r.splice(ci, 1))
      focused = { row: -1, col: -1 }
      editingFocusHint = null
      refreshTable()
    }

    const refreshTable = () => {
      const old = wrap.querySelector('table')
      if (old) old.remove()
      wrap.appendChild(buildTable())
      // 行列结构变更后实时写回文档（保持 contentMd 为真源）
      commit(true)
    }

    // ---- 构建界面 ----
    if (this.editing) {
      const bar = document.createElement('div')
      bar.className = 'cm-md-table-toolbar'
      const mkBtn = (label: string, title: string, fn: () => void) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.textContent = label
        b.title = title
        b.className = 'cm-md-table-tbtn'
        // 工具条按钮点击会让单元格失焦 → 触发 focusout 提交；这里抑制一次（B3）
        b.addEventListener('mousedown', (e) => {
          e.preventDefault()
          suppressCommit = true
        })
        b.addEventListener('click', (e) => {
          e.preventDefault()
          fn()
          window.setTimeout(() => {
            suppressCommit = false
          }, 0)
        })
        return b
      }
      bar.appendChild(mkBtn('＋行', '在末尾添加一行', addRow))
      bar.appendChild(mkBtn('＋列', '在末尾添加一列', addCol))
      bar.appendChild(mkBtn('－行', '删除当前行', removeRow))
      bar.appendChild(mkBtn('－列', '删除当前列', removeCol))
      const done = mkBtn('完成', '写回 Markdown 并退出编辑', () => {
        // 先把当前聚焦单元格的 textContent 同步回 table（contentEditable 已改 DOM）
        syncCellsToTable()
        commit()
      })
      done.classList.add('cm-md-table-tbtn-primary')
      bar.appendChild(done)
      wrap.appendChild(bar)
    } else if (!this.readOnly) {
      // 预览态（可编辑）：右上角编辑按钮
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'cm-md-table-edit-btn'
      btn.textContent = '✎ 编辑表格'
      btn.title = '编辑表格'
      btn.addEventListener('mousedown', (e) => e.preventDefault())
      btn.addEventListener('click', (e) => {
        e.preventDefault()
        enterEdit()
      })
      wrap.appendChild(btn)
    }

    const syncCellsToTable = () => {
      const cells = collectEditCells()
      const n = table.header.length
      cells.forEach((c, idx) => {
        const text = c.textContent ?? ''
        if (idx < n) {
          table.header[idx] = text
        } else {
          const ri = Math.floor((idx - n) / n)
          const ci = (idx - n) % n
          table.rows[ri][ci] = text
        }
      })
    }

    wrap.appendChild(buildTable())

    if (!this.editing) {
      if (!this.readOnly) {
        // 预览态（可编辑）：点击表格任意处也进入编辑
        wrap.addEventListener('click', (e) => {
          if ((e.target as HTMLElement).closest('.cm-md-table-edit-btn')) return
          enterEdit()
        })
      }
      // readOnly 预览态：纯展示，不绑定任何编辑入口
    } else {
      // 编辑态：DOM 挂载后聚焦「记忆中的单元格」，否则第一格（toDOM 时节点尚未入文档）
      window.requestAnimationFrame(() => {
        const cells = collectEditCells()
        if (editingFocusHint) {
          const n = table.header.length
          const idx =
            editingFocusHint.row < 0
              ? editingFocusHint.col
              : n + editingFocusHint.row * n + editingFocusHint.col
          const target = cells[Math.min(idx, cells.length - 1)]
          target?.focus()
        } else {
          cells[0]?.focus()
        }
      })
      // 编辑态：点到表格外（focusout 且 relatedTarget 不在 widget 内）→ 提交退出
      wrap.addEventListener('focusout', (e) => {
        const rt = e.relatedTarget as Node | null
        if (rt && wrap.contains(rt)) return
        window.setTimeout(() => {
          if (!wrap.isConnected) return // widget 已被销毁（如已提交重建），不再重复提交
          if (suppressCommit) return // 工具条按钮点击引发的失焦，不提交
          if (document.activeElement && wrap.contains(document.activeElement)) return
          syncCellsToTable()
          commit()
        }, 0)
      })
    }

    return wrap
  }
}
