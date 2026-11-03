import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseMarkdown } from '../modules/helpdesk/faqs/faqMarkdown';
import { splitAnswerBlocks } from '../modules/helpdesk/faqs/faqBlocks';

/**
 * Part H：发布时把答案切成块（每段一块、每组编号步骤一块、每个列表一块），id b1..bn。
 * 规则与渲染器（faqMarkdown.ts，与 Portal 同一份语料锁定）完全一致：每块单独渲染 = 它在整条答案里的渲染。
 */
const texts = (source: string) => splitAnswerBlocks(source).map((b) => b.text);

describe('splitAnswerBlocks', () => {
  it('one block per paragraph, numbered-steps group and list, ids b1..bn', () => {
    const answer =
      'Open **My Subscription**.\n\n1. Choose an order\n2. Select **Invoice**\n\n- PDF\n- CSV\n\nStill stuck? Contact us.';
    expect(splitAnswerBlocks(answer)).toEqual([
      { id: 'b1', text: 'Open **My Subscription**.' },
      { id: 'b2', text: '1. Choose an order\n2. Select **Invoice**' },
      { id: 'b3', text: '- PDF\n- CSV' },
      { id: 'b4', text: 'Still stuck? Contact us.' },
    ]);
  });

  it('splits a lead-in line from the steps that follow it without a blank line', () => {
    expect(texts('要开发票：\n1. 打开**我的订阅**\n2. 选择订单')).toEqual([
      '要开发票：',
      '1. 打开**我的订阅**\n2. 选择订单',
    ]);
  });

  it('keeps blank-separated items of one list, and lazy or indented continuation lines, in one block', () => {
    expect(
      texts(
        '1. First\n\n2. Second\n   more about the second\n3. Third\nlazy line',
      ),
    ).toEqual([
      '1. First\n\n2. Second\n   more about the second\n3. Third\nlazy line',
    ]);
  });

  it('an ordered list right after a bullet list is a new block, and a paragraph after a blank line ends the list', () => {
    expect(texts('- a\n- b\n1. one\n2. two\n\nAfter.')).toEqual([
      '- a\n- b',
      '1. one\n2. two',
      'After.',
    ]);
  });

  it('a multi-line paragraph is one block; CRLF, trailing spaces and extra blank lines are normalised', () => {
    expect(
      texts('Line one\r\nline two  \r\n\r\n\r\n\r\n**Bold** end\n\n'),
    ).toEqual(['Line one\nline two', '**Bold** end']);
  });

  it('a single paragraph is one block; empty text has none', () => {
    expect(splitAnswerBlocks('只有一段。')).toEqual([
      { id: 'b1', text: '只有一段。' },
    ]);
    expect(splitAnswerBlocks('  \n\n ')).toEqual([]);
  });

  it('every block renders alone exactly as it does inside the whole answer (corpus and seed answers)', () => {
    const corpus = JSON.parse(
      readFileSync(
        join(__dirname, 'fixtures', 'helpdesk-markdown-corpus.json'),
        'utf8',
      ),
    ) as { cases: { input: string }[] };
    const seed = JSON.parse(
      readFileSync(join(__dirname, '../../../eval/helpdesk/faqs.json'), 'utf8'),
    ) as { faqs: { answerEn: string; answerZh: string }[] };
    const sources = [
      ...corpus.cases.map((c) => c.input),
      ...seed.faqs.flatMap((f) => [f.answerEn, f.answerZh]),
    ];
    expect(sources.length).toBeGreaterThan(20);
    for (const source of sources) {
      const whole = parseMarkdown(source);
      const blocks = splitAnswerBlocks(source);
      expect(blocks.map((b) => b.id)).toEqual(
        blocks.map((_, i) => `b${i + 1}`),
      );
      expect(blocks.flatMap((b) => parseMarkdown(b.text))).toEqual(whole);
      for (const block of blocks)
        expect(parseMarkdown(block.text)).toHaveLength(1);
    }
  });
});
