import { memo, useMemo, type ComponentProps } from 'react'
import MDEditor from '@uiw/react-md-editor'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { tutorAnswerParts } from './tutorAnswerParts'
import { safeMarkdownPlugins } from './safeMarkdownPlugins'

const KATEX = { throwOnError: false, strict: 'ignore', trust: false, maxExpand: 100, output: 'html' } as const
const IMAGE_PATH = /^\/api\/files\/images\/([^/]+)\/([0-9a-f-]{36}\.(?:png|jpg|jpeg|gif|webp))$/i

export const TutorMarkdown = memo(function TutorMarkdown({ content, courseId, sourcesLabel = 'Sources' }: {
  content: string
  courseId?: string | null
  sourcesLabel?: string
}) {
  const { markdown, sources } = tutorAnswerParts(content)
  const components = useMemo<NonNullable<ComponentProps<typeof MDEditor.Markdown>['components']>>(() => ({
    a({ href, children }) {
      return /^https?:\/\//i.test(href || '') ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>
    },
    img({ src, alt }) {
      const match = IMAGE_PATH.exec(String(src || ''))
      return match && courseId === match[1] ? <img src={src} alt={alt || ''} loading="lazy" /> : <span>{alt || ''}</span>
    },
  }), [courseId])
  return <div className="tutor-answer">
    <MDEditor.Markdown source={markdown} remarkPlugins={[remarkMath, remarkGfm]} rehypePlugins={[[rehypeKatex, KATEX]]} pluginsFilter={safeMarkdownPlugins} components={components} />
    {sources.length > 0 && <div className="tutor-answer-sources"><p>{sourcesLabel}</p>{sources.map((source) => <p key={source}>{source}</p>)}</div>}
  </div>
})
