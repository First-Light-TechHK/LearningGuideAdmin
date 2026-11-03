import { extractDocxHeadings, normalizeDocxHtml } from './docx-to-html';

describe('normalizeDocxHtml', () => {
  it('promotes bold numbered paragraphs to h1', () => {
    const html =
      '<p><strong>1.1 状态变量与状态空间</strong></p>' +
      '<p><strong>1.2 Defining Vectors</strong></p>' +
      '<p>1.2 body text</p>';
    const out = normalizeDocxHtml(html);
    expect(out).toBe(
      '<h1>状态变量与状态空间</h1><h1>Defining Vectors</h1><p>1.2 body text</p>',
    );
  });

  it('keeps only the first heading when a number appears twice (bilingual doc)', () => {
    const html =
      '<p><strong>1.2 Defining Vectors</strong></p>' +
      '<p><strong>1.2 向量的定义</strong></p>';
    const out = normalizeDocxHtml(html);
    expect(out).toBe(
      '<h1>Defining Vectors</h1><p><strong>1.2 向量的定义</strong></p>',
    );
  });

  it('does not promote bold paragraphs without a number', () => {
    const html = '<p><strong>Key Concepts</strong></p>';
    expect(normalizeDocxHtml(html)).toBe(html);
  });

  it('unwraps single-cell tables used for figure + caption', () => {
    const html =
      '<table><tr><td><p>caption</p></td></tr></table><p>after</p>';
    expect(normalizeDocxHtml(html)).toBe('<p>caption</p><p>after</p>');
  });

  it('drops empty paragraphs left by conversion', () => {
    expect(normalizeDocxHtml('<p>a</p><p></p><p> </p>')).toBe('<p>a</p>');
  });

  it('returns an empty paragraph for empty input', () => {
    expect(normalizeDocxHtml('')).toBe('<p></p>');
  });
});

describe('extractDocxHeadings', () => {
  it('reads code and title from h1', () => {
    const html = '<h1>1.1 State Variables</h1><p>x</p><h1>Overview</h1>';
    expect(extractDocxHeadings(html)).toEqual([
      { code: '1.1', title: 'State Variables' },
      { code: '', title: 'Overview' },
    ]);
  });
});
