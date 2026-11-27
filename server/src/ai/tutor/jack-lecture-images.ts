import type { KnowledgeReleasePage } from '../../ks/contract/knowledge-client';
import type { KnowledgeImage } from './knowledge-images';

const FIGURE =
  /(?:\b(?:exhibit|fig(?:ure)?\.?)\s*|(?:图|展品)\s*)(\d+(?:\.\d+)*)/i;
const NO_IMAGE =
  /(?:只用文字|仅用文字|仅文字|纯文字|(?:不要|不用|无需|不需要|不必|不配|不附|不展示|不显示)[^。？！\n]{0,12}(?:图|配图))|\b(?:text[- ]only|(?:only|just) (?:use )?(?:text|words)|(?:in )?words only|(?:no|without|omit|skip|do not|don't|don’t)\b[^.?!\n]{0,45}\b(?:illustrations?|images?|pictures?|diagrams?|figures?|graphs?|exhibits?))\b/i;
const REQUEST =
  /(?:展示|显示|出示|给我看|配上|画出|看看).{0,60}(?:图|展品)|(?:图|展品).{0,12}(?:展示|显示)|\b(?:show|display|include|draw|use|see)\b[^.?!\n]{0,90}\b(?:image|picture|diagram|figure|graph|exhibit|illustration)\b/i;
const GENERIC = new Set(
  'the a an of to is does and its it in on for at this that with from what how can show course lesson figure diagram exhibit image picture graph state 哪个 展示 课程 课件 请问 这个 什么 解释 一个 为什么 图中 状态'.split(
    ' ',
  ),
);

function terms(text: string) {
  const tokens =
    text
      .toLowerCase()
      .match(/[a-z]+(?:-[a-z]+)*|\d+(?:\.\d+)?|[\p{Script=Han}]+/gu) ?? [];
  return new Set(
    tokens
      .flatMap((token) => {
        if (!/\p{Script=Han}/u.test(token)) return token.split('-');
        return Array.from({ length: token.length - 1 }, (_, i) =>
          token.slice(i, i + 2),
        );
      })
      .filter((term) => !GENERIC.has(term)),
  );
}

interface Figure extends KnowledgeImage {
  source: string;
  title: string;
  number?: string;
  caption: string;
}

function figures(pages: KnowledgeReleasePage[], courseId: string) {
  const found = new Map<string, Figure>();
  for (const page of pages) {
    const body = page.contentMd ?? '';
    const pattern =
      /!\[((?:\\.|[^\]\\\n])*)\]\((\/api\/files\/images\/([^/\s]+)\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(?:png|jpe?g|gif|webp))\)/gi;
    for (const match of body.matchAll(pattern)) {
      const [, rawAlt, url, owner] = match;
      if (owner !== courseId) continue;
      const alt = rawAlt.replace(/\\([\\[\]])/g, '$1');
      // 图号取自本图标题或紧邻的题注，避免把同页下一张图的编号绑定到当前资源。
      const before =
        body
          .slice(Math.max(0, match.index - 400), match.index)
          .trimEnd()
          .split('\n')
          .at(-1) ?? '';
      const after = body
        .slice(
          match.index + match[0].length,
          match.index + match[0].length + 720,
        )
        .split(/!\[|\n#{1,6} /, 1)[0]
        .trim();
      const caption = after.split('\n', 1)[0];
      const number = [alt, before, caption, page.title]
        .map((s) => FIGURE.exec(s)?.[1])
        .find(Boolean);
      const figure = {
        alt,
        url,
        number,
        title: [
          alt.split(/\s[—–]\s/)[0],
          FIGURE.test(before) ? before : '',
        ].join(' '),
        caption,
        source: page.title,
        context: [before, alt, after].join('\n').trim(),
      };
      if (!found.has(url) || number) found.set(url, figure);
    }
  }
  return [...found.values()];
}

function evidencePages(context: string): KnowledgeReleasePage[] {
  return context.split('\n\n').flatMap((block) => {
    try {
      const item = JSON.parse(block) as { source?: string; evidence?: string };
      return typeof item.evidence === 'string'
        ? [{ title: item.source ?? '', contentMd: item.evidence }]
        : [];
    } catch {
      return [];
    }
  });
}

export function jackLectureImage(
  question: string,
  courseId: string,
  pages: KnowledgeReleasePage[],
  context: string,
) {
  if (NO_IMAGE.test(question)) return { requested: false };
  const number = FIGURE.exec(question)?.[1];
  const requested = Boolean(number) || REQUEST.test(question);
  const candidates = figures(
    requested ? pages : evidencePages(context),
    courseId,
  );
  if (number) {
    const matches = candidates.filter((image) => image.number === number);
    return { requested, image: matches.length === 1 ? matches[0] : undefined };
  }

  const query = terms(question);
  const indexed = candidates.map((image) => ({
    image,
    title: terms(image.title),
    description: terms([image.title, image.alt, image.caption].join(' ')),
  }));
  const frequency = new Map<string, number>();
  for (const { description } of indexed) {
    for (const term of description) {
      frequency.set(term, (frequency.get(term) ?? 0) + 1);
    }
  }
  const ranked = indexed
    .map(({ image, title, description }) => {
      let score = 0;
      let matches = 0;
      for (const term of query) {
        if (!(requested ? description : title).has(term)) continue;
        const count = frequency.get(term) ?? 0;
        const weight = /^\d/.test(term) ? 4 : title.has(term) ? 2 : 1;
        score += weight * (1 + Math.log((indexed.length + 1) / (count + 1)));
        matches++;
      }
      return { image, score, matches };
    })
    .sort((a, b) => b.score - a.score);
  const [best, runnerUp] = ranked;
  // 单个普通词不足以选图。唯一的明确题名可兼容旧课件的短 alt。
  const named = best?.image.alt
    .split(/[·—–]/)
    .some(
      (name) =>
        name.trim().length >= 3 &&
        question.toLowerCase().includes(name.trim().toLowerCase()),
    );
  const image =
    best && (best.matches >= 2 || named) && best.score > (runnerUp?.score ?? 0)
      ? best.image
      : undefined;
  return { requested, image };
}
