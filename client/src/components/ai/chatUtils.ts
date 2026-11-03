/**
 * AI Tutor 对话气泡辅助工具（纯函数，零依赖）。
 * - stripMarkdown：Markdown → 纯文本（保留基本结构，去掉标记）
 * - copyToClipboard：写入剪贴板，带降级
 */

/**
 * 把 Markdown 转为可读纯文本：
 * - 去掉格式标记：**bold** → bold、*italic* → italic、~~删除线~~ → 删除线
 * - 去掉 LaTeX 分隔符：$E=mc^2$ → E=mc^2、$$...$$ → 公式内容
 * - 去掉行内 `<sup>[1]</sup>` → `[1]`
 * - 去掉链接包装：[text](url) → text
 * - 去掉代码块/行内代码标记
 * - **保留基本结构**：换行、列表符号 `- ` / `1. `、引用 `> ` 都保留
 */
export function stripMarkdown(md: string): string {
  if (!md || typeof md !== 'string') return ''
  let s = md

  // LaTeX
  s = s.replace(/\$\$([\s\S]*?)\$\$/g, '$1')
  s = s.replace(/\$([^\n$]*?)\$/g, '$1')

  // 行内 HTML（normalizeTutorMarkdown 注入的 <sup>、<div class="markdown-sources"> 等）
  s = s.replace(/<sup>([^<]*?)<\/sup>/gi, '$1')
  s = s.replace(/<\/?(div|p|span|ul|ol|li|blockquote)[^>]*>/gi, '')

  // 链接 [text](url) → text
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')

  // 图片 ![alt](url) → alt
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')

  // 粗体/斜体/代码 ~ 标记（** / __ / * / _ / `）
  s = s.replace(/\*\*([^*]+?)\*\*/g, '$1')
  s = s.replace(/__([^_]+?)__/g, '$1')
  s = s.replace(/\*([^*]+?)\*/g, '$1')
  s = s.replace(/_([^_]+?)_/g, '$1')
  s = s.replace(/`([^`]+?)`/g, '$1')
  s = s.replace(/~~([^~]+?)~~/g, '$1')

  // GFM 任务列表
  s = s.replace(/^- \[.\]\s+/gm, '- ')

  // 最后：多余空行压缩（3+ → 2）
  s = s.replace(/\n{3,}/g, '\n\n')

  return s.trim()
}

/** 写入剪贴板，成功返回 true。clipboard API 不可用时降级 execCommand('copy')。 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 降级 */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
