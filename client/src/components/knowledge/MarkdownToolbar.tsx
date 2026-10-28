import { useEffect, useState } from 'react'
import { Button, Space, Tooltip } from '../ui'
import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import {
  insertSnippet,
  setHeading,
  toggleLinePrefix,
  toggleWrap,
} from './markdownCommands'
import { tokens } from '../../theme/tokens'
import { useKText } from './i18n'

/**
 * Markdown 常驻格式工具条（2026-10-29，M1）。
 * 固定在编辑器上方，选中时高亮当前格式；所有操作只修改纯 Markdown 文本。
 */
interface Props {
  view: EditorView | null
  disabled?: boolean
}

interface ActiveState {
  heading: number
  bullet: boolean
  ordered: boolean
  quote: boolean
  strong: boolean
  em: boolean
  strike: boolean
  code: boolean
}

const EMPTY_ACTIVE: ActiveState = {
  heading: 0,
  bullet: false,
  ordered: false,
  quote: false,
  strong: false,
  em: false,
  strike: false,
  code: false,
}

function markActive(state: EditorState, names: ReadonlySet<string>): boolean {
  let node = syntaxTree(state).resolveInner(state.selection.main.head, -1)
  while (node) {
    if (names.has(node.name)) return true
    node = node.parent as typeof node
  }
  return false
}

function computeActive(view: EditorView): ActiveState {
  const state = view.state
  const line = state.doc.lineAt(state.selection.main.head)
  const text = line.text
  return {
    heading: /^(#{1,6})\s/.exec(text)?.[1].length ?? 0,
    bullet: /^\s*[-*+]\s/.test(text),
    ordered: /^\s*\d+[.)]\s/.test(text),
    quote: /^\s*>\s/.test(text),
    strong: markActive(state, new Set(['StrongEmphasis'])),
    em: markActive(state, new Set(['Emphasis'])),
    strike: markActive(state, new Set(['Strikethrough'])),
    code: markActive(state, new Set(['InlineCode'])),
  }
}

export function MarkdownToolbar({ view, disabled }: Props) {
  const [active, setActive] = useState<ActiveState>(EMPTY_ACTIVE)
  const { text } = useKText()

  // 选区/光标变化时刷新高亮（CM6 无 React 状态，这里用原生事件兜住）
  useEffect(() => {
    if (!view) {
      setActive(EMPTY_ACTIVE)
      return
    }
    const sync = () => setActive(computeActive(view))
    sync()
    const onSelectionChange = () => sync()
    view.dom.addEventListener('keyup', sync)
    view.dom.addEventListener('mouseup', sync)
    view.dom.addEventListener('focus', sync)
    document.addEventListener('selectionchange', onSelectionChange)
    return () => {
      view.dom.removeEventListener('keyup', sync)
      view.dom.removeEventListener('mouseup', sync)
      view.dom.removeEventListener('focus', sync)
      document.removeEventListener('selectionchange', onSelectionChange)
    }
  }, [view])

  const btn = (
    label: string,
    title: string,
    isActive: boolean,
    onClick: () => void,
    style?: React.CSSProperties,
  ) => (
    <Tooltip title={title} key={title}>
      <Button
        size="small"
        type={isActive ? 'primary' : 'text'}
        disabled={disabled || !view}
        style={{ minWidth: 28, padding: '0 6px', fontWeight: tokens.fontWeight.semibold, ...style }}
        onClick={onClick}
      >
        {label}
      </Button>
    </Tooltip>
  )

  return (
    // 阻止 mousedown 抢焦点，保证点击按钮时编辑器选区不丢失
    <div
      onMouseDown={(e) => e.preventDefault()}
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: tokens.spacing.xs,
        padding: `${tokens.spacing.xs}px 0`,
        marginBottom: tokens.spacing.xs,
        borderBottom: `1px solid ${tokens.color.border}`,
      }}
    >
      <Space size={2}>
        {btn('H1', text('toolbar.h1'), active.heading === 1, () => view && setHeading(view, 1))}
        {btn('H2', text('toolbar.h2'), active.heading === 2, () => view && setHeading(view, 2))}
        {btn('H3', text('toolbar.h3'), active.heading === 3, () => view && setHeading(view, 3))}
        {btn('¶', text('toolbar.paragraph'), active.heading === 0, () => view && setHeading(view, 0))}
      </Space>
      <Space size={2}>
        {btn('B', text('toolbar.bold'), active.strong, () => view && toggleWrap(view, '**'), {
          fontFamily: 'serif',
        })}
        {btn('I', text('toolbar.italic'), active.em, () => view && toggleWrap(view, '*'), {
          fontStyle: 'italic',
          fontFamily: 'serif',
        })}
        {btn('S', text('toolbar.strike'), active.strike, () => view && toggleWrap(view, '~~'), {
          textDecoration: 'line-through',
        })}
        {btn('</>', text('toolbar.inlineCode'), active.code, () => view && toggleWrap(view, '`'))}
      </Space>
      <Space size={2}>
        {btn('$x$', text('toolbar.inlineMath'), false, () => {
          if (!view) return
          // 有选区 → toggle $…$；无选区 → 插入占位 $x$ 并选中 x（避免产生空公式 `$$`）
          if (view.state.selection.main.empty) {
            insertSnippet(view, '$x$', { select: { from: 1, to: 2 } })
          } else {
            toggleWrap(view, '$')
          }
        })}
        {btn(
          text('toolbar.linkLabel'),
          text('toolbar.link'),
          false,
          () => {
            if (!view) return
            const linkText = text('editor.snippet.linkText')
            insertSnippet(view, `[${linkText}](https://)`, { select: { from: 1, to: 1 + linkText.length } })
          },
        )}
        {btn(
          text('toolbar.imageLabel'),
          text('toolbar.image'),
          false,
          // 编辑器换成 Markdown 后保留「外链 URL 插图」入口（BUG-0224）；选中 URL 占位便于直接粘贴
          () => {
            if (!view) return
            const alt = text('editor.snippet.toolbarImageAlt')
            const urlFrom = 4 + alt.length
            insertSnippet(view, `![${alt}](https://)`, { block: true, select: { from: urlFrom, to: urlFrom + 8 } })
          },
        )}
      </Space>
      <Space size={2}>
        {btn('•', text('toolbar.bullet'), active.bullet, () => view && toggleLinePrefix(view, () => '- ', /^(\s*)([-*+])(\s)/))}
        {btn(
          '1.',
          text('toolbar.ordered'),
          active.ordered,
          () => view && toggleLinePrefix(view, (i) => `${i + 1}. `, /^(\s*)(\d+[.)])(\s)/),
        )}
        {btn('❝', text('toolbar.quote'), active.quote, () => view && toggleLinePrefix(view, () => '> ', /^(\s*)(>)(\s)/))}
      </Space>
    </div>
  )
}
