import { useEffect, useRef, useState } from 'react'
import { Alert, App, Button, Dropdown, Empty, Input, Panel, Tag } from '../ui'
import type { MenuProps } from '../ui'
import {
  BlockNoteView,
} from '@blocknote/mantine'
import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  defaultStyleSpecs,
} from '@blocknote/core'
import { en } from '@blocknote/core/locales'
import {
  useCreateBlockNote,
} from '@blocknote/react'
import {
  createReactMathBlockSpec,
  createReactInlineMathSpec,
} from '@blocknote/math-block'
import '@blocknote/react/style.css'
import '@blocknote/mantine/style.css'
import {
  AlignLeftOutlined,
  EditOutlined,
  FontSizeOutlined,
  UnorderedListOutlined,
  OrderedListOutlined,
  TableOutlined,
  CodeOutlined,
  MessageOutlined,
  FunctionOutlined,
  PictureOutlined,
} from '@ant-design/icons'
import { useKnowledgeStore } from '../../stores/knowledgeStore'
import { TagManager } from './TagManager'
import { useWorkspaceAccess } from '../../backoffice/lib/workspaceAccess'
import { tokens } from '../../theme/tokens'

/**
 * Page 编辑器（§3.3.2，2026-10-15 改：BlockNote 块编辑器）
 * - BlockNote（Notion/Jupyter 式）：数学块、拖拽重排、选中浮窗、右键插入菜单
 * - 存储仍为 contentMd（blocksToMarkdownLossy）
 * - 编辑后防抖保存到 store.editDraft → PUT /api/pages/:id
 * - 2026-10-15 用户反馈修正：移除 / 命令（白屏）、移除源码模式切换、
 *   修复拖拽手柄可见性、右键菜单加图标
 */

/** 自定义 schema：默认块/行内/样式 + 数学块 + 行内公式 */
const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    mathBlock: createReactMathBlockSpec(),
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    math: createReactInlineMathSpec(),
  },
  styleSpecs: defaultStyleSpecs,
})

const SAVE_LABEL: Record<string, { text: string; color: string }> = {
  idle: { text: '', color: '' },
  dirty: { text: '未保存…', color: 'orange' },
  saving: { text: '保存中…', color: 'blue' },
  saved: { text: '已保存', color: 'green' },
  error: { text: '保存失败', color: 'red' },
}

/** heading 文本转 slug（与后端 sync.service.ts 一致） */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    // 保留 Unicode 字母/数字（含中文），仅去掉标点符号等特殊字符；
    // 之前用 \w 会把中文全部清空，导致多个中文 heading 生成相同 key（h2-）而碰撞。
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}

/** 带层级前缀的 heading key：`h{n}-{slug}`（与后端一致，2026-10-16） */
function headingKey(level: number, text: string): string {
  return `h${level}-${slugify(text)}`
}

/**
 * 把段落/列表项 content 中的 `$...$` 文本拆分为 math 行内内容项。
 * 先处理 `$$...$$`（块公式），再处理 `$...$`（行内公式），避免顺序冲突。
 * 跳过代码块内容（代码块不解析公式）。
 */
function processInlineMath(content: any[]): any[] {
  if (!Array.isArray(content)) return content
  const result: any[] = []
  for (const item of content) {
    if (item.type !== 'text' || typeof item.text !== 'string') {
      result.push(item)
      continue
    }
    const regex = /\$([^$\n]+?)\$/g
    let lastIndex = 0
    let m: RegExpExecArray | null
    let hasMatch = false
    while ((m = regex.exec(item.text)) !== null) {
      hasMatch = true
      if (m.index > lastIndex) {
        result.push({ ...item, text: item.text.slice(lastIndex, m.index) })
      }
      result.push({ type: 'math', content: m[1].trim() })
      lastIndex = m.index + m[0].length
    }
    if (hasMatch) {
      if (lastIndex < item.text.length) {
        result.push({ ...item, text: item.text.slice(lastIndex) })
      }
    } else {
      result.push(item) // 无匹配，原样保留一次
    }
  }
  return result
}

/**
 * 处理表格单元格中的行内 $...$：遍历 rows[].cells[]，
 * 每个 cell 是 InlineContent[]，调用 processInlineMath。
 */
function processTableInlineMath(tableContent: any): any {
  if (!tableContent || !Array.isArray(tableContent.rows)) return tableContent
  return {
    ...tableContent,
    rows: tableContent.rows.map((row: any) => ({
      ...row,
      cells: row.cells.map((cell: any) => {
        // cell 可能是 string 或 InlineContent[]
        if (typeof cell === 'string') {
          return processInlineMath([{ type: 'text', text: cell, styles: {} }])
        }
        if (Array.isArray(cell)) return processInlineMath(cell)
        // TableCell 对象形式 { type, props, content }
        if (cell && Array.isArray(cell.content)) {
          return { ...cell, content: processInlineMath(cell.content) }
        }
        return cell
      }),
    })),
  }
}

/**
 * 后处理：
 * 1. 把 `$$...$$` 段落块转换为 mathBlock
 * 2. 把段落/列表项 content 中的 `$...$` 文本转为 math 行内内容项
 * 3. 表格单元格中的 `$...$` 同样处理
 * 原因：@blocknote/math-block 只提供 HTML/MathML 解析，不提供 markdown 解析。
 */
function convertMathParagraphs(blocks: any[]): any[] {
  return blocks.map((block) => {
    // 1. 整段 $$...$$ → mathBlock
    if (block.type === 'paragraph') {
      const text = (block.content || [])
        .map((c: any) => c.text || '')
        .join('')
      const match = text.match(/^\$\$\s*([\s\S]*?)\s*\$\$$/)
      if (match) {
        const latex = match[1].replace(/\\\s*\n/g, '\n').replace(/\n\\/g, '\n').trim()
        return {
          type: 'mathBlock',
          content: latex ? [{ type: 'text', text: latex, styles: {} }] : [],
        }
      }
    }
    // 2. 行内 $...$（段落、列表项等含 content 数组的块）
    if (Array.isArray(block.content)) {
      block = { ...block, content: processInlineMath(block.content) }
    }
    // 3. 表格单元格中的行内 $...$
    if (block.type === 'table' && block.content) {
      block = { ...block, content: processTableInlineMath(block.content) }
    }
    // 4. 递归处理嵌套 children（列表项的子块）
    if (Array.isArray(block.children) && block.children.length) {
      block = { ...block, children: convertMathParagraphs(block.children) }
    }
    return block
  })
}

/**
 * 判断文本是否像 LaTeX（用于粘贴时决定是否走公式解析）。
 * 触发条件（任一）：
 *  1. 含块级公式 `$$...$$`
 *  2. 含常见 LaTeX 命令（\frac、\sum、\begin 等）
 *  3. 含行内 `$...$` 且**内部**含已知 LaTeX 命令
 * 普通代码（如 $PATH、$var、模板字符串 `$100$` 配 `\d`）不会误判。
 */
function looksLikeLatex(text: string): boolean {
  if (!text) return false
  // 1. 块级公式
  if (/\$\$[\s\S]+?\$\$/.test(text)) return true
  // 2. 常见 LaTeX 命令
  if (
    /\\(begin|end|frac|sum|int|prod|lim|sqrt|left|right|alpha|beta|gamma|delta|epsilon|varepsilon|theta|lambda|mu|sigma|pi|infty|cdot|times|div|leq|geq|neq|approx|rightarrow|partial|nabla|mathrm|mathbf|text|over|under|overline|underline)/.test(
      text,
    )
  )
    return true
  // 3. 行内公式且内部含 LaTeX 命令（避免 \n \d 等普通转义误判）
  if (/\$[^$\n]*\\(begin|end|frac|sum|int|prod|lim|sqrt|left|right|alpha|beta|gamma|delta|epsilon|theta|lambda|mu|sigma|pi|infty|cdot|times|leq|geq|neq|approx)[^$\n]*\$/.test(text))
    return true
  return false
}

/**
 * 从粘贴的 HTML 中提取所有 <pre>/<code> 的纯文本（用 DOMParser 正确处理实体）。
 * 返回 null 表示 HTML 不含代码块。
 */
function extractCodeFromHtml(html: string): string | null {
  if (!html) return null
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const pres = Array.from(doc.querySelectorAll('pre'))
    if (pres.length > 0) {
      // 拼接所有 pre 的文本，用换行分隔
      return pres
        .map((p) => (p.querySelector('code') ?? p).textContent ?? '')
        .join('\n')
    }
    // 无 pre 时取首个 code
    const code = doc.querySelector('code')
    return code ? code.textContent : null
  } catch {
    return null
  }
}

/**
 * 把表格单元格中的 math 行内内容项转回 `$latex$` 文本。
 */
function tableInlineMathToText(tableContent: any): any {
  if (!tableContent || !Array.isArray(tableContent.rows)) return tableContent
  return {
    ...tableContent,
    rows: tableContent.rows.map((row: any) => ({
      ...row,
      cells: row.cells.map((cell: any) => {
        if (Array.isArray(cell)) {
          return cell.map((c: any) =>
            c.type === 'math'
              ? { type: 'text', text: `$${c.content}$`, styles: {} }
              : c,
          )
        }
        if (cell && Array.isArray(cell.content)) {
          return {
            ...cell,
            content: cell.content.map((c: any) =>
              c.type === 'math'
                ? { type: 'text', text: `$${c.content}$`, styles: {} }
                : c,
            ),
          }
        }
        return cell
      }),
    })),
  }
}

/**
 * 把块中的 math 行内内容项转回 `$latex$` 文本（供内置序列化器输出）。
 * 递归处理 children 和表格单元格。
 */
function inlineMathToText(blocks: any[]): any[] {
  return blocks.map((block) => {
    const b = { ...block }
    if (Array.isArray(b.content)) {
      b.content = b.content.map((c: any) =>
        c.type === 'math'
          ? { type: 'text', text: `$${c.content}$`, styles: {} }
          : c,
      )
    }
    if (b.type === 'table' && b.content) {
      b.content = tableInlineMathToText(b.content)
    }
    if (Array.isArray(b.children) && b.children.length) {
      b.children = inlineMathToText(b.children)
    }
    return b
  })
}

/**
 * 自定义序列化：mathBlock → `$$...$$`，行内 math → `$...$`，其余内置。
 * 按 mathBlock 分段，保证非 math 连续段（含嵌套列表）序列化正确。
 */
function blocksToMarkdownWithMath(editor: any, blocks: any[]): string {
  const parts: string[] = []
  let buffer: any[] = []
  for (const block of blocks) {
    if (block.type === 'mathBlock') {
      if (buffer.length) {
        parts.push(editor.blocksToMarkdownLossy(inlineMathToText(buffer)))
        buffer = []
      }
      const latex = (block.content || [])
        .map((c: any) => c.text || '')
        .join('')
      parts.push(`$$\n${latex}\n$$`)
    } else {
      buffer.push(block)
    }
  }
  if (buffer.length) parts.push(editor.blocksToMarkdownLossy(inlineMathToText(buffer)))
  return parts.join('\n\n')
}

export function PageEditor() {
  const draft = useKnowledgeStore((s) => s.draft)
  const editDraft = useKnowledgeStore((s) => s.editDraft)
  const tocScrollTarget = useKnowledgeStore((s) => s.tocScrollTarget)
  const clearTocScrollTarget = useKnowledgeStore((s) => s.clearTocScrollTarget)
  const { message } = App.useApp()
  /** PRD §3.2/§3.3：View 角色只读，Edit/Full 才可改既有内容 */
  const access = useWorkspaceAccess()

  /** 最后一次加载进块编辑器的 md（用于判断是否需重载） */
  const lastLoadedMd = useRef<string>('')
  /** 加载期间屏蔽 onChange（避免 replaceBlocks 触发无意义保存） */
  const loadingRef = useRef(false)
  /** 编辑器滚动容器（TOC 定位用） */
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 浮动覆盖层容器（scrollRef 的子节点，BlockNote 编辑器的兄弟节点） */
  const overlayRef = useRef<HTMLDivElement>(null)
  /** tag 项 DOM 元素引用（key -> element），用于滚动时直接更新位置（不走 React 重渲染） */
  const tagItemRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  /** 每个 heading 的 key 列表（仅用于 React 渲染 tag 项；位置由 DOM 直接更新） */
  const [headingKeys, setHeadingKeys] = useState<string[]>([])
  /** 标题编辑态（§3.3.1，2026-10-19）：默认展示态（大标题 + 常显铅笔），点击铅笔进入编辑态 */
  const [editingTitle, setEditingTitle] = useState(false)
  /** 进入编辑态时的标题备份，Esc 取消时回滚 */
  const titleBeforeEdit = useRef('')

  const editor = useCreateBlockNote({
    schema,
    // / 命令已关闭，覆盖默认占位符（BlockNote 0.56 用 dictionary 而非废弃的 placeholders）
    dictionary: {
      ...en,
      placeholders: {
        ...en.placeholders,
        default: 'Enter text to start',
      },
    },
    // 图片仅支持外链 URL
    uploadFile: async () => {
      const url = window.prompt('请输入图片 URL（仅支持外链）')
      return { url: url || '' }
    },
    /**
     * 粘贴处理（2026-10-19）：拦截 LaTeX 粘贴，避免被 BlockNote 默认转为 code block。
     * 必须用 pasteHandler（而非 React onPaste），因为 BlockNote 内部已在 view.dom
     * 注册原生 paste 监听并 preventDefault，React onPaste 会在其后触发导致重复插入。
     * 逻辑：
     *  1. 优先看 text/plain，若像 LaTeX 则解析插入并 return true
     *  2. 否则看 text/html 的 <pre>/<code> 内容，若像 LaTeX 则用该文本
     *  3. 其余情况 return defaultPasteHandler()（普通文本/代码/富文本走默认）
     * 解析复用 editor.tryParseMarkdownToBlocks + convertMathParagraphs，
     * `$$...$$` → mathBlock，`$...$` → 行内公式。
     */
    pasteHandler: ({ event, defaultPasteHandler }) => {
      const plain = event.clipboardData?.getData('text/plain')
      if (!plain) return defaultPasteHandler()
      const html = event.clipboardData?.getData('text/html') || ''

      let textToParse: string | null = null
      // 1. 纯文本本身像 LaTeX（VSCode 复制源码场景）
      if (looksLikeLatex(plain)) {
        textToParse = plain
      } else if (html) {
        // 2. HTML 代码块里的内容像 LaTeX（网页代码块场景）
        const codeText = extractCodeFromHtml(html)
        if (codeText && looksLikeLatex(codeText)) {
          textToParse = codeText
        }
      }
      if (!textToParse) return defaultPasteHandler() // 非 LaTeX，走默认

      try {
        const raw = editor.tryParseMarkdownToBlocks(textToParse)
        const blocks = convertMathParagraphs(raw)
        if (blocks.length === 0) return defaultPasteHandler() // 空内容回退默认

        const pos = editor.getTextCursorPosition()
        const currentBlock = pos?.block
        let inserted: any[] = []
        if (currentBlock) {
          // 当前是空段落 → 替换；否则插在当前块之后
          const content = currentBlock.content as any[] | undefined
          const isEmptyParagraph =
            currentBlock.type === 'paragraph' &&
            (!content ||
              content.length === 0 ||
              (content.length === 1 && !content[0].text))
          if (isEmptyParagraph) {
            inserted = editor.replaceBlocks([currentBlock], blocks as never)
              .insertedBlocks
          } else {
            inserted = editor.insertBlocks(blocks as never, currentBlock, 'after')
          }
        } else {
          // 无光标块（空文档），追加到末尾
          const doc = editor.document
          const ref = doc[doc.length - 1]
          if (ref) {
            inserted = editor.insertBlocks(blocks as never, ref, 'after')
          }
        }
        // 用插入返回的带 id 块定位光标（convertMathParagraphs 产出的块无 id）
        const last = inserted[inserted.length - 1]
        if (last) editor.setTextCursorPosition(last as never, 'end')
        editor.focus()
        return true
      } catch {
        message.warning('粘贴内容解析失败，请重试')
        return true
      }
    },
  })

  /** 保存：blocks → md（mathBlock 自定义序列化，其余内置；防抖交给 store） */
  const onContentChange = () => {
    if (loadingRef.current) return
    try {
      const md = blocksToMarkdownWithMath(editor, editor.document)
      lastLoadedMd.current = md
      if (md !== draft?.contentMd) {
        editDraft({ contentMd: md })
      }
    } catch {
      // 序列化失败不打扰用户，下次变更重试
    }
  }

  // 切换页面：contentMd 与已加载不一致时重新加载 blocks
  useEffect(() => {
    if (!draft) return
    if (lastLoadedMd.current === draft.contentMd) return
    loadingRef.current = true
    try {
      const raw = editor.tryParseMarkdownToBlocks(draft.contentMd)
      // 后处理：把 $$...$$ 段落转为 mathBlock（math-block 包不提供 md 解析）
      const blocks = convertMathParagraphs(raw)
      if (blocks.length === 0 && draft.contentMd.trim()) {
        throw new Error('empty')
      }
      editor.replaceBlocks(editor.document, blocks)
      lastLoadedMd.current = draft.contentMd
    } catch {
      message.warning('该页面 Markdown 结构解析异常，部分内容可能未正确显示')
    } finally {
      requestAnimationFrame(() => {
        loadingRef.current = false
      })
    }
  }, [draft, editor, message])

  /** TOC 滚动定位：点击树中 heading 后，滚动编辑器到对应标题块 */
  useEffect(() => {
    if (!tocScrollTarget || !scrollRef.current) return
    const target = tocScrollTarget.trim()
    const hEls = scrollRef.current.querySelectorAll('h1,h2,h3,h4,h5,h6')
    for (const h of Array.from(hEls)) {
      if (h.textContent?.trim() === target) {
        h.scrollIntoView({ behavior: 'smooth', block: 'start' })
        break
      }
    }
    clearTocScrollTarget()
  }, [tocScrollTarget, clearTocScrollTarget])

  /** H1-H6 section tags：浮动覆盖层方案。
   *  绝不修改 BlockNote 的 DOM，只在 overlay（编辑器的兄弟节点）里渲染 tag 按钮。
   *  关键：overlay 用 position:absolute; top:0; left:0; right:0（无 bottom），
   *  这样 overlay 随内容一起滚动，tag 按钮天然跟随 heading，
   *  不需要 scroll 事件更新位置 → 彻底消除滚动偏移。
   *  React 只在 heading 数量/key 变化时重渲染（新增/删除标题块）。 */
  useEffect(() => {
    if (!draft || !scrollRef.current) return

    /** 计算并写入所有 tag 项的位置（相对于 scrollRef 内容顶部） */
    const updateTagPositions = () => {
      const root = scrollRef.current
      if (!root) return
      const rootRect = root.getBoundingClientRect()
      const headings = root.querySelectorAll('h1,h2,h3,h4,h5,h6')
      for (const h of Array.from(headings)) {
        const text = h.textContent?.trim()
        if (!text) continue
        const level = Number(h.tagName.substring(1))
        const key = headingKey(level, text)
        const el = tagItemRefs.current.get(key)
        if (!el) continue
        const hr = h.getBoundingClientRect()
        // overlay 随内容滚动，所以 top/left 取 heading 相对内容顶部的偏移
        el.style.top = `${hr.top - rootRect.top + root.scrollTop}px`
        el.style.left = `${hr.right - rootRect.left + root.scrollLeft + 8}px`
      }
    }

    /** 更新 heading key 列表（React 渲染 tag 项用）+ 位置 */
    const syncHeadings = () => {
      const root = scrollRef.current
      if (!root) return
      const headings = root.querySelectorAll('h1,h2,h3,h4,h5,h6')
      const keys: string[] = []
      for (const h of Array.from(headings)) {
        const text = h.textContent?.trim()
        if (!text) continue
        const level = Number(h.tagName.substring(1))
        keys.push(headingKey(level, text))
      }
      setHeadingKeys((prev) => {
        if (prev.length === keys.length && prev.every((k, i) => k === keys[i])) return prev
        return keys
      })
      updateTagPositions()
    }

    // 初始 + BlockNote 渲染后
    const raf = requestAnimationFrame(syncHeadings)

    // 只读 MutationObserver：BlockNote 内容变化时同步 heading 列表。
    // 忽略 overlay 内部的变化。
    const observer = new MutationObserver((mutations) => {
      const overlay = overlayRef.current
      for (const m of mutations) {
        if (overlay && (overlay === m.target || overlay.contains(m.target))) continue
        syncHeadings()
        break
      }
    })
    observer.observe(scrollRef.current, { childList: true, subtree: true, characterData: true })

    // 窗口缩放时重算位置（布局可能变化）
    window.addEventListener('resize', updateTagPositions)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      window.removeEventListener('resize', updateTagPositions)
    }
  }, [draft, draft?.pageId, draft?.contentMd, draft?.sectionTags])

  /** headingKeys 变化后（tag 元素刚挂载），更新一次位置 */
  useEffect(() => {
    if (!draft) return
    const raf = requestAnimationFrame(() => {
      const root = scrollRef.current
      const overlay = overlayRef.current
      if (!root || !overlay) return
      const rootRect = root.getBoundingClientRect()
      const headings = root.querySelectorAll('h1,h2,h3,h4,h5,h6')
      for (const h of Array.from(headings)) {
        const text = h.textContent?.trim()
        if (!text) continue
        const level = Number(h.tagName.substring(1))
        const key = headingKey(level, text)
        const el = tagItemRefs.current.get(key)
        if (!el) continue
        const hr = h.getBoundingClientRect()
        el.style.top = `${hr.top - rootRect.top + root.scrollTop}px`
        el.style.left = `${hr.right - rootRect.left + root.scrollLeft + 8}px`
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [draft, headingKeys])

  if (!draft) {
    // 空状态同样套内容面板（2026-10-19 修正）：确保未选中页面时内容区仍显示白色圆角面板，三区外观统一
    return (
      <Panel
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <Empty description="从左侧目录树选择一个页面开始编辑" />
      </Panel>
    )
  }

  const save = SAVE_LABEL[draft.saveState]

  /** 右键插入菜单：在光标所在块下方插入指定类型块 */
  const insertBlockAfterCursor = (
    type: string,
    props: Record<string, unknown> = {},
  ) => {
    const pos = editor.getTextCursorPosition()
    if (!pos?.block) return
    const newBlock: Record<string, unknown> = { type }
    // table 块需要 content: TableContent 结构（2 行 3 列空表格）
    if (type === 'table') {
      newBlock.content = {
        type: 'tableContent',
        rows: [
          { cells: ['', '', ''] },
          { cells: ['', '', ''] },
        ],
      }
    } else {
      newBlock.props = props
    }
    const inserted = editor.insertBlocks(
      [newBlock as never],
      pos.block,
      'after',
    )
    // 插入后把光标移到新块（表格→首个单元格；其余→末尾）
    if (inserted[0]) editor.setTextCursorPosition(inserted[0], 'end')
    editor.focus()
  }

  const contextMenu: MenuProps['items'] = [
    { key: 'paragraph', label: '段落', icon: <AlignLeftOutlined /> },
    {
      key: 'heading',
      label: '标题',
      icon: <FontSizeOutlined />,
      children: [
        { key: 'heading1', label: '一级标题' },
        { key: 'heading2', label: '二级标题' },
        { key: 'heading3', label: '三级标题' },
        { key: 'heading4', label: '四级标题' },
        { key: 'heading5', label: '五级标题' },
        { key: 'heading6', label: '六级标题' },
      ],
    },
    { key: 'bulletListItem', label: '无序列表', icon: <UnorderedListOutlined /> },
    { key: 'numberedListItem', label: '有序列表', icon: <OrderedListOutlined /> },
    { key: 'table', label: '表格', icon: <TableOutlined /> },
    { key: 'codeBlock', label: '代码块', icon: <CodeOutlined /> },
    { key: 'quote', label: '引用', icon: <MessageOutlined /> },
    { key: 'mathBlock', label: '数学公式块', icon: <FunctionOutlined /> },
    { type: 'divider' },
    { key: 'image', label: '图片（外链 URL）', icon: <PictureOutlined /> },
  ]

  const onContextMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'image') {
      const url = window.prompt('请输入图片 URL（仅支持外链）')
      if (url) insertBlockAfterCursor('image', { url })
      return
    }
    const headingMatch = key.match(/^heading([1-6])$/)
    if (headingMatch) {
      insertBlockAfterCursor('heading', { level: Number(headingMatch[1]) })
      return
    }
    insertBlockAfterCursor(key)
  }

  return (
    // 内容面板（2026-10-19 对齐 Figma）：白色/圆角12/无边框/卡片阴影，与 AI Tutor、Releases 统一
    <Panel style={{ display: 'flex', flexDirection: 'column' }}>
      {/* 标题区（§3.3.1，2026-10-19 改）：默认展示态（大标题 + 常显铅笔按钮），点击铅笔就地变输入框 */}
      <div
        style={{
          display: 'flex',
          gap: tokens.spacing.sm,
          alignItems: 'center',
          marginBottom: tokens.spacing.sm,
          paddingBottom: tokens.spacing.sm,
          borderBottom: `1px solid ${tokens.color.border}`,
        }}
      >
        {editingTitle && access.canEdit ? (
          <Input
            autoFocus
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 30,
              fontWeight: tokens.fontWeight.bold,
              lineHeight: '36px',
              // Figma 1.1 Page Editor：标题纯黑 #000000
              color: '#000000',
            }}
            value={draft.title}
            onChange={(e) => editDraft({ title: e.target.value })}
            onPressEnter={() => setEditingTitle(false)}
            onBlur={() => setEditingTitle(false)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                // Esc 取消：回滚到进入编辑前的标题
                editDraft({ title: titleBeforeEdit.current })
                setEditingTitle(false)
              }
            }}
            // 空标题文案与展示态回退（下方 draft.title 为空时）保持统一
            placeholder="未命名页面"
          />
        ) : (
          <>
            <div
              style={{
                minWidth: 0,
                fontSize: 30,
                fontWeight: tokens.fontWeight.bold,
                lineHeight: '36px',
                // Figma 1.1 Page Editor：标题纯黑 #000000
                color: '#000000',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {draft.title || '未命名页面'}
            </div>
            {access.canEdit && (
              <Button
                type="text"
                aria-label="编辑标题"
                title="编辑标题"
                icon={<EditOutlined style={{ fontSize: 16 }} />}
                onClick={() => {
                  titleBeforeEdit.current = draft.title
                  setEditingTitle(true)
                }}
                // 对齐 Figma：20×20 容器包 16×16 铅笔图标
                style={{
                  width: 20,
                  height: 20,
                  minWidth: 20,
                  padding: 0,
                  color: tokens.color.text.tertiary,
                }}
              />
            )}
          </>
        )}
        {save.text && (
          <Tag color={save.color} style={{ marginLeft: 'auto' }}>
            {save.text}
          </Tag>
        )}
      </div>
      {draft.saveState === 'error' && (
        <Alert
          type="error"
          showIcon
          message="自动保存失败，请检查后端服务后重试（修改仍保留在本地）"
          style={{ marginBottom: tokens.spacing.sm }}
        />
      )}
      <div
        ref={scrollRef}
        data-color-mode="light"
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.md,
          position: 'relative',
          // 左侧留出 sideMenu（拖拽手柄+添加按钮）空间，防止被裁剪
          paddingLeft: tokens.spacing['2xl'],
        }}
      >
        <Dropdown
          menu={{ items: access.canEdit ? contextMenu : [], onClick: onContextMenuClick }}
          trigger={['contextMenu']}
          disabled={!access.canEdit}
        >
          <div style={{ minHeight: '100%' }}>
            <BlockNoteView
              editor={editor}
              theme="light"
              editable={access.canEdit}
              formattingToolbar={access.canEdit}
              slashMenu={false}
              sideMenu={access.canEdit}
              linkToolbar
              tableHandles
              onChange={onContentChange}
            />
          </div>
        </Dropdown>
        {/* H1-H6 section tags 浮动覆盖层：绝不修改 BlockNote DOM，
            tag 按钮绝对定位浮在每个 heading 右侧，位置由滚动/编辑时直接更新 DOM。 */}
        <div
          ref={overlayRef}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            pointerEvents: 'none',
            zIndex: 5,
          }}
        >
          {access.canEdit &&
            headingKeys.map((key) => (
            <div
              key={key}
              ref={(el) => {
                if (el) tagItemRefs.current.set(key, el)
                else tagItemRefs.current.delete(key)
              }}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                pointerEvents: 'auto',
              }}
            >
              <TagManager
                compact
                tags={draft?.sectionTags?.[key] || []}
                onChange={(tags) => {
                  const sectionTags = { ...(draft?.sectionTags || {}) }
                  if (tags.length) sectionTags[key] = tags
                  else delete sectionTags[key]
                  editDraft({ sectionTags })
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </Panel>
  )
}

