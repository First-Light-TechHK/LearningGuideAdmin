import {
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  type ParagraphChild,
} from 'docx';

type ExportImage = { bytes: Buffer; type: 'png' | 'jpg' | 'gif' };

function dimensions(image: ExportImage): { width: number; height: number } {
  const bytes = image.bytes;
  let width = 480;
  let height = 270;
  if (image.type === 'png' && bytes.length >= 24) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (image.type === 'gif' && bytes.length >= 10) {
    width = bytes.readUInt16LE(6);
    height = bytes.readUInt16LE(8);
  } else if (image.type === 'jpg') {
    for (let i = 2; i + 9 < bytes.length;) {
      if (bytes[i] !== 0xff) break;
      const marker = bytes[i + 1];
      if (marker >= 0xc0 && marker <= 0xc3) {
        height = bytes.readUInt16BE(i + 5);
        width = bytes.readUInt16BE(i + 7);
        break;
      }
      const length = bytes.readUInt16BE(i + 2);
      if (length < 2) break;
      i += length + 2;
    }
  }
  if (!width || !height) return { width: 480, height: 270 };
  const scale = Math.min(1, 520 / width, 700 / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function textRuns(value: string): TextRun[] {
  const runs: TextRun[] = [];
  const pattern =
    /\*\*([^*]+)\*\*|(?<!\*)\*([^*]+)\*(?!\*)|(?<!\w)_([^_\n]+)_(?!\w)|`([^`]+)`/g;
  let start = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index > start)
      runs.push(new TextRun(value.slice(start, match.index)));
    runs.push(
      new TextRun({
        text: match[1] ?? match[2] ?? match[3] ?? match[4],
        bold: match[1] !== undefined,
        italics: match[2] !== undefined || match[3] !== undefined,
        font: match[4] !== undefined ? 'Consolas' : undefined,
      }),
    );
    start = match.index + match[0].length;
  }
  if (start < value.length || !runs.length)
    runs.push(new TextRun(value.slice(start)));
  return runs;
}

function inlineRuns(
  value: string,
  images: ReadonlyMap<string, ExportImage>,
): ParagraphChild[] {
  const runs: ParagraphChild[] = [];
  let start = 0;
  for (const match of value.matchAll(/!\[([^\]\n]*)\]\(([^\s)]+)\)/g)) {
    if (match.index > start)
      runs.push(...textRuns(value.slice(start, match.index)));
    const asset = images.get(match[2]);
    if (!asset) throw new Error(`Missing export image: ${match[2]}`);
    runs.push(
      new ImageRun({
        data: asset.bytes,
        type: asset.type,
        transformation: dimensions(asset),
        altText: { title: match[1], description: match[1] },
      }),
    );
    start = match.index + match[0].length;
  }
  if (start < value.length || !runs.length)
    runs.push(...textRuns(value.slice(start)));
  return runs;
}

/** 导出供现有 DOCX 上传器回读；无法表达的 Markdown 保留为原文字。 */
export async function renderMarkdownDocx(
  markdown: string,
  images: ReadonlyMap<string, ExportImage>,
): Promise<Buffer> {
  const paragraphs: Array<Paragraph | Table> = [];
  let fenced = false;
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      paragraphs.push(
        new Paragraph({
          children: [new TextRun({ text: line, font: 'Consolas' })],
        }),
      );
      continue;
    }
    if (
      line.trim().startsWith('|') &&
      /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(
        lines[index + 1] ?? '',
      )
    ) {
      const rows: string[][] = [];
      const cells = (value: string) =>
        value
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((cell) => cell.trim());
      rows.push(cells(line));
      index++;
      while (lines[index + 1]?.trim().startsWith('|'))
        rows.push(cells(lines[++index]));
      paragraphs.push(
        new Table({
          rows: rows.map(
            (row) =>
              new TableRow({
                children: row.map(
                  (cell) =>
                    new TableCell({
                      children: [
                        new Paragraph({ children: inlineRuns(cell, images) }),
                      ],
                    }),
                ),
              }),
          ),
        }),
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const levels = [
        HeadingLevel.HEADING_1,
        HeadingLevel.HEADING_2,
        HeadingLevel.HEADING_3,
        HeadingLevel.HEADING_4,
        HeadingLevel.HEADING_5,
        HeadingLevel.HEADING_6,
      ];
      paragraphs.push(
        new Paragraph({
          heading: levels[heading[1].length - 1],
          children: inlineRuns(heading[2], images),
        }),
      );
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (bullet) {
      paragraphs.push(
        new Paragraph({
          bullet: { level: 0 },
          children: inlineRuns(bullet[1], images),
        }),
      );
      continue;
    }
    const numbered = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (numbered) {
      paragraphs.push(
        new Paragraph({
          numbering: { reference: 'markdown-list', level: 0 },
          children: inlineRuns(numbered[1], images),
        }),
      );
      continue;
    }
    paragraphs.push(
      new Paragraph({
        children: inlineRuns(line.replace(/^>\s?/, ''), images),
      }),
    );
  }
  const doc = new Document({
    numbering: {
      config: [
        {
          reference: 'markdown-list',
          levels: [
            { level: 0, format: 'decimal', text: '%1.', alignment: 'start' },
          ],
        },
      ],
    },
    sections: [
      { children: paragraphs.length ? paragraphs : [new Paragraph('')] },
    ],
  });
  return Packer.toBuffer(doc);
}
