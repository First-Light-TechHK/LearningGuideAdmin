import MDEditor from '@uiw/react-md-editor'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import { useMemo } from 'react'
import 'katex/dist/katex.min.css'
import { previewUrl, sanitizeHtml } from './markdownHtml'
import { tokens } from '../../theme/tokens'
import type { TeachingRef } from '../../api/teachingCards'
import { useKText } from './i18n'
import { courseReferenceId, courseReferenceImageUrl } from './courseReferencePreview'

const remarkPlugins = [remarkGfm, remarkMath]
const rehypePlugins: NonNullable<React.ComponentProps<typeof MDEditor.Markdown>['rehypePlugins']> = [
  rehypeRaw, sanitizeHtml, [rehypeKatex, { maxExpand: 100, trust: false }],
]

type MarkdownNode = {
  type: string
  url?: string
  alt?: string
  value?: string
  data?: Record<string, unknown>
  children?: MarkdownNode[]
}

function resolveCourseReferences(courseId: string, references: TeachingRef[], unavailable: (id: string) => string) {
  const byId = new Map(references.map((reference) => [reference.id, reference]))
  return () => (tree: MarkdownNode) => {
    const replace = (node: MarkdownNode): MarkdownNode => {
      const id = node.type === 'link' && node.url ? courseReferenceId(node.url) : undefined
      if (id !== undefined) {
        const object = byId.get(id)
        const withCaption = (content: MarkdownNode): MarkdownNode => object?.code
          ? { type: 'emphasis', children: [{ type: 'text', value: object.label + ' ' }, content] } : content
        if (object?.kind === 'image') {
          const url = courseReferenceImageUrl(courseId, object.value)
          return withCaption({ type: 'image', url, alt: object.label })
        }
        if (object?.kind === 'latex') {
          return withCaption({
            type: 'inlineMath', value: object.value,
            data: {
              hName: 'code', hProperties: { className: ['language-math', 'math-inline'] },
              hChildren: [{ type: 'text', value: object.value }],
            },
          })
        }
        const notice = { type: 'text', value: ` (${unavailable(id)})` }
        return { type: 'emphasis', children: [...(node.children ?? []), notice] }
      }
      if (node.children) node.children = node.children.map(replace)
      return node
    }
    replace(tree)
  }
}

export function KnowledgeMarkdown({ source, courseId, references }: {
  source: string
  courseId?: string
  references?: TeachingRef[]
}) {
  const { text } = useKText()
  const plugins = useMemo(() => courseId && references
    ? [...remarkPlugins, resolveCourseReferences(courseId, references, (id) => text('teaching.refUnavailable', { id }))]
    : remarkPlugins, [courseId, references, text])
  return <MDEditor.Markdown source={source} remarkPlugins={plugins} rehypePlugins={rehypePlugins}
    urlTransform={previewUrl} style={{ background: 'transparent', fontSize: tokens.fontSize.xl }} />
}
