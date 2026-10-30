import type { FaqBlock } from '../../../../contracts/helpdesk-qa';
import { BULLET, ORDERED } from './faqMarkdown';

/**
 * Part H：发布时由代码把一条答案切成块（每段一块、每组编号步骤一块、每个列表一块），id 按顺序
 * b1..bn。逐行走与 faqMarkdown.ts parseMarkdown 完全相同的状态机（同一对列表正则、同样的
 * 懒续行与缩进续行），所以每块单独渲染 = 它在整条答案里的渲染（helpdesk-faq-blocks.spec.ts 用共享语料锁定）。
 * 块文字是原文行（统一 \n、去行尾空白），块内的空行保留（同一列表里隔空行的项），块之间的空行不算。
 * 纯函数，不看语言；同一答案永远切出同样的块。
 */
export function splitAnswerBlocks(source: string): FaqBlock[] {
  const lines = source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''));
  const ranges: { start: number; end: number }[] = [];
  let paragraph: { start: number; end: number } | null = null;
  let list: { kind: 'ordered' | 'bullet'; start: number; end: number } | null =
    null;
  let blankBefore = false;
  const closeParagraph = () => {
    if (paragraph) ranges.push(paragraph);
    paragraph = null;
  };
  const closeList = () => {
    if (list) ranges.push({ start: list.start, end: list.end });
    list = null;
  };
  lines.forEach((line, index) => {
    if (!line.trim()) {
      closeParagraph();
      blankBefore = true;
      return;
    }
    const ordered = ORDERED.test(line);
    const bullet = !ordered && BULLET.test(line);
    if (ordered || bullet) {
      const kind = ordered ? 'ordered' : 'bullet';
      closeParagraph();
      if (list && list.kind !== kind) closeList();
      if (!list) list = { kind, start: index, end: index };
      list.end = index;
      blankBefore = false;
      return;
    }
    if (list && (!blankBefore || /^[ \t]/.test(line))) {
      list.end = index;
      blankBefore = false;
      return;
    }
    closeList();
    if (paragraph) paragraph.end = index;
    else paragraph = { start: index, end: index };
    blankBefore = false;
  });
  closeParagraph();
  closeList();
  return ranges
    .sort((a, b) => a.start - b.start)
    .map((range, i) => ({
      id: `b${i + 1}`,
      text: lines.slice(range.start, range.end + 1).join('\n'),
    }));
}
