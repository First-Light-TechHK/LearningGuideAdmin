export interface WikiSourceReference {
  entryId: string
  entryTitle: string
  linkText: string
  url: string
}

/** Page 是本轮 Wiki 条目，来源关系保存在其 Markdown 链接中。 */
export function extractWikiSources(page: { id: string; title: string; contentMd: string }): WikiSourceReference[] {
  const links = /(?<!!)\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g
  return Array.from(page.contentMd.matchAll(links), (match) => ({
    entryId: page.id,
    entryTitle: page.title,
    linkText: match[1],
    url: match[2],
  }))
}
