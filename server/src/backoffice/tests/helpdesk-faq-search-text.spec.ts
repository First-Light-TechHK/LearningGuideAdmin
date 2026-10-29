import {
  chineseSearchForms,
  MANDARIN_VARIANTS,
  toMandarin,
  toSimplified,
  typoKeys,
} from '../modules/helpdesk/faqs/faqSearchText';
import { searchTerms } from '../modules/helpdesk/faqs/faqRepository';

/**
 * 候选检索的文本归一（faqSearchText.ts）与检索词（searchTerms）。FAQ 中文是简体，
 * 学员会写繁体、港台用词和粤语；PostgreSQL 上的整条检索见 helpdesk-faqs-repository.pg.spec.ts。
 */
describe('Helpdesk FAQ search text', () => {
  it('converts Traditional (Hong Kong and Taiwan) characters to Simplified', () => {
    expect(toSimplified('我忘記密碼，發票喺邊？')).toBe(
      '我忘记密码，发票喺边？',
    );
    expect(toSimplified('帳號註冊 驗證郵件')).toBe('帐号注册 验证邮件');
    // 港 / 台异体字
    expect(toSimplified('著 衞 裏 綫')).toBe('着 卫 里 线');
    // 简体与英文原样
    expect(toSimplified('如何重置密码 reset password')).toBe(
      '如何重置密码 reset password',
    );
  });

  it('never applies the Taiwan phrase table that changes meanings in this product', () => {
    // twp 会把「登出」换成「注销」（注销 = 删除账号）、「離線」换成「脱机」
    expect(toSimplified('登出')).toBe('登出');
    expect(toSimplified('離線')).toBe('离线');
  });

  it('rewrites regional words and Cantonese into Mainland Mandarin', () => {
    expect(toMandarin('我忘记咗密码点样重设')).toBe('我忘记了密码怎么重置');
    expect(toMandarin('发票喺边度')).toBe('发票在哪里');
    expect(toMandarin('电邮点改')).toBe('邮箱 邮件怎么改');
    expect(toMandarin('影片播唔到')).toBe('视频播不了');
    expect(toMandarin('网站开唔到')).toBe('网站打不开');
    expect(toMandarin('唔记得密码')).toBe('忘记密码');
    expect(toMandarin('户口')).toBe('账号');
    expect(toMandarin('登出')).toBe('退出登录');
  });

  it('keeps Mandarin words that contain a Cantonese key (longest match first)', () => {
    expect(toMandarin('点击忘记密码')).toBe('点击忘记密码');
    expect(MANDARIN_VARIANTS['点击']).toBe('点击');
  });

  it('gives the Simplified text and, when different, its Mandarin rewrite', () => {
    expect(chineseSearchForms('密碼點樣重設')).toEqual([
      '密码点样重设',
      '密码怎么重置',
    ]);
    expect(chineseSearchForms('如何重置密码')).toEqual(['如何重置密码']);
    expect(chineseSearchForms('reset my password')).toEqual([
      'reset my password',
    ]);
  });
});

describe('Helpdesk FAQ search terms', () => {
  it('builds Simplified bigrams from Traditional and Cantonese text', () => {
    const { bigrams } = searchTerms('密碼點樣重設');
    expect(bigrams).toEqual(
      expect.arrayContaining(['密码', '重设', '重置', '怎么']),
    );
    expect(bigrams).not.toContain('密碼');
  });

  it('matches keywords against the original and the normalised text', () => {
    const { body } = searchTerms('收唔到驗證郵件 Help');
    expect(body).toContain('收唔到驗證郵件 help');
    expect(body).toContain('验证邮件');
    expect(body).toContain('收不了验证邮件');
  });

  it('keeps English words, prefixes and the tsquery as before', () => {
    expect(searchTerms('Reset my PASSWORD, ok?')).toEqual({
      tsquery: 'reset:* | my:* | password:* | ok:*',
      words: ['reset', 'password'],
      bigrams: [],
      body: 'reset my password, ok?',
      typo: typoKeys(['reset', 'my', 'password', 'ok']),
    });
  });

  it('reads full-width letters as ASCII', () => {
    expect(searchTerms('ｐａｓｓｗｏｒｄ').words).toEqual(['password']);
  });
});

describe('Helpdesk FAQ typo keys (symmetric delete)', () => {
  it('gives a word of five letters or more and each one-letter deletion', () => {
    expect(typoKeys(['reset'])).toEqual({
      keys: ['reset', 'eset', 'rset', 'reet', 'rest', 'rese'],
      word: [0, 0, 0, 0, 0, 0],
    });
  });

  it('gives a four-letter word only itself, and skips shorter words, digits and non-Latin', () => {
    expect(typoKeys(['plns', 'my', 'abc', 'v2', 'café', '密码'])).toEqual({
      keys: ['plns'],
      word: [0],
    });
  });

  it('numbers keys by word, once per word', () => {
    const { keys, word } = typoKeys(['pasword', 'emial', 'pasword']);
    expect(new Set(word)).toEqual(new Set([0, 1]));
    expect(keys.filter((_, i) => word[i] === 0)).toEqual(
      expect.arrayContaining(['pasword', 'psword', 'paswod']),
    );
    expect(keys.filter((_, i) => word[i] === 1)).toEqual(
      expect.arrayContaining(['emial', 'emal', 'emil']),
    );
  });

  it('shares a key with the right word for the usual typos (FAQ side uses the same rule)', () => {
    const faqSide = (word: string) => new Set(typoKeys([word]).keys);
    const near = (typo: string, word: string) =>
      typoKeys([typo]).keys.some((key) => faqSide(word).has(key));
    expect(near('pasword', 'password')).toBe(true); // 漏一个字母
    expect(near('resset', 'reset')).toBe(true); // 多一个字母
    expect(near('emial', 'email')).toBe(true); // 相邻对调
    expect(near('invoce', 'invoice')).toBe(true);
    expect(near('plns', 'plans')).toBe(true);
    expect(near('certifcate', 'certificate')).toBe(true);
    expect(near('refund', 'invoice')).toBe(false);
  });
});
