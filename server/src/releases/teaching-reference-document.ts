import { BadRequestException } from '@nestjs/common';
import { DOMParser } from '@xmldom/xmldom';
import {
  Document,
  HeadingLevel,
  ImageRun,
  Math as WordMath,
  MathRun,
  Packer,
  Paragraph,
  TextRun,
} from 'docx';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { wordMathToLatex } from '../files/docx-math';
import {
  referenceImageBytes,
  referenceTransferLimits,
  type ReferenceKind,
} from './teaching-reference-limits';

export type { ReferenceKind } from './teaching-reference-limits';
export type ReferenceDocumentRow = {
  code: string;
  names: { en: string; zh: string };
  summary: { en: string; zh: string };
  displayName?: string;
  aliases?: string[];
  kind: ReferenceKind;
  value: string;
  bytes?: Buffer;
};
const base = 'http://schemas.openxmlformats.org/';
const word = base + 'wordprocessingml/2006/main';
const drawing = base + 'drawingml/2006/main';
const wordDrawing = base + 'drawingml/2006/wordprocessingDrawing';
const math = base + 'officeDocument/2006/math';
const relation = base + 'officeDocument/2006/relationships';
const rels = base + 'package/2006/relationships';
const docStyle = 'TeachingReferenceFile';
const originalPath = 'customXml/teaching-images.xml';
const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const fields = [
  'English name',
  'Chinese name',
  'English summary',
  'Chinese summary',
  'Display name',
  'Aliases',
  'LaTeX',
] as const;
function invalid(): never {
  throw new BadRequestException('TEACHING_REFERENCE_DOCUMENT_INVALID');
}

function labelled(label: string, value: string) {
  const [first, ...rest] = value.split('\n');
  return new Paragraph({
    children: [
      new TextRun(label + ': ' + first),
      ...rest.map((text) => new TextRun({ text, break: 1 })),
    ],
  });
}

export async function referenceDocument(
  kind: ReferenceKind,
  rows: ReferenceDocumentRow[],
) {
  const originals = new Map<string, { preview: string; data: Buffer }>();
  const children: Paragraph[] = [
    new Paragraph({
      style: docStyle,
      text: kind === 'latex' ? 'Formula references' : 'Image references',
    }),
  ];
  for (const row of rows) {
    children.push(
      new Paragraph({ heading: HeadingLevel.HEADING_3, text: row.code }),
      labelled('English name', row.names.en),
      labelled('Chinese name', row.names.zh),
      labelled('English summary', row.summary.en),
      labelled('Chinese summary', row.summary.zh),
    );
    if (row.displayName !== undefined)
      children.push(labelled('Display name', row.displayName));
    if (row.aliases?.length)
      children.push(labelled('Aliases', JSON.stringify(row.aliases)));
    if (kind === 'latex') {
      children.push(
        /^[A-Za-z0-9 +=*/().,-]+$/.test(row.value)
          ? new Paragraph({
              children: [new WordMath({ children: [new MathRun(row.value)] })],
            })
          : labelled('LaTeX', row.value),
      );
      continue;
    }
    const bytes = row.bytes;
    if (!bytes) invalid();
    const extension = row.value.split('.').at(-1)?.toLowerCase();
    const metadata = await sharp(bytes).metadata();
    const type =
      extension === 'jpg' ? 'jpg' : extension === 'gif' ? 'gif' : 'png';
    const preview =
      extension === 'webp'
        ? await sharp(bytes)
            .resize({
              width: 800,
              height: 800,
              fit: 'inside',
              withoutEnlargement: true,
            })
            .png()
            .toBuffer()
        : bytes;
    const originalHash = extension === 'webp' ? digest(bytes) : undefined;
    const previewHash = originalHash ? digest(preview) : undefined;
    if (originalHash && previewHash)
      originals.set(originalHash, { preview: previewHash, data: bytes });
    const ratio = Math.min(
      1,
      420 / Math.max(metadata.width, 1),
      320 / Math.max(metadata.height, 1),
    );
    children.push(
      new Paragraph({
        children: [
          new ImageRun({
            type,
            data: preview,
            altText: {
              name: row.code,
              description: originalHash
                ? 'TeachingOriginal:' + originalHash + ':' + previewHash
                : row.names.en,
            },
            transformation: {
              width: Math.max(1, Math.round(metadata.width * ratio)),
              height: Math.max(1, Math.round(metadata.height * ratio)),
            },
          }),
        ],
      }),
    );
  }
  const bytes = await Packer.toBuffer(
    new Document({
      styles: {
        paragraphStyles: [
          {
            id: docStyle,
            name: 'Teaching reference file',
            basedOn: 'Normal',
            run: { bold: true },
          },
        ],
      },
      sections: [{ children }],
    }),
  );
  if (!originals.size) return bytes;
  const zip = await JSZip.loadAsync(bytes);
  zip.file(
    originalPath,
    '<?xml version="1.0" encoding="UTF-8"?><teachingImages>' +
      [...originals]
        .map(
          ([hash, { preview, data }]) =>
            '<image preview="' +
            preview +
            '" original="' +
            hash +
            '">' +
            data.toString('base64') +
            '</image>',
        )
        .join('') +
      '</teachingImages>',
  );
  const relPath = 'word/_rels/document.xml.rels';
  const xml = await zip.file(relPath)!.async('string');
  zip.file(
    relPath,
    xml.replace(
      '</Relationships>',
      '<Relationship Id="rIdTeachingImageOriginals" Type="' +
        relation +
        '/customXml" Target="../' +
        originalPath +
        '"/></Relationships>',
    ),
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export async function readReferenceDocument(
  zip: JSZip,
): Promise<ReferenceDocumentRow[] | null> {
  const body = await zip.file('word/document.xml')?.async('string');
  if (!body?.includes(docStyle)) return null;
  const parser = new DOMParser();
  const root = parser.parseFromString(body, 'application/xml');
  const paras = Array.from(root.getElementsByTagNameNS(word, 'p'));
  const style = (p: (typeof paras)[number]) =>
    p
      .getElementsByTagNameNS(word, 'pStyle')
      .item(0)
      ?.getAttributeNS(word, 'val');
  const content = (p: (typeof paras)[number]) =>
    Array.from(p.getElementsByTagNameNS(word, '*'))
      .map((el) =>
        el.localName === 't'
          ? (el.textContent ?? '')
          : el.localName === 'br'
            ? '\n'
            : el.localName === 'tab'
              ? '\t'
              : '',
      )
      .join('');
  if (!paras[0] || style(paras[0]) !== docStyle) return null;
  const title = content(paras[0]);
  const kind =
    title === 'Formula references'
      ? 'latex'
      : title === 'Image references'
        ? 'image'
        : invalid();
  const relationXml = await zip
    .file('word/_rels/document.xml.rels')
    ?.async('string');
  const targets = new Map<string, string>();
  if (relationXml)
    for (const rel of Array.from(
      parser
        .parseFromString(relationXml, 'application/xml')
        .getElementsByTagNameNS(rels, 'Relationship'),
    )) {
      const target = rel.getAttribute('Target')?.replace(/^\/word\//, '');
      const id = rel.getAttribute('Id');
      if (
        id &&
        target &&
        /^media\/[^/\\]+$/.test(target) &&
        rel.getAttribute('Type') === relation + '/image' &&
        rel.getAttribute('TargetMode') !== 'External'
      )
        targets.set(id, target);
    }
  const originals = new Map<string, { preview: string; bytes: Buffer }>();
  const originalXml = await zip.file(originalPath)?.async('string');
  if (originalXml)
    for (const entry of Array.from(
      parser
        .parseFromString(originalXml, 'application/xml')
        .getElementsByTagName('image'),
    )) {
      const bytes = Buffer.from(entry.textContent ?? '', 'base64');
      const preview = entry.getAttribute('preview');
      const original = entry.getAttribute('original');
      if (
        !preview ||
        !/^[a-f0-9]{64}$/.test(preview) ||
        bytes.length > referenceImageBytes ||
        bytes.toString('ascii', 8, 12) !== 'WEBP' ||
        digest(bytes) !== original ||
        originals.has(original)
      )
        invalid();
      originals.set(original, { preview, bytes });
    }
  const rows: ReferenceDocumentRow[] = [];
  let row: ReferenceDocumentRow | undefined;
  const seen = new Set<string>();
  for (const p of paras.slice(1)) {
    const line = content(p);
    if (style(p) === 'Heading3') {
      row = {
        code: line,
        names: { en: '', zh: '' },
        summary: { en: '', zh: '' },
        kind,
        value: '',
      };
      rows.push(row);
      seen.clear();
      continue;
    }
    const pictures = Array.from(p.getElementsByTagNameNS(drawing, 'blip'));
    if (pictures.length) {
      if (!row || kind !== 'image' || row.bytes || pictures.length !== 1)
        invalid();
      const id = pictures[0].getAttributeNS(relation, 'embed') ?? '';
      const target = targets.get(id);
      const data = target && zip.file('word/' + target);
      if (!data) invalid();
      const preview = await data.async('nodebuffer');
      const description =
        p
          .getElementsByTagNameNS(wordDrawing, 'docPr')
          .item(0)
          ?.getAttribute('descr') ?? '';
      const marker = /^TeachingOriginal:([a-f0-9]{64}):([a-f0-9]{64})$/.exec(
        description,
      );
      if (marker && digest(preview) === marker[2]) {
        const original = originals.get(marker[1]);
        if (!original || original.preview !== marker[2]) invalid();
        row.bytes = original.bytes;
      } else row.bytes = preview;
    }
    const equations = Array.from(p.getElementsByTagNameNS(math, 'oMath'));
    if (equations.length) {
      if (
        !row ||
        kind !== 'latex' ||
        seen.has('LaTeX') ||
        equations.length !== 1
      )
        invalid();
      seen.add('LaTeX');
      row.value = wordMathToLatex(equations[0]);
    }
    if (!line.trim()) continue;
    if (!row) invalid();
    const field = fields.find((key) => line.startsWith(key + ': '));
    if (!field || seen.has(field)) invalid();
    seen.add(field);
    const value = line.slice(field.length + 2);
    switch (field) {
      case 'English name':
        row.names.en = value;
        break;
      case 'Chinese name':
        row.names.zh = value;
        break;
      case 'English summary':
        row.summary.en = value;
        break;
      case 'Chinese summary':
        row.summary.zh = value;
        break;
      case 'Display name':
        row.displayName = value;
        break;
      case 'Aliases': {
        let aliases: unknown;
        try {
          aliases = JSON.parse(value);
        } catch {
          invalid();
        }
        if (
          !Array.isArray(aliases) ||
          aliases.length > 80 ||
          !aliases.every(
            (item: unknown) =>
              typeof item === 'string' && item.length <= 80 && item.trim(),
          )
        )
          invalid();
        row.aliases = aliases;
        break;
      }
      case 'LaTeX':
        if (kind !== 'latex') invalid();
        row.value = value;
        break;
    }
  }
  if (rows.length > referenceTransferLimits[kind].rows) invalid();
  return rows;
}
