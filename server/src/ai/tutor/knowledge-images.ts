/** Image links come only from the selected Release evidence for this course. */
export interface KnowledgeImage {
  alt: string;
  url: string;
  context: string;
}

function terms(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  const han = text.match(/[\p{Script=Han}]+/gu) ?? [];
  return [
    ...words,
    ...han.flatMap((part) =>
      Array.from({ length: Math.max(0, part.length - 1) }, (_, i) =>
        part.slice(i, i + 2),
      ),
    ),
  ].filter(
    (term) =>
      ![
        '图片',
        '图示',
        '解释',
        '一下',
        '什么',
        '我们',
        '这个',
        '关于',
        '可以',
        '请问',
      ].includes(term),
  );
}

function overlap(left: string, right: string): number {
  const rightTerms = new Set(terms(right));
  return [...new Set(terms(left))].filter((term) => rightTerms.has(term))
    .length;
}

export function selectKnowledgeImages(
  context: string,
  courseId: string,
  question: string,
): KnowledgeImage[] {
  const images = new Map<string, KnowledgeImage>();
  for (const block of context.split('\n\n')) {
    let evidence: unknown;
    try {
      evidence = (JSON.parse(block) as { evidence?: unknown }).evidence;
    } catch {
      continue;
    }
    if (typeof evidence !== 'string') continue;
    for (const match of evidence.matchAll(
      /!\[([^\]\n]*)\]\((\/api\/files\/images\/[^\s)]+)\)/g,
    )) {
      const [, alt, url] = match;
      const parts =
        /^\/api\/files\/images\/([^/]+)\/([0-9a-f-]{36})\.(png|jpg|gif|webp)$/i.exec(
          url,
        );
      if (
        !parts ||
        parts[1] !== courseId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          parts[2],
        )
      )
        continue;
      const nearby = evidence
        .slice(
          Math.max(0, match.index - 180),
          match.index + match[0].length + 180,
        )
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
      images.set(url, { alt, url, context: `${alt} ${nearby}` });
    }
  }
  return [...images.values()]
    .map((image) => ({ image, score: overlap(question, image.context) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map(({ image }) => image);
}

export function imageAfterParagraph(
  paragraph: string,
  image: KnowledgeImage,
): string {
  const label = image.alt.trim();
  const matchesLabel =
    label.length >= 3 && paragraph.toLowerCase().includes(label.toLowerCase());
  if (!matchesLabel && overlap(paragraph, image.context) < 2) return '';
  const escaped = image.alt
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
  return `\n\n![${escaped}](${image.url})`;
}
