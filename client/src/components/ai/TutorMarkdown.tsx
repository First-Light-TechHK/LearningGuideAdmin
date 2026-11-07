import { memo } from 'react'
import MDEditor from '@uiw/react-md-editor'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { normalizeTutorMarkdown } from './normalizeTutorMarkdown'
import { tokens } from '../../theme/tokens'

interface MarkdownNode {
  type: string
  value?: string
  children?: MarkdownNode[]
  data?: { hName?: string; hProperties?: Record<string, string> }
}

function remarkTutorFormatting() {
  const visit = (node: MarkdownNode) => {
    if (['code', 'inlineCode', 'math', 'inlineMath', 'link', 'image'].includes(node.type)) return
    if (node.type === 'blockquote' && node.children?.[0]?.children?.[0]?.value === 'Sources') {
      node.data = { ...node.data, hProperties: { className: 'markdown-sources' } }
      return
    }
    if (!node.children) return
    node.children = node.children.flatMap((child) => {
      if (child.type === 'html') return []
      if (child.type !== 'text' || !child.value) { visit(child); return [child] }
      const parts: MarkdownNode[] = []
      let start = 0
      for (const match of child.value.matchAll(/\[\d+\]/g)) {
        if (match.index > start) parts.push({ type: 'text', value: child.value.slice(start, match.index) })
        parts.push({ type: 'tutorCitation', data: { hName: 'sup' }, children: [{ type: 'text', value: match[0] }] })
        start = match.index + match[0].length
      }
      if (start < child.value.length) parts.push({ type: 'text', value: child.value.slice(start) })
      return parts.length ? parts : [child]
    })
  }
  return visit
}

const remarkPlugins = [remarkGfm, remarkMath, remarkTutorFormatting]

function safeTutorUrl(value: string): string {
  const compact = Array.from(value).filter((char) => char.charCodeAt(0) > 32).join('')
  return /^[a-z][a-z\d+.-]*:/i.test(compact) && !/^(https?:|mailto:)/i.test(compact) ? '' : value
}

export const TutorMarkdown = memo(function TutorMarkdown({ content }: { content: string }) {
  return <MDEditor.Markdown
    source={normalizeTutorMarkdown(content)}
    remarkPlugins={remarkPlugins}
    rehypePlugins={[[rehypeKatex, { throwOnError: false, trust: false, maxExpand: 100 }]]}
    skipHtml
    urlTransform={safeTutorUrl}
    style={{ background: 'transparent', fontSize: tokens.fontSize.xl }}
  />
})
