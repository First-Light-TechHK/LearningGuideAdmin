import { retrievalTerms } from '../../common/retrieval-terms';
import { wikiTeachingReferenceIds } from '../../ks/contract/teaching-references';
import { readLectureReferences } from './lecture-references';
import type { ReviewedTeachingCard } from './reviewed-package-validator';

export function lectureExhibits(cards: ReviewedTeachingCard[]) {
  return cards
    .filter((card) => card.type === 'ref_obj')
    .flatMap((card) => {
      const meta = card.approvedPayload as Record<string, unknown>;
      return readLectureReferences(meta).map((ref) => ({
        ref,
        cardId: card.cardId,
        names: Object.values(card.bilingual.conceptLabel).filter(Boolean),
        summary: card.bilingual.summary,
      }));
    });
}

export type LectureExhibit = ReturnType<typeof lectureExhibits>[number];
export function exhibitDisplay(message: string) {
  if (
    /\b(?:in )?one sentence\b.*\bwithout examples? or (?:a |any )?(?:diagram|image|picture)\b/i.test(
      message,
    )
  )
    return 'words';
  if (
    /只(?:用|能用)文字|仅(?:用|以)文字|纯文字|只用一句话[^。]*不用配图|\b(?:in |use )?(?:words|text) only\b|\bonly (?:in |use )?(?:words|text)\b/i.test(
      message,
    )
  )
    return 'words';
  if (
    /(?:不用|不要|无需|不必|不需要)(?:展示|显示|使用|附|配)?(?:任何)?图|\b(?:no|without|omit|skip|do not (?:show|include)|don't (?:show|include)) (?:examples? (?:or|and) )?(?:an? |any |the )?(?:diagram|image|figure|picture|illustration)s?\b/i.test(
      message,
    )
  )
    return 'no-image';
  if (
    /(?:展示|出示|看看|显示|给我看)[^。？！\n]{0,65}(?:图|箭头)|(?:show|display|pull up|bring up|use)\b[^.?!\n]{0,95}\b(?:figure|diagram|picture|image|exhibit|plot|graph|illustration|chart)\b/i.test(
      message,
    )
  )
    return 'image';
  return 'auto';
}
const normalize = (text: string) => text.normalize('NFKC').toLowerCase();
const example = /举例|例子|例如|比如|为例|example|illustrat/i;
const imageFollowUp =
  /这[张幅个]?图|那[张幅个]?图|图中|图里|图上|上图|该图|横轴|纵轴|曲线|this (?:image|figure|diagram|graph|exhibit)|the (?:image|figure|diagram|graph|axis)|what does .+ stand for/i;
const formulaFollowUp =
  /(?:这|那|该|上)(?:个|条|道)?(?:公式|式子|等式)|式中|式里|公式[中里]|撇号|\b(?:this|that|previous|the) (?:equation|formula|expression)\b|prime (?:symbol|mean)/i;
export function followUpKind(text: string) {
  if (formulaFollowUp.test(text)) return 'latex';
  if (
    /what does .+ stand for|这个符号|该符号|这里的|这里为什么|what about (?:the )?symbol/i.test(
      text,
    )
  )
    return 'any';
  if (imageFollowUp.test(text)) return 'image';
  return undefined;
}

export function hasExplicitFormula(text: string) {
  const normalized = normalize(text);
  // 一个孤立字母可以是上图的符号，运算式或赋值才足以独立检索。
  if (!/公式|式子|等式|\b(?:formula|equation|expression)\b/i.test(normalized))
    return false;
  if (/(?:\b[a-z]|\d|\))\s*[=+*/^×÷−-]\s*[(a-z0-9]/i.test(normalized))
    return true;
  if (
    /(?:这|那|该|上)(?:一?[个条道])?(?:公式|式子|等式)|(?:^|[，。？\s]|请问|解释|说明)(?:在)?公式[中里]/u.test(
      normalized,
    )
  )
    return false;
  return (
    /\p{Script=Han}{2,}公式[中里]/u.test(normalized) ||
    /\b(?:in|of|using) (?:the )?(?!(?:the|this|that|previous)\b)[\w'-]+ (?:formula|equation)\b/i.test(
      normalized,
    )
  );
}

// Keep a broad subject such as "state variables" from selecting every specific illustration.
export function matchExhibits(
  items: LectureExhibit[],
  message: string,
  previous = '',
) {
  const query = normalize(message);
  // Include clues late in a question and preserve course symbols and numeric coordinates.
  const tokenize = (text: string) =>
    new Set(
      [
        ...text
          .split(/[，。？,;?!]|\s+(?:and|with|that|which)\s+/i)
          .flatMap(retrievalTerms),
        ...(text.match(/\b[a-z]\b|\b\d+(?:\.\d+)?\b/g) ?? []),
        ...Array.from(text.matchAll(/(?=(\p{Script=Han}{2}))/gu), (m) => m[1]),
      ].filter(
        (t) =>
          !/^(?:a|i|the|it|at|as|on|图中|课程|please|show|figure|diagram|lesson|from|for|does|are|its|this|what|can|how|which)$/.test(
            t,
          ),
      ),
    );
  const terms = [...tokenize(query)];
  const documents = items.map((item) =>
    tokenize(
      normalize([...item.names, ...Object.values(item.summary)].join(' ')),
    ),
  );
  const frequencies = new Map<string, number>();
  for (const doc of documents)
    for (const term of doc)
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  const contextual = example.test(query);
  const combined = new Set([
    ...terms,
    ...(contextual ? retrievalTerms(previous) : []),
  ]);
  const requestedImage = exhibitDisplay(message) === 'image';
  const rowCount =
    /(\d+)(?:[- ]rows?\b|\s*行)|\b(two|three|four)[- ]rows?\b|([二两三四])行/.exec(
      query,
    );
  const rowNames: Record<string, number> = {
    two: 2,
    three: 3,
    four: 4,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
  };
  const columnRows =
    rowCount && (Number(rowCount[1]) || rowNames[rowCount[2] ?? rowCount[3]]);
  const timedColumn =
    /column vector|列向量/.test(query) &&
    /time (?:argument|parameter|dependence)|时间(?:参数|变量)|\(t\)/.test(
      query,
    );
  const magnitude =
    /euclidean (?:length|norm)|欧氏长度|\bmagnitude of\b|的模是多少/.test(
      query,
    );
  const coordinates = query.match(
    /\(\s*([+−-]?\d+(?:\.\d+)?)\s*[,，]\s*([+−-]?\d+(?:\.\d+)?)\s*\)/,
  );
  const ranked = items.map((item, index) => {
    let score = 0;
    for (const name of item.names) {
      const normalized = normalize(name);
      const words = [...tokenize(normalized)];
      const hits = words.filter((term) => terms.includes(term));
      if (normalized && query.includes(normalized))
        score = Math.max(score, 100);
      else if (words.length && hits.length === words.length)
        score = Math.max(score, 80);
      else if (
        contextual &&
        hits.length &&
        words.every((term) => combined.has(term))
      )
        score = Math.max(score, 70);
      else if (
        contextual &&
        hits.length &&
        !items.some(
          (other) =>
            other !== item &&
            other.names.some((n) =>
              hits.every((term) => normalize(n).includes(term)),
            ),
        )
      )
        score = Math.max(score, 45);
    }
    let detailScore = 0;
    for (const term of terms) {
      if (!documents[index].has(term)) continue;
      const frequency = frequencies.get(term)!;
      detailScore += Math.log2((items.length + 1) / frequency);
    }
    // Ordinary concept questions need stronger evidence than generic summary vocabulary.
    if (!requestedImage && item.ref.kind === 'latex' && detailScore > 0) {
      const matrix = /\\begin\{([bp]?matrix)\}([\s\S]*?)\\end\{\1\}/.exec(
        item.ref.value,
      );
      if (
        timedColumn &&
        columnRows &&
        matrix &&
        /\(t\)/.test(matrix[2]) &&
        !matrix[2].includes('&') &&
        matrix[2].split(/\\\\/).length === columnRows &&
        terms.some(
          (term) =>
            documents[index].has(term) &&
            term.length >= 2 &&
            !/vector|向量|状态|state|column|three|four|time|时间|^参数$/.test(
              term,
            ),
        )
      ) {
        score = Math.max(score, 110 + Math.min(detailScore, 30));
      }
      if (
        magnitude &&
        /\\sqrt/.test(item.ref.value) &&
        item.names.some((name) => /magnitude|euclidean|的模|欧氏/i.test(name))
      ) {
        // Component order can change, but a worked example still needs the same signed values.
        const values = [
          ...item.ref.value.matchAll(
            /(?<![\d.-])\(?(-?\d+(?:\.\d+)?)\)?\^\{?2\b/g,
          ),
        ]
          .map((m) => Number(m[1]))
          .sort();
        if (
          !values.length ||
          (coordinates &&
            values.join() ===
              coordinates
                .slice(1)
                .map((n) => Number(n.replace('−', '-')))
                .sort()
                .join())
        )
          score = Math.max(score, 110 + Math.min(detailScore, 30));
        else if (coordinates) return { item, score: 0 };
      }
    }
    if (requestedImage)
      score = (score >= 80 ? 10 : 0) + (detailScore >= 3 ? detailScore : 0);
    else if (
      terms.filter((t) => /^[a-z]$/.test(t) && documents[index].has(t))
        .length >= 2 &&
      item.names.some((name) =>
        retrievalTerms(name).some((t) => terms.includes(t)),
      )
    )
      score = Math.max(score, 65);
    return {
      item,
      score: score
        ? score + (requestedImage ? 0 : Math.min(detailScore, 20) / 100)
        : 0,
    };
  });
  const best = Math.max(0, ...ranked.map((hit) => hit.score));
  return ranked
    .filter((hit) => best && hit.score === best)
    .map((hit) => hit.item);
}

export function exhibitEvidence(items: LectureExhibit[]) {
  return items
    .map(({ ref, names, summary }) =>
      JSON.stringify({
        id: ref.id,
        kind: ref.kind,
        code: ref.code,
        label: ref.label,
        names,
        summary,
        ...(ref.kind === 'latex' ? { latex: ref.value } : {}),
      }),
    )
    .join('\n');
}

/** RAG can select a digest even when the author linked the exhibit in a different lesson. */
export function linkedExhibitPassage(
  pages: ReadonlyArray<{ title: string; contentMd?: string | null }>,
  id: string,
  onSelected?: (title: string, evidence: string) => void,
) {
  for (const page of pages) {
    if (!page.contentMd?.includes(`(refobj:${id})`)) continue;
    const paragraphs = page.contentMd.split(/\r?\n\s*\r?\n/);
    const index = paragraphs.findIndex((p) =>
      wikiTeachingReferenceIds(p).includes(id),
    );
    if (index >= 0) {
      const body = [
        paragraphs[index - 1]?.slice(-450),
        paragraphs[index].slice(0, 900),
        paragraphs[index + 1]?.slice(0, 450),
      ]
        .filter(Boolean)
        .join('\n');
      const evidence = body.replace(
        /!?\[([^\]\n]*)\]\(refobj:[a-z0-9-]+\)/g,
        '$1',
      );
      onSelected?.(page.title, evidence);
      return JSON.stringify({
        source: page.title,
        linkedExhibit: id,
        evidence,
      });
    }
  }
  return '';
}

export function exhibitsForAnswer(
  items: LectureExhibit[],
  answer: string,
  passages: string[],
) {
  const prose = answer.split(
    /\n(?:\*\*)?(?:Sources|来源)(?:\*\*)?\s*[:：]?\s*\n/i,
    1,
  )[0];
  const ids = new Set<string>();
  for (const citation of prose.matchAll(/\[(S?\d+(?:\s*[,，]\s*S?\d+)*)\]/gi)) {
    for (const number of citation[1].match(/\d+/g) ?? []) {
      const linked = wikiTeachingReferenceIds(
        passages[Number(number) - 1] ?? '',
      );
      if (linked.length === 1) ids.add(linked[0]);
    }
  }
  return items.filter((item) => ids.has(item.ref.id));
}

export function previousExhibitIds(
  history: ReadonlyArray<{ role: string; content: string }>,
  releaseId: string,
) {
  const entry = history.findLast((item) => item.role === 'assistant');
  if (!entry) return [];
  return [
    ...new Set(
      [
        ...entry.content.matchAll(
          /^\[exhibit:([\w-]+):([\w-]+)\]: (?:\/api\/|#(?:formula|focus)\b)/gm,
        ),
      ]
        .filter((match) => match[1] === releaseId)
        .map((match) => match[2]),
    ),
  ];
}
