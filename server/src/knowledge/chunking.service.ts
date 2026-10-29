import { Injectable } from '@nestjs/common';

/** 分块结果 */
export interface Chunk {
  /** 页面标题（引用展示用） */
  pageTitle: string;
  /** 所属 heading 文本（引用展示用） */
  heading: string | null;
  /** 分块纯文本 */
  content: string;
  /** 页面内顺序 */
  sortOrder: number;
  /** token 估算（4 chars/token） */
  tokenCount: number;
}

/** heading 文本转 slug（与 ai-chat.service.ts 保持一致） */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/** 生成带层级前缀的 heading key：`h{n}-{slug}` */
function headingKey(level: number, text: string): string {
  return `h${level}-${slugify(text)}`;
}

/**
 * 按 H1-H6 切分 Markdown（与 ai-chat.service.ts 的 splitByHeadings 逻辑一致）。
 * 每段记录 heading 文本、层级、以及该段原始行。
 */
function splitByHeadings(md: string): {
  heading: string;
  level: number;
  body: string;
}[] {
  const lines = md.split('\n');
  const sections: { heading: string; level: number; body: string[] }[] = [
    { heading: '', level: 0, body: [] },
  ];
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) {
      sections.push({ heading: m[2], level: m[1].length, body: [] });
    } else {
      sections[sections.length - 1].body.push(line);
    }
  }
  return sections.map((s) => ({
    heading: s.heading,
    level: s.level,
    body: s.body.join('\n').trim(),
  }));
}

/** 估算 token 数（英文 ~4 chars/token，保守估算） */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * 分块服务（RAG，2026-10-26 新增）。
 * 策略：标题感知 + 滑动窗口。
 * 1. 按 H1-H6 切分 Markdown
 * 2. 每个 heading 段内按 token 数滑动窗口（默认 800 tokens，overlap 80）
 */
@Injectable()
export class ChunkingService {
  private readonly targetTokens: number;
  private readonly overlapTokens: number;

  constructor() {
    this.targetTokens = 800;
    this.overlapTokens = 80;
  }

  /**
   * 将一个 Page 的 Markdown 内容切分为多个 chunks。
   * @param pageTitle 页面标题
   * @param contentMd Markdown 内容
   * @param startOrder 起始 sortOrder（用于跨页面连续编号）
   */
  chunkPage(pageTitle: string, contentMd: string, startOrder: number): Chunk[] {
    const content = contentMd?.trim();
    if (!content) return [];

    const sections = splitByHeadings(content);
    const chunks: Chunk[] = [];
    let order = startOrder;

    for (const section of sections) {
      const heading = section.heading || null;
      const body = section.body;
      if (!body) continue;

      // 构建带 heading 前缀的文本（让 chunk 自带上下文）
      const prefixedText = heading
        ? `${'#'.repeat(section.level)} ${heading}\n${body}`
        : body;

      const bodyTokens = estimateTokens(prefixedText);

      // 如果整段不超过 targetTokens，直接作为一个 chunk
      if (bodyTokens <= this.targetTokens) {
        chunks.push({
          pageTitle,
          heading,
          content: prefixedText,
          sortOrder: order++,
          tokenCount: bodyTokens,
        });
        continue;
      }

      // 超过 targetTokens，滑动窗口切分
      const windowed = this.slidingWindow(prefixedText, heading);
      for (const w of windowed) {
        chunks.push({
          pageTitle,
          heading,
          content: w.content,
          sortOrder: order++,
          tokenCount: w.tokenCount,
        });
      }
    }

    return chunks;
  }

  /**
   * 滑动窗口切分长文本。
   * 按字符数近似 token（4 chars/token），窗口步长 = targetTokens - overlapTokens。
   */
  private slidingWindow(
    text: string,
    heading: string | null,
  ): { content: string; tokenCount: number }[] {
    const targetChars = this.targetTokens * 4;
    const overlapChars = this.overlapTokens * 4;
    const stepChars = targetChars - overlapChars;

    const results: { content: string; tokenCount: number }[] = [];
    let start = 0;

    while (start < text.length) {
      const end = Math.min(start + targetChars, text.length);
      const slice = text.slice(start, end).trim();
      if (slice) {
        results.push({
          content: slice,
          tokenCount: estimateTokens(slice),
        });
      }
      if (end >= text.length) break;
      start += stepChars;
    }

    return results;
  }
}
