import { useEffect, useLayoutEffect, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { createMarkdownLivePreview } from './markdownLivePreview'
import { createMarkdownBlockWidgets } from './markdownBlockWidgets'
import { toggleWrap } from './markdownCommands'

/**
 * 纯 Markdown 源码编辑器（CodeMirror 6，2026-10-29）。
 * 替换 BlockNote 的富文本块编辑器，用于根治大文档「选中文字卡顿」：
 * - CM6 原生视口虚拟化，只渲染可见行 → 选区/布局成本与文档大小无关；
 * - 文本模型（非富文本节点），跨块选中就是普通文本选区，无需自研；
 * - 内容直接就是 contentMd，不存在 blocks ↔ markdown 的整篇序列化。
 */
interface MarkdownSourceEditorProps {
  /** 外部文档内容（切页/回滚时会替换编辑器文档；内部输入不回灌，避免光标跳动） */
  value: string
  /** 只读（View 角色） */
  readOnly?: boolean
  /** 用户输入回调（未防抖，由调用方决定何时写入 store） */
  onChange: (value: string) => void
  /** 编辑器实例就绪/销毁回调（父组件用于 TOC 跳转等命令式操作） */
  onViewReady?: (view: EditorView | null) => void
}

export function MarkdownSourceEditor({
  value,
  readOnly = false,
  onChange,
  onViewReady,
}: MarkdownSourceEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onViewReadyRef = useRef(onViewReady)
  /** 外部写入文档时置位，避免 updateListener 把回灌当成用户输入再写回 store */
  const externalRef = useRef(false)
  const readOnlyCompartment = useRef(new Compartment())

  useLayoutEffect(() => {
    onChangeRef.current = onChange
    onViewReadyRef.current = onViewReady
  })

  // 创建编辑器（仅一次）：readOnly 通过 Compartment 动态切换
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const { field: blockWidgets, getOccupiedLineRanges } = createMarkdownBlockWidgets(
      () => viewRef.current,
    )
    const livePreview = createMarkdownLivePreview(getOccupiedLineRanges)
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          bracketMatching(),
          highlightSelectionMatches(),
          // GFM 方言：删除线（~~）、表格等节点才能被语法树识别（Live Preview 依赖）
          markdown({ base: markdownLanguage }),
          // Live Preview：块级 Widget（公式/表格/整行图片，StateField）+ 行级/行内装饰（ViewPlugin）
          // 注意：CM6 禁止 ViewPlugin 提供 block 装饰，故块级必须单独用 StateField
          blockWidgets,
          livePreview,
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
            // 常用格式快捷键（与工具条一致；只读时不拦截）
            {
              key: 'Mod-b',
              run: (v) => {
                if (v.state.readOnly) return false
                toggleWrap(v, '**')
                return true
              },
            },
            {
              key: 'Mod-i',
              run: (v) => {
                if (v.state.readOnly) return false
                toggleWrap(v, '*')
                return true
              },
            },
          ]),
          EditorView.lineWrapping,
          readOnlyCompartment.current.of([
            EditorState.readOnly.of(readOnly),
            // 只读时彻底关闭 contenteditable：避免 View 角色仍能聚焦输入
            EditorView.editable.of(!readOnly),
          ]),
          placeholder('在此编辑 Markdown 源码…'),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !externalRef.current) {
              onChangeRef.current(update.state.doc.toString())
            }
          }),
          EditorView.theme({
            '&': { height: '100%' },
            '.cm-scroller': { fontFamily: 'monospace', fontSize: '13.5px', lineHeight: '1.7' },
            '.cm-content': { paddingBottom: '40vh' },
          }),
        ],
      }),
    })
    viewRef.current = view
    onViewReadyRef.current?.(view)
    return () => {
      view.destroy()
      viewRef.current = null
      onViewReadyRef.current?.(null)
    }
    // 仅在挂载时创建一次；value/readOnly 变化由下面的 effect 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 外部内容变化（切页 / 撤销到服务端版本）→ 替换整个文档
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    externalRef.current = true
    try {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    } finally {
      externalRef.current = false
    }
  }, [value])

  // 只读切换
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    })
  }, [readOnly])

  return <div ref={hostRef} style={{ height: '100%', minHeight: 0, overflow: 'hidden' }} />
}
