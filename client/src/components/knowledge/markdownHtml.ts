const tags = new Set(['div', 'span', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'p', 'br', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'img', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'code', 'blockquote', 'hr', 'del', 's', 'sup', 'sub'])
const attrs = new Set(['className', 'colSpan', 'rowSpan', 'alt', 'src', 'href', 'title', 'start', 'align'])

export function isSafeImageUrl(src: string): boolean {
  return /^(https?:\/\/|\/api\/files\/images\/)/i.test(src) ||
    /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(src)
}

export function previewUrl(url: string): string {
  if (isSafeImageUrl(url)) return url
  try {
    const parsed = new URL(url, 'https://knowledge.invalid/')
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? url : ''
  } catch {
    return ''
  }
}

export function sanitizeHtml() {
  return (tree: { children?: unknown[] }) => {
    const clean = (node: unknown): unknown[] => {
      if (!node || typeof node !== 'object') return []
      const item = node as { type?: string; tagName?: string; properties?: Record<string, unknown>; children?: unknown[] }
      if (item.type === 'element') {
        if (!tags.has(item.tagName ?? '')) return []
        item.properties = Object.fromEntries(Object.entries(item.properties ?? {}).filter(([key]) => attrs.has(key)))
        if (item.tagName === 'img' && !isSafeImageUrl(String(item.properties.src ?? ''))) return []
        if (item.properties.href) item.properties.href = previewUrl(String(item.properties.href))
      }
      if (item.children) item.children = item.children.flatMap(clean)
      return [item]
    }
    if (tree.children) tree.children = tree.children.flatMap(clean)
  }
}

/** DOCX 的合并单元格、列表等结构需保留 HTML，插入编辑器前只复制允许的元素与属性。 */
export function renderHtmlTable(html: string, renderMath: (latex: string, display: boolean) => string): DocumentFragment {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const fragment = document.createDocumentFragment()
  const copy = (source: Node, parent: Node) => {
    if (source.nodeType === Node.TEXT_NODE) {
      parent.appendChild(document.createTextNode(source.textContent ?? ''))
      return
    }
    if (!(source instanceof Element) || !tags.has(source.localName)) return
    if (source.localName === 'code' && source.classList.contains('language-math')) {
      const span = document.createElement('span')
      span.innerHTML = renderMath(source.textContent ?? '', source.classList.contains('math-display'))
      parent.appendChild(span)
      return
    }
    if (source.localName === 'img' && !isSafeImageUrl(source.getAttribute('src') ?? '')) return
    const element = document.createElement(source.localName)
    if (source.localName === 'table') element.className = 'cm-md-table'
    for (const attr of Array.from(source.attributes)) {
      if (!['colspan', 'rowspan', 'alt', 'src', 'href', 'title', 'start', 'align'].includes(attr.name)) continue
      element.setAttribute(attr.name, attr.name === 'href' ? previewUrl(attr.value) : attr.value)
    }
    for (const child of source.childNodes) copy(child, element)
    parent.appendChild(element)
  }
  for (const child of parsed.body.childNodes) copy(child, fragment)
  return fragment
}
