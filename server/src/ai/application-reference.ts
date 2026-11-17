import type { KnowledgeRelease } from '../ks/contract/knowledge-client';
import type { ApplicationReferenceAnswer } from '../contracts/application-assessment';

const normalise = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Match the complete authored question; similarity alone cannot identify an answer. */
export function applicationReference(
  release: KnowledgeRelease,
  question: string,
): ApplicationReferenceAnswer {
  const matches: Array<{ contentMarkdown: string; sourceTitle: string }> = [];
  for (const page of release.pages) {
    const text = page.contentMd || '';
    const sections = text.split(/(?=^(?:\*\*)?Q\d+\s*:)/m);
    for (const section of sections) {
      const match =
        /^(?:\*\*)?Q(\d+)\s*:([\s\S]*?)^(?:\*\*)?A\1\s*:\s*([\s\S]*)/m.exec(
          section,
        );
      if (!match || normalise(match[2]) !== normalise(question)) continue;
      const answer = match[3].trim();
      if (answer)
        matches.push({ contentMarkdown: answer, sourceTitle: page.title });
    }
  }
  return matches.length === 1
    ? { status: 'available', ...matches[0] }
    : { status: 'unavailable', contentMarkdown: null, sourceTitle: null };
}
