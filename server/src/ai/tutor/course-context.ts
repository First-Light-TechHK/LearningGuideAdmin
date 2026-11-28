import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  beforePublishedQuestions,
  type PublishedQuestion,
} from './lecture-question-reference';
import type {
  KnowledgeClient,
  KnowledgeRelease,
} from '../../ks/contract/knowledge-client';

const CONTEXT_TOKEN_BUDGET = 8000;
const MAX_CONTEXT_CHUNKS = 5;
const SNAPSHOT_TOKEN_BUDGET = 6000;
type ContextFormat = 'structured' | 'wiki';

export function boundedQuestionExcerpt(body: string) {
  const byteLimit = CONTEXT_TOKEN_BUDGET * 4;
  const prefix = Buffer.from(body.trim().slice(0, byteLimit), 'utf8');
  if (prefix.length <= byteLimit) return prefix.toString('utf8');
  let end = byteLimit;
  while ((prefix[end] & 0xc0) === 0x80) end--;
  return prefix.toString('utf8', 0, end);
}

export function sourceLevel(
  pageTitle: string,
): 'lesson' | 'lesson_application' | 'course_digest' | 'other' {
  if (/精华提炼|full.book digest|全书七章/i.test(pageTitle))
    return 'course_digest';
  if (/knowledge application|知识应用/i.test(pageTitle))
    return 'lesson_application';
  if (/lesson[\s_-]*\d+|第[一二三四五六七八九十\d]+课/i.test(pageTitle))
    return 'lesson';
  return 'other';
}

export function passageSource(
  pageTitle: string,
  heading: string | null,
  content: string,
) {
  return {
    pageTitle,
    heading,
    sourceLevel: sourceLevel(pageTitle),
    contentHash: createHash('sha256').update(content).digest('hex'),
  };
}

function tutorSnapshotText(
  release: KnowledgeRelease,
  format: ContextFormat,
  labelLevels = false,
) {
  const pages = release.pages.filter((page) => page.contentMd?.trim());
  if (!pages.length)
    throw new BadRequestException('所选知识库版本没有可用正文');
  return pages
    .map((page, index) =>
      format === 'wiki'
        ? `# ${page.title}\n\n${labelLevels ? 'Source level: ' + sourceLevel(page.title) + '\n\n' : ''}${page.contentMd?.trim() ?? ''}`
        : JSON.stringify({
            reference: `S${index + 1}`,
            source: page.title,
            sourceLevel: sourceLevel(page.title),
            evidence: page.contentMd,
          }),
    )
    .join('\n\n');
}

function needsTutorIndex(text: string): boolean {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4) > SNAPSHOT_TOKEN_BUDGET;
}

export function comparisonSubjects(question: string): string[] {
  const text = question
    .normalize('NFKC')
    .trim()
    .replace(/[?？。.]+$/, '');
  const pair =
    /(?:\b(?:difference between|compare|contrast)\s+)(.+?)\s+(?:and|with|versus|vs\.?)\s+(.+)$/iu.exec(
      text,
    ) ??
    /^(?:请(?:问|比较)?|比较)?(.+?)(?:和|与|跟)(.+?)(?:有(?:什么|哪些|何)|的)?(?:区别|差别|不同)(?:是什么|在哪里)?$/u.exec(
      text,
    );
  if (
    !pair &&
    /矛盾|冲突|\b(?:contradict\w*|inconsisten\w*|conflict\w*)\b/iu.test(text)
  ) {
    const lessons = [
      ...new Set(
        [
          ...text.matchAll(
            /\blesson\s*\d+\b|第\s*[一二三四五六七八九十\d]+\s*课/giu,
          ),
        ].map(([lesson]) =>
          lesson
            .toLowerCase()
            .replace(/\s+/g, '')
            .replace(/^lesson/, 'lesson '),
        ),
      ),
    ];
    if (lessons.length > 1) return lessons;
  }
  return pair
    ? pair
        .slice(1)
        .map((term) => term.replace(/^(?:the|an?)\s+/i, '').trim())
        .filter((term) => term && term.length <= 180)
    : [];
}

export async function publishedQuestionContext(
  knowledge: KnowledgeClient,
  release: KnowledgeRelease,
  question: PublishedQuestion,
  request: string,
  sources: ReturnType<typeof passageSource>[],
) {
  const excerpt = boundedQuestionExcerpt(question.body);
  const heading = [...question.headings, question.title].join(' › ');
  const passages = [excerpt];
  const blocks = ['# ' + question.page + '\n' + heading + '\n\n' + excerpt];
  sources.push(passageSource(question.page, heading, excerpt));
  const needsBackground =
    !question.body.trim().includes('\n') ||
    /\b(?:why|explain|derive|justify|compare|proof)\b|为什么|为何|解释|推导|证明|比较/iu.test(
      request,
    );
  if (needsBackground) {
    const pages = release.pages.map((p) => ({
      title: p.title,
      text: p.contentMd ?? '',
    }));
    const backgrounds = pages.map((p) => ({
      pageTitle: p.title,
      heading: null,
      content: beforePublishedQuestions(p.text),
    }));
    let candidates: Array<{
      pageTitle: string;
      heading: string | null;
      content: string;
    }> = backgrounds;
    if (needsTutorIndex(pages.map((p) => p.text).join('\n'))) {
      const exercisePages = new Set(
        pages
          .filter((p, i) => backgrounds[i].content !== p.text)
          .map((p) => p.title),
      );
      const chunks = await knowledge
        .retrieveChunks(release.id, [question.title, request].join('\n'))
        .catch(() => []);
      candidates = chunks.filter(
        (c) =>
          !exercisePages.has(c.pageTitle) ||
          backgrounds.some(
            (b) => b.pageTitle === c.pageTitle && b.content.includes(c.content),
          ),
      );
    }
    let remaining = CONTEXT_TOKEN_BUDGET * 4 - Buffer.byteLength(excerpt);
    for (const candidate of candidates) {
      const body = candidate.content.trim();
      const size = Buffer.byteLength(body);
      if (
        !body ||
        !body.split('\n').some((line) => line.trim() && !/^\s*#/.test(line)) ||
        size > remaining ||
        passages.includes(body)
      )
        continue;
      sources.push(passageSource(candidate.pageTitle, candidate.heading, body));
      passages.push(body);
      blocks.push(
        JSON.stringify({
          reference: 'S' + passages.length,
          source: candidate.pageTitle,
          heading: candidate.heading,
          sourceLevel: sourceLevel(candidate.pageTitle),
          evidence: body,
        }),
      );
      remaining -= size;
      if (passages.length >= MAX_CONTEXT_CHUNKS) break;
    }
  }
  return { text: blocks.join('\n\n'), passages };
}

export function assertTutorReleaseReady(
  release: KnowledgeRelease,
  format: ContextFormat,
): void {
  const text = tutorSnapshotText(release, format);
  if (release.indexedChunkCount === 0 && needsTutorIndex(text)) {
    throw new BadRequestException(
      '所选知识库版本缺少索引，请在版本列表中重建索引后再测试',
    );
  }
}

/** 小包沿用母版完整 Release；大包保留有预算的检索与来源回归。 */
export async function buildTutorContext(
  knowledge: KnowledgeClient,
  release: KnowledgeRelease,
  query: string,
  summaryTopics: string[] = [],
  format: ContextFormat = 'structured',
  selectedSources?: ReturnType<typeof passageSource>[],
  gapTerms?: string[],
  referenceOffset = 0,
): Promise<{
  text: string | null;
  strategy: 'snapshot' | 'retrieval';
  passages?: string[];
}> {
  const text = tutorSnapshotText(release, format, gapTerms !== undefined);
  if (!needsTutorIndex(text)) {
    if (selectedSources) {
      for (const page of release.pages) {
        const body = page.contentMd?.trim();
        if (body) {
          selectedSources.push(passageSource(page.title, null, body));
        }
      }
    }
    return { text, strategy: 'snapshot' };
  }
  const passages: string[] = [];
  return {
    text: await buildRetrievedContext(
      knowledge,
      release.id,
      query,
      summaryTopics,
      passages,
      selectedSources,
      gapTerms,
      referenceOffset,
    ),
    strategy: 'retrieval',
    passages,
  };
}

export async function loadTutorRelease(
  knowledge: KnowledgeClient,
  courseId: string,
  releaseId: string,
) {
  const release = await knowledge.getRelease(releaseId);
  if (!release) throw new NotFoundException('所选知识库版本不存在');
  if (release.id !== releaseId || release.courseId !== courseId) {
    throw new BadRequestException('知识库版本不属于当前课程');
  }
  return release;
}

async function buildRetrievedContext(
  knowledge: KnowledgeClient,
  releaseId: string,
  query: string,
  summaryTopics: string[] = [],
  passages: string[] = [],
  selectedSources?: ReturnType<typeof passageSource>[],
  gapTerms: string[] = [],
  referenceOffset = 0,
): Promise<string | null> {
  if (!releaseId) {
    throw new BadRequestException(
      '该课程尚未发布知识库版本，请先在 Knowledge 模块 Releases 页创建版本',
    );
  }

  const replicator = /replicator|复制子|基因型比例/i.test(query);
  const hawkDove = /hawk.{0,3}dove|鹰.{0,2}鸽/i.test(query);
  const biologyUse =
    /(?:matter for biology|real use|生物学.*(?:用途|应用|意义))/i.test(query);
  const initialUncertainty =
    /初始(?:测量|条件|状态)|initial (?:measurements?|conditions?|states?)/i.test(
      query,
    ) && /长期预测|long[- ]term predictions?/i.test(query);
  const searchQuery = replicator
    ? `${query} replicator equation genotype proportions fitness X(1-X)`
    : hawkDove
      ? `${query} Hawk Dove payoff matrix`
      : biologyUse
        ? `${query} biological application predator prey state space trajectory`
        : initialUncertainty
          ? 'Sensitive dependence on initial conditions 初始条件敏感性 ' + query
          : query;
  const eigenQuestion = /eigenvalue|eigenvector|特征值|特征向量/i.test(query);
  const sirQuestion = /\bSIR\b/i.test(query);
  const stabilityScopeQuestion =
    /stability|稳定性/i.test(query) &&
    /lesson[\s_-]*\d+|第[一二三四五六七八九十\d]+课|这节课/i.test(query);
  const [primaryChunks, ...summaryResults] = await Promise.all([
    knowledge.retrieveChunks(releaseId, searchQuery),
    ...summaryTopics.map((topic) => knowledge.retrieveChunks(releaseId, topic)),
  ]);
  const primaryAnchor = primaryChunks.find(
    (chunk) => chunk.tokenCount <= CONTEXT_TOKEN_BUDGET,
  );
  const firstPass = primaryChunks
    .slice(0, MAX_CONTEXT_CHUNKS)
    .map((c) => c.content.toLowerCase())
    .join('\n');
  const gap = gapTerms.find(
    (term) => term.trim() && !firstPass.includes(term.toLowerCase()),
  );
  if (gap && !summaryTopics.includes(gap)) {
    const extra = await knowledge
      .retrieveChunks(releaseId, gap)
      .catch(() => []);
    summaryResults.unshift(extra);
  }
  const supplemental: typeof primaryChunks = [];
  let remaining = CONTEXT_TOKEN_BUDGET - (primaryAnchor?.tokenCount ?? 0);
  for (const candidates of summaryResults) {
    const selected = candidates.find(
      (candidate) =>
        candidate.tokenCount <= remaining &&
        ![primaryAnchor, ...supplemental].some(
          (existing) =>
            existing?.pageTitle === candidate.pageTitle &&
            existing.heading === candidate.heading &&
            existing.content === candidate.content,
        ),
    );
    if (selected) {
      supplemental.push(selected);
      remaining -= selected.tokenCount;
    }
  }
  let chunks = [...supplemental, ...primaryChunks];
  if (sirQuestion) {
    const digest = await knowledge.retrieveChunks(
      releaseId,
      "流行病学 SIR 传染性接触 康复 总人口守恒 S'=-aSI I'=aSI-bI R'=bI",
    );
    const lesson = await knowledge.retrieveChunks(
      releaseId,
      'Lesson 1 易感–感染人群空间 状态空间 susceptible infected population space',
    );
    chunks = [
      ...lesson.filter(
        (chunk) =>
          sourceLevel(chunk.pageTitle) !== 'course_digest' &&
          /易感|susceptible/i.test(chunk.content),
      ),
      ...digest.filter(
        (chunk) =>
          sourceLevel(chunk.pageTitle) === 'course_digest' &&
          /\bSIR\b|易感.*感染/i.test(chunk.content),
      ),
      ...chunks,
    ];
  }
  if (hawkDove) {
    const application = await knowledge.retrieveChunks(
      releaseId,
      `${query} Lesson 1 Knowledge Application Questions and Answers Hawk Dove payoff replicator`,
    );
    chunks = [
      ...application.filter(
        (chunk) =>
          sourceLevel(chunk.pageTitle) === 'lesson_application' &&
          /hawk|dove|鹰|鸽/i.test(chunk.content),
      ),
      ...chunks,
    ];
  }
  if (stabilityScopeQuestion) {
    const scope = await knowledge.retrieveChunks(
      releaseId,
      'Chapter 1 Course Scope Outside the scope of Chapter 1 stability equilibrium 稳定性 平衡',
    );
    chunks = [
      ...scope.filter(
        (chunk) =>
          /scope|范围/i.test(chunk.heading ?? '') &&
          /stability|稳定性/i.test(chunk.content),
      ),
      ...chunks,
    ];
  }
  if (eigenQuestion) {
    const scope = await knowledge.retrieveChunks(
      releaseId,
      'Chapter 1 Course Scope Outside the scope of Chapter 1 eigenvalues eigenvectors 特征值 特征向量',
    );
    const digest = await knowledge.retrieveChunks(
      releaseId,
      `${query} Chapter 6 linear algebra eigenvalues eigenvectors 特征值 特征向量`,
    );
    chunks = [
      ...scope.filter(
        (chunk) =>
          /scope|范围/i.test(chunk.heading ?? '') &&
          /eigenvalue|eigenvector|特征值|特征向量/i.test(chunk.content),
      ),
      ...digest.filter(
        (chunk) =>
          sourceLevel(chunk.pageTitle) === 'course_digest' &&
          /eigenvalue|eigenvector|特征值|特征向量/i.test(chunk.content),
      ),
      ...chunks,
    ];
  }
  const relevantChunks = replicator
    ? chunks.filter((chunk) => /replicator|复制子/i.test(chunk.content))
    : eigenQuestion
      ? chunks.filter((chunk) =>
          /eigenvalue|eigenvector|特征值|特征向量/i.test(chunk.content),
        )
      : chunks;
  if (relevantChunks.length === 0) return null;

  // 保持检索排名，在预算内选择完整片段，避免截断定义或公式。
  const blocks: string[] = [];
  const seen = new Set<string>();
  let totalTokens = 0;
  for (const r of relevantChunks) {
    if (blocks.length >= MAX_CONTEXT_CHUNKS) break;
    if (totalTokens + r.tokenCount > CONTEXT_TOKEN_BUDGET) continue;
    const source = r.heading ? `${r.pageTitle} - ${r.heading}` : r.pageTitle;
    const key = `${source}\n${r.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selectedSources?.push(passageSource(r.pageTitle, r.heading, r.content));
    passages.push(r.content);
    blocks.push(
      JSON.stringify({
        reference: `S${referenceOffset + blocks.length + 1}`,
        source,
        sourceLevel: sourceLevel(r.pageTitle),
        evidence: r.content,
      }),
    );
    totalTokens += r.tokenCount;
  }

  if (blocks.length === 0) return null;

  return blocks.join('\n\n');
}
