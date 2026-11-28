import { createHash } from 'node:crypto';
import { answerSections } from '../common/markdown-sections';

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
export const qaGeneration = (model: string) => 'teaching-v4:' + model;

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
    definitionName?: string;
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

export function qaParts(cards: SourceCard[]): QaPart[] {
  const rows: QaPart[] = [];
  for (const {
    cardId,
    type,
    approvedPayload,
    bilingual,
    canonicalPoint,
  } of cards) {
    const { definitionName, question, answerMd } = approvedPayload ?? {};
    if (type === 'concept' && definitionName?.trim() && answerMd?.trim()) {
      const titleTerms = qaTerms(definitionName).join(' ');
      for (const [index, section] of answerSections(answerMd).entries()) {
        const text = definitionName + '\n' + section;
        rows.push({
          cardId,
          // Positive teaching parts distinguish full definitions from older teaching rows.
          part: index + 1,
          text,
          hash: createHash('sha256').update(text).digest('hex'),
          questionTerms: titleTerms,
          answerTerms: qaTerms(section).join(' '),
        });
      }
      continue;
    }
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
