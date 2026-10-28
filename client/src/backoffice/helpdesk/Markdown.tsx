import { Fragment, type ReactNode } from 'react'

import { parseMarkdown, type Inline } from '../lib/helpdeskMarkdown'

/**
 * FAQ 答案的唯一渲染器（Tickets v2 §1）：Preview 与 Enquiries 的 AI 块共用。
 * 只生成 React 元素（不用 dangerouslySetInnerHTML），原始 HTML 显示为文字；
 * 外部链接新标签页打开并带 rel="noopener noreferrer"，mailto 在本页打开邮件客户端。
 */

function inline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.kind === 'text') return <Fragment key={index}>{node.text}</Fragment>
    if (node.kind === 'bold') return <strong key={index}>{inline(node.children)}</strong>
    const external = !node.href.toLowerCase().startsWith('mailto:')
    return (
      <a
        key={index}
        href={node.href}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer' : undefined}
      >
        {inline(node.children)}
      </a>
    )
  })
}

export function MarkdownView({ text, className }: { text: string; className?: string }) {
  const blocks = parseMarkdown(text)
  return (
    <div className={className ? `hdMarkdown ${className}` : 'hdMarkdown'}>
      {blocks.map((block, index) => {
        if (block.kind === 'paragraph') {
          return (
            <p key={index}>
              {block.lines.map((line, at) => (
                <Fragment key={at}>
                  {at > 0 ? <br /> : null}
                  {inline(line)}
                </Fragment>
              ))}
            </p>
          )
        }
        const items = block.items.map((item, at) => <li key={at}>{inline(item)}</li>)
        return block.kind === 'ordered' ? (
          <ol key={index} start={block.start === 1 ? undefined : block.start}>
            {items}
          </ol>
        ) : (
          <ul key={index}>{items}</ul>
        )
      })}
    </div>
  )
}
