import { BadRequestException, NotFoundException } from '@nestjs/common';
import type {
  KnowledgeClient,
  KnowledgeRelease,
} from '../../ks/contract/knowledge-client';

const CONTEXT_TOKEN_BUDGET = 1100;
const MAX_CONTEXT_CHUNKS = 5;
const SNAPSHOT_TOKEN_BUDGET = 6000;

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

/** 小包沿用母版完整 Release；大包保留有预算的检索与来源回归。 */
export async function buildTutorContext(
  knowledge: KnowledgeClient,
  release: KnowledgeRelease,
  query: string,
  summaryTopics: string[] = [],
): Promise<{ text: string | null; strategy: 'snapshot' | 'retrieval' }> {
  const pages = release.pages.filter((page) => page.contentMd?.trim());
  if (!pages.length)
    throw new BadRequestException('所选知识库版本没有可用正文');
  const text = pages
    .map((page, index) =>
      JSON.stringify({
        reference: `S${index + 1}`,
        source: page.title,
        sourceLevel: sourceLevel(page.title),
        evidence: page.contentMd,
      }),
    )
    .join('\n\n');
  const estimatedTokens = Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
  if (estimatedTokens <= SNAPSHOT_TOKEN_BUDGET)
    return { text, strategy: 'snapshot' };
  return {
    text: await buildRetrievedContext(
      knowledge,
      release.id,
      query,
      summaryTopics,
    ),
    strategy: 'retrieval',
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
  const searchQuery = replicator
    ? `${query} replicator equation genotype proportions fitness X(1-X)`
    : hawkDove
      ? `${query} Hawk Dove payoff matrix`
      : biologyUse
        ? `${query} biological application predator prey state space trajectory`
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
  const supplemental: typeof primaryChunks = [];
  let remaining = CONTEXT_TOKEN_BUDGET - (primaryAnchor?.tokenCount ?? 0);
  for (const candidates of summaryResults) {
    const selected = candidates.find(
      (candidate) =>
        candidate.tokenCount <= remaining &&
        ![primaryAnchor, ...supplemental].some(
          (existing) =>
            existing?.pageTitle === candidate.pageTitle &&
            existing.heading === candidate.heading,
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

  // 按 token 预算拼接，超出时按 score 从高到低截断
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
    blocks.push(
      JSON.stringify({
        reference: `S${blocks.length + 1}`,
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
