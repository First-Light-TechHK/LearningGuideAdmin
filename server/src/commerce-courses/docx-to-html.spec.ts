import JSZip from 'jszip';
import {
  convertDocxToHtml,
  extractDocxHeadings,
  normalizeDocxHtml,
} from './docx-to-html';

const PROMOTE = { promoteBoldNumbered: true } as const;

/** A .docx with one Heading 1 paragraph and one bold numbered paragraph. */
async function docxBytes(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '</Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  );
  zip.file(
    'word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>',
  );
  zip.file(
    'word/styles.xml',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>' +
      '</w:styles>',
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Real heading</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Body text.</w:t></w:r></w:p>' +
      '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>1.1 Bold numbered line</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>More text.</w:t></w:r></w:p>' +
      '</w:body></w:document>',
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('convertDocxToHtml', () => {
  it('turns only the Heading 1 style into an h1 for the editor', async () => {
    const result = await convertDocxToHtml(await docxBytes());
    expect(result.html).toContain('<h1>Real heading</h1>');
    expect(result.html.match(/<h1\b/g)).toHaveLength(1);
    expect(result.html).toContain('<strong>1.1 Bold numbered line</strong>');
  });

  it('still promotes bold numbered paragraphs for the raw material import', async () => {
    const result = await convertDocxToHtml(await docxBytes(), PROMOTE);
    expect(result.html.match(/<h1\b/g)).toHaveLength(2);
    expect(result.html).toContain('<h1>Bold numbered line</h1>');
  });
});

describe('normalizeDocxHtml', () => {
  it('promotes bold numbered paragraphs to h1 when asked to', () => {
    const html =
      '<p><strong>1.1 状态变量与状态空间</strong></p>' +
      '<p><strong>1.2 Defining Vectors</strong></p>' +
      '<p>1.2 body text</p>';
    const out = normalizeDocxHtml(html, PROMOTE);
    expect(out).toBe(
      '<h1>状态变量与状态空间</h1><h1>Defining Vectors</h1><p>1.2 body text</p>',
    );
  });

  it('leaves bold numbered paragraphs alone by default', () => {
    const html = '<p><strong>1.1 Not a heading</strong></p><p>text</p>';
    expect(normalizeDocxHtml(html)).toBe(html);
  });

  it('keeps only the first heading when a number appears twice (bilingual doc)', () => {
    const html =
      '<p><strong>1.2 Defining Vectors</strong></p>' +
      '<p><strong>1.2 向量的定义</strong></p>';
    const out = normalizeDocxHtml(html, PROMOTE);
    expect(out).toBe(
      '<h1>Defining Vectors</h1><p><strong>1.2 向量的定义</strong></p>',
    );
  });

  it('does not promote bold paragraphs without a number', () => {
    const html = '<p><strong>Key Concepts</strong></p>';
    expect(normalizeDocxHtml(html)).toBe(html);
  });

  it('unwraps single-cell tables used for figure + caption', () => {
    const html = '<table><tr><td><p>caption</p></td></tr></table><p>after</p>';
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
