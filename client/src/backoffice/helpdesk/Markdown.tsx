import { Fragment, type ReactNode } from 'react'

import { parseMarkdown, type Inline, type Line } from '../lib/helpdeskMarkdown'

/**
 * FAQ 答案的唯一渲染器（Tickets v2 §1）：Preview 与 Enquiries 的 AI 块共用。
 * 只生成 React 元素（不用 dangerouslySetInnerHTML），原始 HTML 显示为文字；
 * 外部链接新标签页打开，mailto 在本页打开邮件客户端；都带 rel="noopener noreferrer"。
 * 输出结构与 Portal components/helpdesk/Markdown.tsx 相同（列表条目的续行包在 span.md-line 里）。
 */

function inline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.kind === 'text') return <Fragment key={index}>{node.text}</Fragment>
    if (node.kind === 'strong') return <strong key={index}>{inline(node.children)}</strong>
    return (
      <a key={index} href={node.href} target={node.external ? '_blank' : undefined} rel="noopener noreferrer">
        {inline(node.children)}
      </a>
    )
  })
}

/** 列表条目：第一行是标题，之后的行保留 <br /> 并包在 .md-line 里（与 Portal 相同）。 */
function itemLines(lines: Line[]): ReactNode[] {
  return lines.map((line, index) =>
    index === 0 ? (
      <Fragment key={index}>{inline(line)}</Fragment>
    ) : (
      <Fragment key={index}>
        <br />
        <span className="md-line">{inline(line)}</span>
      </Fragment>
    ),
  )
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
        const items = block.items.map((item, at) => <li key={at}>{itemLines(item)}</li>)
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
