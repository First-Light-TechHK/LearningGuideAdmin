import mammoth from 'mammoth';

/**
 * 原始素材 ZIP 里的文本课件 DOCX → 正文 HTML。
 *
 * 为什么不用 markitdown：MarkItDown 产出的是 Markdown，而旧的 mdToHtml 只认
 * `#` 标题，`**粗体**`、`![](data:image/png;base64...)`、表格等都会被当成普通
 * 文本转义，正文里于是出现 `**1.1 …**`、`![](data:image...)` 这类原始标记。
 * 这里改用 mammoth（与编辑器「Import .docx」同一条转换链路）直接产出 HTML，
 * 保留粗体、斜体、列表、表格与图片。
 *
 * 另一个关键点：内容团队交来的 DOCX 里，学习点标题常常只是「加粗段落」而不是
 * Word 的「标题 1」样式（如 `1.1 状态变量与状态空间`）。PRD 规定正文中的 H1
 * 即 Learning Point，因此这里把「整段加粗且以编号开头」的段落提升为 `<h1>`，
 * 并按编号去重（同一编号的中英文两行只把第一行升级为标题）。
 */

export interface DocxHeading {
  /** 标题前的编号（1.1、2.3…）；没有编号时为空字符串。 */
  code: string;
  /** 去掉编号后的标题文本。 */
  title: string;
}

export interface DocxHtmlResult {
  html: string;
  headings: DocxHeading[];
  warnings: string[];
}

const NUMBERED_HEADING = /^\s*(\d+(?:\.\d+)*)[.、]?\s+(\S[\s\S]*)$/;
const EMPTY_PARAGRAPH = /<p>\s*<\/p>/gi;
const SINGLE_CELL_TABLE =
  /<table>\s*<tr>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>\s*<\/table>/gi;
const BOLD_ONLY_PARAGRAPH = /<p>\s*<strong>([\s\S]*?)<\/strong>\s*<\/p>/gi;

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 规范 mammoth 输出的 HTML：
 * 1) 单行单格表格（DOCX 里放图片+图注的容器）拆成普通段落，避免编辑器里出现表格；
 * 2) 整段加粗且以编号开头的段落提升为 `<h1>`（同一编号只提升第一处）；
 * 3) 去掉转换后遗留的空段落。
 */
export function normalizeDocxHtml(html: string): string {
  let out = html.replace(SINGLE_CELL_TABLE, '$1');

  const seenNumbers = new Set<string>();
  out = out.replace(BOLD_ONLY_PARAGRAPH, (full, inner: string) => {
    const text = stripTags(inner);
    const match = NUMBERED_HEADING.exec(text);
    if (!match) return full;
    const code = match[1];
    if (seenNumbers.has(code)) return full;
    seenNumbers.add(code);
    const title = match[2].trim();
    if (!title) return full;
    return `<h1>${escapeHtml(title)}</h1>`;
  });

  out = out.replace(EMPTY_PARAGRAPH, '').trim();
  return out || '<p></p>';
}

/** 从正文 HTML 提取 H1（正文 H1 即 Learning Point，见 PRD 12.5.2）。 */
export function extractDocxHeadings(html: string): DocxHeading[] {
  const headings: DocxHeading[] = [];
  for (const match of html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)) {
    const text = stripTags(match[1] ?? '');
    if (!text) continue;
    const numbered = NUMBERED_HEADING.exec(text);
    headings.push(
      numbered
        ? { code: numbered[1], title: numbered[2].trim() }
        : { code: '', title: text },
    );
  }
  return headings;
}

export async function convertDocxToHtml(bytes: Buffer): Promise<DocxHtmlResult> {
  let html: string;
  const warnings: string[] = [];
  try {
    const result = await mammoth.convertToHtml({ buffer: bytes });
    html = normalizeDocxHtml(result.value);
    for (const message of result.messages) {
      if (message.type === 'warning') warnings.push(message.message);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      html: '',
      headings: [],
      warnings: [`文本课件 DOCX 解析失败：${detail}`],
    };
  }
  return { html, headings: extractDocxHeadings(html), warnings };
}
