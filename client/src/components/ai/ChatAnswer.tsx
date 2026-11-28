import { memo, useMemo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { remarkTutorLines, remarkTutorNoIndentedCode, tutorAnswerParts } from './chatAnswerParts'

const KATEX = { throwOnError: false, strict: 'ignore', trust: false, maxExpand: 100, output: 'html' } as const
const IMAGE_PATH = /^\/api\/files\/images\/([^/]+)\/([0-9a-f-]{36}\.(?:png|jpg|jpeg|gif|webp))$/i
const REMARK_PLUGINS = [remarkTutorNoIndentedCode, remarkMath, remarkGfm, remarkTutorLines]

export const ChatAnswer = memo(function ChatAnswer({ content, courseId, sourcesLabel = 'Sources' }: {
  content: string
  courseId?: string | null
  sourcesLabel?: string
}) {
  const { markdown, sources } = tutorAnswerParts(content)
  const components = useMemo<Components>(() => ({
    a({ href, children }) {
      return /^https?:\/\//i.test(href || '') ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>
    },
    img({ src, alt }) {
      const match = IMAGE_PATH.exec(String(src || ''))
      return match && courseId === match[1] ? <img src={src} alt={alt || ''} loading="lazy" /> : <span>{alt || ''}</span>
    },
  }), [courseId])

  return <div className="tutor-answer" data-testid="tutor-answer">
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={[[rehypeKatex, KATEX]]} components={components}>
      {markdown}
    </ReactMarkdown>
    {sources.length > 0 && <div className="tutor-answer-sources"><p>{sourcesLabel}</p>{sources.map((source) => <p key={source}>{source}</p>)}</div>}
  </div>
})
