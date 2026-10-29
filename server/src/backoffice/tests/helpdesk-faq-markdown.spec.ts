import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { SessionEmployee } from '../contracts/employee';
import { createFaqService } from '../modules/helpdesk/faqs/faqService';
import { safeHref, unsafeLinks } from '../modules/helpdesk/faqs/faqMarkdown';
import { HelpdeskError } from '../modules/helpdesk/portalHelpdeskClient';
import { createMemoryFaqRepository } from './helpers/memoryFaqRepository';

/**
 * Tickets v2 §1：Preview 与 Portal 所有学生端页面用同一个渲染器。保存校验必须拒绝 Portal 渲染器会丢掉的
 * 每一个链接，否则坐席保存、预览的内容与学生看到的不一致。共用语料 fixtures/helpdesk-markdown-corpus.json
 * 与 Portal tests/fixtures 以及 client/tests/fixtures 逐字节相同（sha256 固定）。
 */
type CorpusCase = { name: string; input: string; unsafeLinks: string[] };
const BYTES = readFileSync(
  join(__dirname, 'fixtures', 'helpdesk-markdown-corpus.json'),
);
const CORPUS = JSON.parse(BYTES.toString('utf8')) as { cases: CorpusCase[] };
const employee = {
  employeeId: '0192aaaa-0000-7000-8000-000000000001',
  displayName: 'alice',
} as SessionEmployee;
const base = {
  category: 'account_technical',
  popular: false,
  questionEn: 'Q',
  answerEn: 'A',
  questionZh: '问',
  answerZh: '答',
  keywords: [],
};

describe('FAQ answers: the save check uses the Portal renderer rules', () => {
  it('reads the pinned shared corpus', () => {
    expect(createHash('sha256').update(BYTES).digest('hex')).toBe(
      '45ece9b892722705fa064ef580ebaa1b0afdb094758eebdf021238565a97c852',
    );
  });

  it('finds exactly the corpus unsafe links', () => {
    for (const item of CORPUS.cases)
      expect([item.name, unsafeLinks(item.input)]).toEqual([
        item.name,
        item.unsafeLinks,
      ]);
  });

  it('refuses to save an answer with any link the renderer would drop, in either language, and saves the rest', async () => {
    const service = createFaqService({
      repository: createMemoryFaqRepository([]),
    });
    for (const item of CORPUS.cases) {
      if (!item.input.trim()) continue;
      for (const field of ['answerEn', 'answerZh'] as const) {
        const attempt = service.create(employee, {
          ...base,
          [field]: item.input,
        });
        if (item.unsafeLinks.length) {
          const error = await attempt.catch((e: unknown) => e);
          expect(error).toBeInstanceOf(HelpdeskError);
          expect(error).toMatchObject({ status: 400, code: 'INVALID_INPUT' });
        } else {
          await expect(attempt).resolves.toMatchObject({ version: 1 });
        }
      }
    }
  });

  it('safeHref is the Portal rule: absolute http(s) with a host, or mailto with an address', () => {
    expect(safeHref('HTTPS://Example.com/x')).toBe('https://example.com/x');
    expect(safeHref('mailto:a@b.co')).toBe('mailto:a@b.co');
    for (const bad of [
      "https://x.com/?q=it's",
      'https:///x',
      'mailto:foo',
      'javascript:alert(1)',
      ' https://a.test',
      'https://a b.test',
    ])
      expect([bad, safeHref(bad)]).toEqual([bad, null]);
  });
});
