import { createHash } from 'node:crypto';

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
export const qaGeneration = (model: string) => 'teaching-v3:' + model;

export function qaTerms(text: string): string[] {
  const words = Array.from(segmenter.segment(text.normalize('NFKC')))
    .filter((word) => word.isWordLike)
    .flatMap(({ segment }) => {
      const normalized = segment.toLowerCase();
      return normalized === segment
        ? [normalized]
        : [normalized, 'case' + Buffer.from(segment).toString('hex')];
    });
  return [...new Set(words)];
}

interface SourceCard {
  cardId: string;
  type: string;
  approvedPayload?: {
    question?: string;
    answerMd?: string;
    code?: string;
  };
  bilingual?: {
    conceptLabel: { en: string };
    summary: { en: string };
    triggers: { en: string[] };
  };
  canonicalPoint?: string;
}

export interface QaPart {
  cardId: string;
  part: number;
  text: string;
  questionTerms: string;
  answerTerms: string;
  hash: string;
}

function answerSections(answer: string): string[] {
  if (answer.length <= 2400) return [answer];
  const result: string[] = [];
  // 标记从原答复计算，避免扫描切片时把代码块的结束标志当作开始。
  const protectedSpans = [
    ...answer.matchAll(
      /\x60\x60\x60[\s\S]*?\x60\x60\x60|~~~[\s\S]*?~~~|\$\$[\s\S]*?\$\$|!?\[[^\]\n]*\]\([^\s)]+\)/gu,
    ),
  ].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  let offset = 0;
  let rest = answer;
  while (rest.length > 2400) {
    const window = rest.slice(0, 2400);
    const boundary = Math.max(
      window.lastIndexOf('\n'),
      window.lastIndexOf('。'),
      window.lastIndexOf('. '),
    );
    let cut = boundary > 1000 ? boundary + 1 : window.length;
    if (/[\uD800-\uDBFF]/.test(rest[cut - 1])) cut--;
    const span = protectedSpans.find(
      ({ start, end }) => start < offset + cut && end > offset + cut,
    );
    if (span && span.end - span.start <= 3200)
      cut = span.start > offset ? span.start - offset : span.end - offset;
    result.push(rest.slice(0, cut));
    offset += cut;
    rest = rest.slice(cut);
  }
  if (rest) result.push(rest);
  return result;
}

export function qaParts(cards: SourceCard[]): QaPart[] {
  const rows: QaPart[] = [];
  for (const {
    cardId,
    type,
    approvedPayload,
    bilingual,
    canonicalPoint,
  } of cards) {
    if (bilingual && ['concept', 'misreading', 'ref_obj'].includes(type)) {
      const title = [
        approvedPayload?.code,
        bilingual.conceptLabel.en,
        ...bilingual.triggers.en,
      ]
        .filter(Boolean)
        .join('\n');
      const text = [
        ...new Set(
          [title, bilingual.summary.en, canonicalPoint].filter(Boolean),
        ),
      ].join('\n');
      if (text)
        rows.push({
          cardId,
          part: 0,
          text,
          hash: createHash('sha256').update(text).digest('hex'),
          questionTerms: qaTerms(title).join(' '),
          answerTerms: qaTerms(bilingual.summary.en).join(' '),
        });
      continue;
    }
    const { question, answerMd } = approvedPayload ?? {};
    if (type !== 'professor_qa' || !question?.trim() || !answerMd?.trim())
      continue;
    const inputs = [
      question,
      ...answerSections(answerMd).map((section) => question + '\n' + section),
    ];
    for (const [part, text] of inputs.entries()) {
      rows.push({
        cardId,
        part,
        text,
        hash: createHash('sha256').update(text).digest('hex'),
        questionTerms: part === 0 ? qaTerms(question).join(' ') : '',
        answerTerms: part === 0 ? qaTerms(answerMd).join(' ') : '',
      });
    }
  }
  return rows;
}
