import { pickSummaryLocalization, summaryTitle } from './course-summary';

const en = { language: 'en-GB', title: 'Modeling life' };
const zh = { language: 'zh-CN', title: '建模生命' };
const zhEmpty = { language: 'zh-CN', title: '' };
const en2 = { language: 'en-GB', title: '  ' };

describe('pickSummaryLocalization', () => {
  it('prefers the default content language when its title is set', () => {
    expect(pickSummaryLocalization([zh, en], 'en-GB')).toBe(en);
    expect(pickSummaryLocalization([en, zh], 'zh-CN')).toBe(zh);
  });

  it('skips an empty placeholder localization that sorts first', () => {
    // 回归：添加学习语言时会写成 title:'' 的占位记录，若排在第一位
    // 旧实现 `localizations[0].title ?? slug` 会让课程列表课程名为空。
    expect(pickSummaryLocalization([zhEmpty, en], 'en-GB')).toBe(en);
    expect(pickSummaryLocalization([zhEmpty, en], 'zh-CN')).toBe(en);
  });

  it('prefers any non-empty title over a blank default-language title', () => {
    const zhBlank = { language: 'zh-CN', title: '   ' };
    expect(pickSummaryLocalization([en, zhBlank], 'zh-CN')).toBe(en);
    expect(pickSummaryLocalization([zhBlank, en], 'zh-CN')).toBe(en);
  });

  it('falls back to the default language entry when every title is empty', () => {
    const zhEmpty2 = { language: 'zh-CN', title: '   ' };
    expect(pickSummaryLocalization([en2, zhEmpty2], 'zh-CN')).toBe(zhEmpty2);
  });

  it('returns undefined when there is no localization at all', () => {
    expect(pickSummaryLocalization([], 'en-GB')).toBeUndefined();
  });
});

describe('summaryTitle', () => {
  it('uses the localized title', () => {
    expect(summaryTitle([zhEmpty, en], 'en-GB', { slug: 'modeling-life', code: 'SCI001' })).toBe('Modeling life');
  });

  it('falls back to slug, then code, when all titles are blank', () => {
    expect(summaryTitle([zhEmpty], 'zh-CN', { slug: 'modeling-life', code: 'SCI001' })).toBe('modeling-life');
    expect(summaryTitle([zhEmpty], 'zh-CN', { slug: '', code: 'SCI001' })).toBe('SCI001');
  });
});
