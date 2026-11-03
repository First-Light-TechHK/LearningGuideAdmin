import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PII_KINDS,
  scrubPii,
  scrubPiiReport,
  type ScrubContext,
} from '../modules/helpdesk/flywheel/piiScrubber';
import { PII_PLACEHOLDERS } from '../modules/helpdesk/contracts';

/**
 * 共用的脱敏语料（v5 Part G2 / G5「scrubber corpus test」）：Admin 的脱敏器是 Portal 那份的副本，
 * 只在客服把已解决的工单「转成 FAQ 候选」时用（存进飞轮之前先脱敏）。两个仓库跑同一个语料文件
 * （逐字节相同，两边都按哈希锁定），CI 里不调模型。
 */
const raw = readFileSync(
  join(__dirname, 'fixtures', 'helpdesk-pii-corpus.json'),
);
const corpus = JSON.parse(raw.toString('utf8')) as {
  cases: {
    group: string;
    input: string;
    expected: string;
    context?: ScrubContext;
  }[];
};

/** 两份一起改，再同时更新这里和 Portal 的 helpdesk-pii-corpus-fixture.test.ts。 */
const PINNED_SHA256 =
  '1beb8cfe0c215511f02849f0a27ccc1911e96b286f343c90b056bc3ef72be261';

describe('shared PII scrubber corpus', () => {
  it('is the pinned version (the same bytes as Portal’s copy)', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(PINNED_SHA256);
  });

  it('covers zh-CN, zh-TW, en and mixed text', () => {
    expect(new Set(corpus.cases.map((c) => c.group))).toEqual(
      new Set(['zh-CN', 'zh-TW', 'en', 'mixed']),
    );
    expect(corpus.cases.length).toBeGreaterThanOrEqual(80);
  });

  it('uses the placeholder kinds of the contract', () => {
    expect([...PII_KINDS]).toEqual([...PII_PLACEHOLDERS]);
  });

  it.each(corpus.cases.map((c, i) => [i, c.group, c] as const))(
    '#%i %s',
    (_i, _group, c) => {
      const once = scrubPii(c.input, c.context ?? {});
      expect(once).toBe(c.expected);
      // 幂等：脱敏过的再脱一次不变
      expect(scrubPii(once, c.context ?? {})).toBe(once);
    },
  );

  it('the report counts placeholders, never the removed text', () => {
    const report = scrubPiiReport('我的手机号是13800138000，邮箱 a.b@qq.com');
    expect(report.found).toEqual({ phone: 1, email: 1 });
    expect(JSON.stringify(report)).not.toContain('13800138000');
  });

  it('scrubs a long list of short numbers split by spaces in bounded time', () => {
    for (const long of [
      '1  '.repeat(2000),
      '12 34 '.repeat(1500),
      '第 3 课 4 题 '.repeat(800),
    ]) {
      const started = Date.now();
      const output = scrubPii(long);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(scrubPii(long)).toBe(output);
    }
  });
});
