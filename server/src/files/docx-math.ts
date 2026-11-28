import { BadRequestException } from '@nestjs/common';
import { DOMParser, XMLSerializer, type Element } from '@xmldom/xmldom';
import { randomUUID } from 'node:crypto';
import type JSZip from 'jszip';

const mathNs = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const wordNs = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function unsupported(kind: string): never {
  throw new BadRequestException(`DOCX 包含暂不支持的 Word 公式结构（${kind}）`);
}

function mathText(value: string): string {
  const symbols: Record<string, string> = {
    '\\': '\\backslash ',
    '^': '\\textasciicircum{}',
    '~': '\\sim ',
    '|': '\\vert ',
    '<': '\\lt ',
    '>': '\\gt ',
    β: '\\beta ',
    '≈': '\\approx ',
    '…': '\\ldots ',
    '\u00a0': ' ',
  };
  return value.replace(
    /[\\^~|<>β≈…\u00a0{}$&#%_]/gu,
    (ch) => symbols[ch] ?? '\\' + ch,
  );
}

function delimiter(value: string): string {
  if (['(', ')', '[', ']'].includes(value)) return value;
  const delimiters: Record<string, string> = {
    '': '.',
    '{': '\\{',
    '}': '\\}',
    '|': '\\vert ',
    '‖': '\\Vert ',
    '⟨': '\\langle ',
    '⟩': '\\rangle ',
  };
  return delimiters[value] ?? unsupported(value);
}

export function wordMathToLatex(node: Element): string {
  const children = Array.from(node.children).filter(
    (c) => c.namespaceURI === mathNs,
  );
  const fields = (tag: string) => children.filter((c) => c.localName === tag);
  const field = (tag: string) => fields(tag).map(wordMathToLatex).join('');
  const property = (tag: string, fallback: string) =>
    Array.from(fields(node.localName + 'Pr')[0]?.children ?? [])
      .find((c) => c.localName === tag)
      ?.getAttributeNS(mathNs, 'val') ?? fallback;
  switch (node.localName) {
    case 't':
      return mathText(node.textContent ?? '');
    case 'r': {
      const text = field('t');
      return fields('rPr')[0]?.getElementsByTagNameNS(mathNs, 'nor').length
        ? `\\text{${text}}`
        : text;
    }
    case 'oMath':
    case 'e':
    case 'num':
    case 'den':
    case 'sup':
    case 'sub':
    case 'deg':
      return children.map(wordMathToLatex).join('');
    case 'f':
      if (property('type', 'bar') !== 'bar')
        unsupported('f/' + property('type', 'bar'));
      return `\\frac{${field('num')}}{${field('den')}}`;
    case 'sSub':
    case 'sSup':
    case 'sSubSup': {
      const sub = field('sub');
      const sup = field('sup').replace(/^('+)$|^(′+)$/u, (marks) =>
        '\\prime '.repeat(marks.length),
      );
      return (
        '{' +
        field('e') +
        '}' +
        (sub ? `_{${sub}}` : '') +
        (sup ? `^{${sup.trim()}}` : '')
      );
    }
    case 'rad': {
      const degree = field('deg');
      return `\\sqrt${degree ? '[' + degree + ']' : ''}{${field('e')}}`;
    }
    case 'acc': {
      const accents: Record<string, string> = {
        '⃗': 'vec',
        '⃑': 'overrightharpoon',
        '̂': 'hat',
        '̇': 'dot',
        '̈': 'ddot',
        '̄': 'bar',
        '̃': 'tilde',
      };
      const symbol = property('chr', '̂');
      return `\\${accents[symbol] ?? unsupported('acc/' + symbol)}{${field('e')}}`;
    }
    case 'd':
      return (
        '\\left' +
        delimiter(property('begChr', '(')) +
        fields('e')
          .map(wordMathToLatex)
          .join(mathText(property('sepChr', '|'))) +
        '\\right' +
        delimiter(property('endChr', ')'))
      );
    case 'm':
      return (
        '\\begin{matrix}' +
        fields('mr').map(wordMathToLatex).join(' \\\\ ') +
        '\\end{matrix}'
      );
    case 'mr':
      return fields('e')
        .map((cell) => '{' + wordMathToLatex(cell) + '}')
        .join(' & ');
    case 'eqArr':
      return (
        '\\begin{gathered}' +
        fields('e')
          .map((row) => '{' + wordMathToLatex(row) + '}')
          .join(' \\\\ ') +
        '\\end{gathered}'
      );
    default:
      return unsupported(node.localName ?? node.tagName);
  }
}

/** 使用普通文本占位，避免 DOCX → HTML → Markdown 的中间步骤吞掉公式或转义 LaTeX。 */
export async function prepareDocxMath(zip: JSZip, original: Buffer) {
  const prefix = 'WordMath' + randomUUID().replaceAll('-', '') + 'N';
  const formulas: { body: string; display: boolean }[] = [];
  const part = zip.file('word/document.xml');
  if (part) {
    const xml = await part.async('string');
    if (xml.includes(mathNs) && /<(?:[\w.-]+:)?oMath[\s/>]/.test(xml)) {
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      const equations = Array.from(doc.getElementsByTagNameNS(mathNs, 'oMath'));
      const paragraphs = Array.from(
        doc.getElementsByTagNameNS(mathNs, 'oMathPara'),
      );
      for (const equation of equations) {
        const body = wordMathToLatex(equation).trim();
        if (!body) unsupported('空公式');
        const parent = equation.parentElement;
        const display =
          parent?.localName === 'oMathPara' ||
          (parent?.localName === 'p' &&
            Array.from(parent.children).every(
              (child) =>
                child === equation ||
                (child.namespaceURI === wordNs && child.localName === 'pPr'),
            ));
        const index = formulas.push({ body, display }) - 1;
        const run = doc.createElementNS(wordNs, 'w:r');
        const text = doc.createElementNS(wordNs, 'w:t');
        text.appendChild(doc.createTextNode(prefix + index + 'End'));
        run.appendChild(text);
        equation.parentNode!.replaceChild(run, equation);
      }
      for (const paragraph of paragraphs) {
        const parent = paragraph.parentNode!;
        for (const run of Array.from(paragraph.children)) {
          if (run.namespaceURI === wordNs) parent.insertBefore(run, paragraph);
        }
        parent.removeChild(paragraph);
      }
      if (equations.length)
        zip.file(part.name, new XMLSerializer().serializeToString(doc));
    }
  }
  return {
    buffer: formulas.length
      ? await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
      : original,
    restore(markdown: string) {
      if (!formulas.length) return markdown;
      const seen = new Set<number>();
      let tableDepth = 0;
      const result = markdown.replace(
        new RegExp('<table\\b[^>]*>|</table>|' + prefix + '(\\d+)End', 'gi'),
        (match: string, id: string | undefined, offset: number) => {
          if (id === undefined) {
            tableDepth += match.startsWith('</') ? -1 : 1;
            return match;
          }
          const index = Number(id);
          const { body, display } = formulas[index];
          seen.add(index);
          if (tableDepth > 0) {
            const escaped = body
              .replaceAll('&', '&amp;')
              .replaceAll('<', '&lt;')
              .replaceAll('>', '&gt;');
            return `<code class="language-math math-${display ? 'display' : 'inline'}">${escaped}</code>`;
          }
          if (
            display &&
            !markdown
              .slice(markdown.lastIndexOf('\n', offset - 1) + 1, offset)
              .trim()
          )
            return '\n\n$$\n' + body + '\n$$\n\n';
          const next = markdown[offset + match.length] ?? '';
          return '$' + body + '$' + (/[A-Za-z0-9]/.test(next) ? ' ' : '');
        },
      );
      if (seen.size !== formulas.length)
        throw new BadRequestException(
          `DOCX 公式导入不完整（${seen.size}/${formulas.length}），请检查原文`,
        );
      return result.trim();
    },
  };
}
