import type { KnowledgeRelease } from '../../ks/contract/knowledge-client';
import type { LectureLanguage } from './lecture-language';

const questionId =
  /(?<![a-z0-9_])(?:q|question)\s*(\d+)(?![a-z0-9_]|\.\d)|第\s*(\d+)\s*题/gi;
const questionLine =
  /^[ \t#*]*(?:(?:Q|Question)[ \t]*(\d+)|第[ \t]*(\d+)[ \t]*题)[ \t]*(?:[:、]|\.(?!\d))[ \t*]*(.+)$/i;
const scopeId =
  /\b(chapter|unit|lesson|section)[\s_-]*(\d+)\b|第\s*([零〇一二两三四五六七八九十\d]+)\s*(章|单元|课|节)/gi;
const scopeWords: Record<string, string> = {
  章: 'chapter',
  单元: 'unit',
  课: 'lesson',
  节: 'section',
};

export interface PublishedQuestion {
  page: string;
  headings: string[];
  title: string;
  body: string;
  line: number;
}

// 同号题可能出现在同一发布页，补充说明只取独立于编号练习的课文。
export function beforePublishedQuestions(text: string) {
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((line) =>
    questionLine.test(line.normalize('NFKC')),
  );
  return first < 0 ? text : lines.slice(0, first).join('\n');
}

function ordinal(value: string) {
  if (/^\d+$/.test(value)) return String(Number(value));
  const digits = '零一二三四五六七八九';
  const parts = value.replaceAll('两', '二').replaceAll('〇', '零').split('十');
  if (parts.length === 1)
    return parts[0].replace(/./g, (c) => String(digits.indexOf(c)));
  return String(
    (parts[0] ? digits.indexOf(parts[0]) : 1) * 10 +
      (parts[1] ? digits.indexOf(parts[1]) : 0),
  );
}

function normalizeScope(text: string) {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(
      scopeId,
      (_all, english: string, number: string, chinese: string, unit: string) =>
        ' ' +
        (english ?? scopeWords[unit]) +
        ' ' +
        ordinal(number ?? chinese) +
        ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

// 以发布页为准，索引中的重叠分块不产生额外候选。
function publishedQuestions(id: string, pages: KnowledgeRelease['pages']) {
  const found: PublishedQuestion[] = [];
  for (const page of pages) {
    const headings: string[] = [];
    let active: PublishedQuestion | undefined;
    let fence = '';
    let questionDepth = 0;
    for (const [index, line] of (page.contentMd ?? '')
      .split(/\r?\n/)
      .entries()) {
      const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence || delimiter) {
        if (active) active.body += '\n' + line;
        if (!fence && delimiter) fence = delimiter;
        else if (delimiter?.startsWith(fence) && line.trim() === delimiter)
          fence = '';
        continue;
      }
      const question = questionLine.exec(line.normalize('NFKC'));
      if (question) {
        active = undefined;
        questionDepth = /^ {0,3}(#{1,6})\s+/.exec(line)?.[1].length ?? 0;
        if (questionDepth && headings.length >= questionDepth)
          headings.length = questionDepth - 1;
        if ((question[1] ?? question[2]) === id) {
          active = {
            page: page.title,
            headings: headings.filter(Boolean),
            title: question[3].replace(/\*+$/, '').trim(),
            body: line,
            line: index + 1,
          };
          found.push(active);
        }
        continue;
      }
      const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (active && heading) {
        const solution =
          /^(?:A(?:nswer)?[ \t]*(\d+)|Answer|Solution|答案|解答)\s*(?:$|[:：.、])/i.exec(
            heading[2],
          );
        if (solution && (!solution[1] || solution[1] === id)) {
          active.body += '\n' + line;
          continue;
        }
      }
      if (heading && questionDepth && heading[1].length > questionDepth) {
        if (active) active.body += '\n' + line;
        continue;
      }
      if (heading) {
        active = undefined;
        questionDepth = 0;
        headings.length = heading[1].length - 1;
        headings.push(heading[2]);
      } else if (active) active.body += '\n' + line;
    }
  }
  return found;
}

function clarification(
  id: string,
  candidates: PublishedQuestion[],
  language: LectureLanguage,
) {
  const labels = candidates.map((c) =>
    [c.page, ...c.headings, c.title].join(' › '),
  );
  const choices = labels
    .map((label, i) => {
      const repeated = labels.indexOf(label) !== labels.lastIndexOf(label);
      const line = candidates[i].line;
      const location =
        language === 'zh-CN'
          ? '第' + line + '行'
          : language === 'es'
            ? 'línea ' + line
            : 'line ' + line;
      return i + 1 + '. ' + label + (repeated ? ' (' + location + ')' : '');
    })
    .join('\n');
  const prompt =
    language === 'zh-CN'
      ? '出现于多处。你指的是哪一项？'
      : language === 'es'
        ? ' aparece en varias secciones. ¿A cuál te refieres?'
        : ' appears in several places. Which entry do you mean?';
  return 'Q' + id + prompt + '\n' + choices;
}

export function lectureQuestionLookup(
  message: string,
  pages: KnowledgeRelease['pages'],
  language: LectureLanguage = 'en-GB',
  lastAssistant?: string,
) {
  const ids = new Set(
    Array.from(
      message.normalize('NFKC').matchAll(questionId),
      (m) => m[1] ?? m[2],
    ),
  );
  if (ids.size > 1) return undefined;
  const [explicitId] = ids;
  const pendingId = lastAssistant?.match(
    /^Q(\d+)(?:出现于多处。| appears in several places\.| aparece en varias secciones\.)/,
  )?.[1];
  const id = explicitId ?? pendingId;
  if (!id) return undefined;
  let candidates = publishedQuestions(id, pages);
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) {
    if (explicitId)
      return {
        kind: 'unique' as const,
        source: candidates[0],
      };
    return undefined;
  }
  const pending = !explicitId && pendingId === id && lastAssistant;
  if (!explicitId) {
    if (!pending) return undefined;
    const labels = new Set(
      pending
        .split('\n')
        .slice(1)
        .map((line) => line.replace(/^\d+\. /, '')),
    );
    const offered = candidates.filter((c) => {
      const label = [c.page, ...c.headings, c.title].join(' › ');
      return (
        labels.has(label) ||
        ['第' + c.line + '行', 'line ' + c.line, 'línea ' + c.line].some(
          (loc) => labels.has(label + ' (' + loc + ')'),
        )
      );
    });
    if (
      offered.length < 2 ||
      !(['zh-CN', 'en-GB', 'es'] as const).some(
        (lang) => clarification(id, offered, lang) === pending,
      )
    )
      return undefined;
    candidates = offered;
  }

  const text = normalizeScope(message);
  const choice =
    pending && /^(?:[1-9]\d*)$/.test(text)
      ? candidates[Number(text) - 1]
      : undefined;
  const requested = Array.from(text.matchAll(scopeId), (m) => m[0]);
  const parts = candidates.map((c) =>
    [c.page, ...c.headings, c.title].map(normalizeScope),
  );
  const mentioned = [...new Set(parts.flat())].filter((part) => {
    if (!part) return false;
    const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(?<![a-z0-9])' + escaped + '(?![a-z0-9])', 'i').test(
      text,
    );
  });
  if (!explicitId && !choice) {
    let remainder = text;
    for (const part of [...mentioned, ...requested].sort(
      (a, b) => b.length - a.length,
    ))
      remainder = remainder.replaceAll(part, ' ');
    // 新的完整问题即使提到候选章节，也应按新问题处理。
    if (
      !/^(?:(?:i mean|the one in|from|please|我指的是|我说的是|就是|是|的|那一题|那道题)|[\s\d\p{P}])*$/iu.test(
        remainder,
      )
    )
      return undefined;
  }
  const matches = candidates.filter((_candidate, index) => {
    const available = parts[index].flatMap((part) =>
      Array.from(part.matchAll(scopeId), (m) => m[0]),
    );
    return (
      requested.every((scope) => available.includes(scope)) &&
      mentioned.every(
        (part) =>
          requested.includes(part) ||
          parts[index].some((label) => label.includes(part)),
      ) &&
      (requested.length > 0 || mentioned.length > 0)
    );
  });
  const selected = choice || (matches.length === 1 ? matches[0] : undefined);
  if (selected) return { kind: 'scoped' as const, source: selected };
  if (
    explicitId ||
    requested.length ||
    matches.length ||
    (pending && /^\d+$/.test(text))
  )
    return {
      kind: 'clarify' as const,
      answer: clarification(
        id,
        matches.length ? matches : candidates,
        language,
      ),
    };
  return undefined;
}
