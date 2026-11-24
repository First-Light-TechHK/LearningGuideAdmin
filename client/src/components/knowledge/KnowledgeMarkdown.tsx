import MDEditor from '@uiw/react-md-editor'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import 'katex/dist/katex.min.css'
import { previewUrl, sanitizeHtml } from './markdownHtml'
import { tokens } from '../../theme/tokens'

const remarkPlugins = [remarkGfm, remarkMath]
const rehypePlugins = [rehypeRaw, sanitizeHtml, rehypeKatex]

export function KnowledgeMarkdown({ source }: { source: string }) {
  return <MDEditor.Markdown source={source} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}
    urlTransform={previewUrl} style={{ background: 'transparent', fontSize: tokens.fontSize.xl }} />
}
