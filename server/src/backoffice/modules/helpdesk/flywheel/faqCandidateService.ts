import { isUuid } from '../../../../common/uuidv7';
import { faqCategoryFor } from '../../../../contracts/helpdesk-qa';
import {
  noGapLabeller,
  type GapLabeller,
} from '../../../../contracts/helpdesk-flywheel';
import { INSIGHT_LIMITS, type TicketDetail } from '../contracts';
import type { FaqActor } from '../faqs/faqContracts';
import type {
  FaqGraphRepository,
  FaqNodeSummary,
} from '../faqs/faqGraphRepository';
import type { FaqGraphService } from '../faqs/faqGraphService';
import {
  HelpdeskError,
  type PortalHelpdeskClient,
} from '../portalHelpdeskClient';
import {
  CANDIDATE_ORIGINS,
  CANDIDATE_STATUSES,
  CANDIDATE_SUGGESTIONS,
  DISMISS_REASONS,
  type CandidateRepository,
  type DismissReason,
  type FaqCandidate,
} from './candidateRepository';
import {
  MINING_LIMITS,
  codeLabel,
  phrasingLocale,
  type CandidateExample,
  type NodeText,
  type PhrasingLocale,
} from './flywheelMining';
import { scrubPii } from './piiScrubber';
import { createNgramSimilarity, type TextSimilarity } from './textSimilarity';

/**
 * FAQ 候选的员工端（v5 Part G4）。规则：
 * - 动作都带 version（WHERE id AND version 的条件更新，不一致 → 409 CANDIDATE_CHANGED），可带
 *   Idempotency-Key（UUID）：同一个员工同一个 key 同一个决定再来一次 → 原样返回（replayed）；
 *   同一个 key 换了决定 → 422 IDEMPOTENCY_KEY_REUSED。审计行与决定同一事务（候选修订表，只追加）。
 * - 接受成新 FAQ / 追问：FAQ 没有草稿状态（保存即发布），所以先 GET …/draft 拿预填（问题、分类、
 *   问法；答案留空由员工写；有已解决工单里人写的回复时附「草稿 待核实」），员工经 FAQ 的新建接口建好
 *   节点，再带 faqId 接受；追问另外建 parentId → faqId 的边（经问题树服务：成环、上限、归档照样检查）。
 * - 接受成问法：选中的例句（缺省：所有不含占位符的）经问题树服务加成 source = flywheel 的问法。
 * - 每次接受都把员工勾选的例句（缺省：所有不含占位符的）加成回归用例（标上选定的节点；发布评测门
 *   会用它们）；没勾的、带占位符的不加。
 * - 副作用（问法、边、用例）都幂等，先做；最后写决定。中途失败重试是安全的。整个接受在这个候选的
 *   advisory lock 里做：两个员工同时接受，后到的等前一个做完、重新读到已接受 → 409，不留副作用。
 * - 「转成 FAQ 候选」：只接受已解决（CLOSED，不是学员撤回）的工单；学员第一条消息与客服最后一条
 *   公开回复在 Admin 这里用同一个脱敏器（piiScrubber.ts，与 Portal 的语料 hash 锁定一致）加上这位
 *   学员自己的姓名与邮箱脱敏后才落库；客服回复只当答案的可选草稿来源（草稿 待核实），而且只在
 *   客服解决了的工单（学员确认 / 自动确认）上取；学员自己关掉的不取。按工单幂等。
 */

export const CANDIDATE_LIST_LIMITS = { pageSizeDefault: 20, pageSizeMax: 100 };
export const DRAFT_LABEL = { en: 'Draft, to be verified', zh: '草稿 待核实' };
const NOTE_MAX = 500;
const Q_MAX = 100;
const PLACEHOLDER = /<[a-z_]+>/;

function invalid(message: string): HelpdeskError {
  return new HelpdeskError(400, 'INVALID_INPUT', message);
}

function record(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function uuid(raw: unknown, name: string): string {
  if (typeof raw !== 'string' || !isUuid(raw)) throw invalid(`Invalid ${name}`);
  return raw.toLowerCase();
}

function idempotencyKey(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null;
  if (!isUuid(raw)) throw invalid('Idempotency-Key must be a UUID');
  return raw.toLowerCase();
}

function version(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1)
    throw invalid('version is required');
  return raw;
}

function oneOf<T extends string>(
  raw: unknown,
  values: readonly T[],
  name: string,
): T | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (!(values as readonly unknown[]).includes(raw))
    throw invalid(`${name} must be one of ${values.join(', ')}`);
  return raw as T;
}

function int(raw: unknown, name: string, min: number, max: number): number {
  const value =
    typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < min || value > max)
    throw invalid(`${name} must be an integer ${min}-${max}`);
  return value;
}

function candidateNotFound(): HelpdeskError {
  return new HelpdeskError(404, 'CANDIDATE_NOT_FOUND', 'Candidate not found');
}

function changed(): HelpdeskError {
  return new HelpdeskError(
    409,
    'CANDIDATE_CHANGED',
    'This candidate changed since you loaded it. Reload and try again.',
  );
}

function keyReused(): HelpdeskError {
  return new HelpdeskError(
    422,
    'IDEMPOTENCY_KEY_REUSED',
    'This Idempotency-Key was already used for a different decision',
  );
}

const HAN = /\p{Script=Han}/u;

/** 文字截到 max 个 code point。 */
function clip(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : points.slice(0, max).join('');
}

export type CandidateServiceDeps = {
  candidates: CandidateRepository;
  graph: Pick<FaqGraphRepository, 'summaries'>;
  graphService: Pick<FaqGraphService, 'addPhrasing' | 'createEdge'>;
  portal: Pick<PortalHelpdeskClient, 'getTicket'>;
  nodes: () => Promise<NodeText[]>;
  labeller?: GapLabeller;
  similarity?: TextSimilarity<unknown>;
  now?: () => Date;
};

export type AcceptResult = {
  candidate: FaqCandidate;
  replayed: boolean;
  phrasingsAdded: number;
  phrasingsSkipped: number;
  evalCasesAdded: number;
  edgeId: string | null;
};

export function createFaqCandidateService(deps: CandidateServiceDeps) {
  const labeller = deps.labeller ?? noGapLabeller;
  const similarity = deps.similarity ?? createNgramSimilarity();
  const now = deps.now ?? (() => new Date());

  async function load(rawId: string): Promise<FaqCandidate> {
    const id = uuid(rawId, 'candidate id');
    const candidate = await deps.candidates.get(id);
    if (!candidate) throw candidateNotFound();
    return candidate;
  }

  async function liveNode(id: string): Promise<FaqNodeSummary> {
    const [node] = await deps.graph.summaries([id]);
    if (!node) throw new HelpdeskError(404, 'FAQ_NOT_FOUND', 'FAQ not found');
    if (node.status !== 'published')
      throw new HelpdeskError(
        409,
        'FAQ_ARCHIVED',
        'An archived question cannot take this candidate',
      );
    return node;
  }

  /** 已经做过的决定：同一个员工、同一个 key、同一个决定 → 重放；同 key 不同决定 → 422；否则 409。 */
  function replayOrConflict(
    current: FaqCandidate,
    actor: FaqActor,
    key: string | null,
    same: (candidate: FaqCandidate) => boolean,
  ): FaqCandidate {
    if (key && current.actionKey === key) {
      if (current.decidedBy === actor.employeeId && same(current))
        return current;
      throw keyReused();
    }
    throw changed();
  }

  function examplePicks(
    candidate: FaqCandidate,
    raw: unknown,
  ): CandidateExample[] {
    if (raw === undefined || raw === null)
      return candidate.examples.filter((e) => !PLACEHOLDER.test(e.text));
    if (!Array.isArray(raw))
      throw invalid('phrasings must be a list of example numbers');
    const picked = new Set<number>();
    for (const value of raw) {
      const index = int(value, 'phrasings[]', 0, candidate.examples.length - 1);
      if (PLACEHOLDER.test(candidate.examples[index].text))
        throw invalid(
          'An example with a hidden personal detail cannot become a phrasing',
        );
      picked.add(index);
    }
    return [...picked].sort((a, b) => a - b).map((i) => candidate.examples[i]);
  }

  async function nodeMatch(text: string) {
    const nodes = await deps.nodes();
    const vectors = await similarity.embed([text, ...nodes.map((n) => n.text)]);
    let best: { nodeId: string; score: number } | null = null;
    nodes.forEach((node, index) => {
      const score = similarity.similarity(vectors[0], vectors[index + 1]);
      if (!best || score > best.score) best = { nodeId: node.nodeId, score };
    });
    const found = best as { nodeId: string; score: number } | null;
    return found && found.score >= MINING_LIMITS.nodeThreshold
      ? { nodeId: found.nodeId, score: Math.round(found.score * 1000) / 1000 }
      : null;
  }

  async function acceptLocked(
    actor: FaqActor,
    id: string,
    as: FaqCandidate['suggestion'],
    faqId: string,
    expected: number,
    body: Record<string, unknown>,
    key: string | null,
  ): Promise<AcceptResult> {
    const candidate = await load(id);
    const same = (c: FaqCandidate) =>
      c.status === 'accepted' &&
      c.acceptedAs === as &&
      c.acceptedFaqId === faqId;
    const nothing = {
      phrasingsAdded: 0,
      phrasingsSkipped: 0,
      evalCasesAdded: 0,
      edgeId: null,
    };
    if (candidate.status !== 'new' || candidate.version !== expected)
      return {
        candidate: replayOrConflict(candidate, actor, key, same),
        replayed: true,
        ...nothing,
      };
    const node = await liveNode(faqId);
    if (node.type !== 'answer')
      throw invalid('A candidate can only be accepted onto an answer');
    const picks = examplePicks(candidate, body.phrasings);
    let parentId: string | null = null;
    let edgeId: string | null = null;
    if (as === 'follow_up') {
      parentId =
        body.parentId === undefined || body.parentId === null
          ? candidate.parentNodeId
          : uuid(body.parentId, 'parentId');
      if (!parentId) throw invalid('parentId is required for a follow-up');
      if (parentId === faqId) throw invalid('A question cannot follow itself');
      edgeId = (
        await deps.graphService.createEdge(actor, parentId, {
          childId: faqId,
        })
      ).edge.id;
    }
    let phrasingsAdded = 0;
    let phrasingsSkipped = 0;
    for (const example of picks) {
      try {
        const { created } = await deps.graphService.addPhrasing(
          actor,
          faqId,
          { locale: example.locale, text: example.text },
          'flywheel',
        );
        if (created) phrasingsAdded += 1;
      } catch (error) {
        // 问法满了（30 种）或例句不合问法的格式：跳过这一句，其余照做
        if (
          error instanceof HelpdeskError &&
          (error.code === 'FAQ_TOO_MANY_PHRASINGS' ||
            error.code === 'INVALID_INPUT')
        )
          phrasingsSkipped += 1;
        else throw error;
      }
    }
    // 只有员工勾选的例句当回归用例（没勾的可能说的是别的事，或者还留着个人信息；带占位符的不能勾）
    const evalCasesAdded = await deps.candidates.insertEvalCases(
      picks.map((e) => ({
        faqId,
        candidateId: candidate.id,
        locale: e.locale,
        text: e.text,
        createdBy: actor.employeeId,
      })),
    );
    const decided = await deps.candidates.decide(
      candidate.id,
      expected,
      {
        status: 'accepted',
        acceptedAs: as,
        acceptedFaqId: faqId,
        parentNodeId: parentId,
      },
      actor.employeeId ?? '',
      key,
    );
    if (decided.kind === 'not_found') throw candidateNotFound();
    if (decided.kind === 'conflict')
      return {
        candidate: replayOrConflict(decided.candidate, actor, key, same),
        replayed: true,
        ...nothing,
      };
    return {
      candidate: decided.candidate,
      replayed: false,
      phrasingsAdded,
      phrasingsSkipped,
      evalCasesAdded,
      edgeId,
    };
  }

  return {
    async list(raw: Record<string, unknown>) {
      const pageSize =
        raw.pageSize === undefined
          ? CANDIDATE_LIST_LIMITS.pageSizeDefault
          : int(raw.pageSize, 'pageSize', 1, CANDIDATE_LIST_LIMITS.pageSizeMax);
      const page =
        raw.page === undefined ? 1 : int(raw.page, 'page', 1, 10_000);
      let q: string | undefined;
      if (raw.q !== undefined && raw.q !== '') {
        if (typeof raw.q !== 'string' || [...raw.q].length > Q_MAX)
          throw invalid(`q must be at most ${Q_MAX} characters`);
        q = raw.q.trim() || undefined;
      }
      const result = await deps.candidates.list({
        status: oneOf(raw.status, CANDIDATE_STATUSES, 'status'),
        suggestion: oneOf(raw.suggestion, CANDIDATE_SUGGESTIONS, 'suggestion'),
        origin: oneOf(raw.origin, CANDIDATE_ORIGINS, 'origin'),
        q,
        offset: (page - 1) * pageSize,
        limit: pageSize,
      });
      const nodes = await deps.graph.summaries(
        result.candidates.flatMap((c) =>
          [
            c.relatedNodeId,
            c.parentNodeId,
            c.shownNodeId,
            c.acceptedFaqId,
          ].filter((id): id is string => id !== null),
        ),
      );
      return { ...result, page, pageSize, nodes };
    },

    async get(rawId: string) {
      const candidate = await load(rawId);
      const [revisions, nodes] = await Promise.all([
        deps.candidates.revisions(candidate.id),
        deps.graph.summaries(
          [
            candidate.relatedNodeId,
            candidate.parentNodeId,
            candidate.shownNodeId,
            candidate.acceptedFaqId,
          ].filter((id): id is string => id !== null),
        ),
      ]);
      return { candidate, revisions, nodes };
    },

    /**
     * 新 FAQ / 追问的预填（不写任何东西）：问题按语言分（提议的问题与例句），答案留空由员工写；
     * 草稿只来自已解决工单里人写的回复，标「草稿 待核实」。
     */
    async draft(rawId: string) {
      const candidate = await load(rawId);
      const zh = (text: string) => HAN.test(text);
      const firstOf = (want: boolean) =>
        candidate.examples.find(
          (e) => zh(e.text) === want && !PLACEHOLDER.test(e.text),
        )?.text ?? '';
      const proposed = candidate.proposedQuestion;
      return {
        candidateId: candidate.id,
        version: candidate.version,
        suggestion: candidate.suggestion,
        faq: {
          type: 'answer' as const,
          entry: candidate.suggestion !== 'follow_up',
          category: candidate.category,
          questionEn: clip(zh(proposed) ? firstOf(false) : proposed, 200),
          questionZh: clip(zh(proposed) ? proposed : firstOf(true), 200),
          answerEn: '',
          answerZh: '',
          keywords: [] as string[],
        },
        parentId: candidate.parentNodeId,
        relatedNodeId: candidate.relatedNodeId,
        phrasings: candidate.examples
          .map((e, index) => ({ index, locale: e.locale, text: e.text }))
          .filter((e) => !PLACEHOLDER.test(e.text)),
        answerDraft:
          candidate.answerSources.length > 0
            ? { label: DRAFT_LABEL, sources: candidate.answerSources }
            : null,
      };
    },

    async accept(
      actor: FaqActor,
      rawId: string,
      rawBody: unknown,
      rawKey?: string,
    ): Promise<AcceptResult> {
      const key = idempotencyKey(rawKey);
      const body = record(rawBody);
      const as = oneOf(body.as, CANDIDATE_SUGGESTIONS, 'as');
      if (!as) throw invalid('as is required');
      const faqId = uuid(body.faqId, 'faqId');
      const expected = version(body.version);
      const id = uuid(rawId, 'candidate id');
      // 同一个候选的接受一次一个：锁里重新读，别的员工刚接受了 → 这里是 409，什么副作用也不做
      return deps.candidates.withCandidateLock(id, () =>
        acceptLocked(actor, id, as, faqId, expected, body, key),
      );
    },

    async dismiss(
      actor: FaqActor,
      rawId: string,
      rawBody: unknown,
      rawKey?: string,
    ): Promise<{ candidate: FaqCandidate; replayed: boolean }> {
      const key = idempotencyKey(rawKey);
      const body = record(rawBody);
      const reason = oneOf<DismissReason>(
        body.reason,
        DISMISS_REASONS,
        'reason',
      );
      if (!reason) throw invalid('reason is required');
      let note: string | null = null;
      if (body.note !== undefined && body.note !== null) {
        if (typeof body.note !== 'string') throw invalid('note must be text');
        note = body.note.trim().replace(/\s+/g, ' ') || null;
        if (note && [...note].length > NOTE_MAX)
          throw invalid(`note must be at most ${NOTE_MAX} characters`);
        // 备注是员工写的，照样过一遍脱敏（员工可能贴了学员的邮箱或电话）
        if (note) note = scrubPii(note);
      }
      if (reason === 'other' && !note)
        throw invalid('Say why in the note when the reason is other');
      const expected = version(body.version);
      const candidate = await load(rawId);
      const same = (c: FaqCandidate) =>
        c.status === 'dismissed' && c.reason === reason;
      if (candidate.status !== 'new' || candidate.version !== expected)
        return {
          candidate: replayOrConflict(candidate, actor, key, same),
          replayed: true,
        };
      const decided = await deps.candidates.decide(
        candidate.id,
        expected,
        { status: 'dismissed', reason, reasonNote: note },
        actor.employeeId ?? '',
        key,
      );
      if (decided.kind === 'not_found') throw candidateNotFound();
      if (decided.kind === 'conflict')
        return {
          candidate: replayOrConflict(decided.candidate, actor, key, same),
          replayed: true,
        };
      return { candidate: decided.candidate, replayed: false };
    },

    async merge(
      actor: FaqActor,
      rawId: string,
      rawBody: unknown,
      rawKey?: string,
    ): Promise<{
      source: FaqCandidate;
      target: FaqCandidate | null;
      replayed: boolean;
    }> {
      const key = idempotencyKey(rawKey);
      const body = record(rawBody);
      const targetId = uuid(body.targetId, 'targetId');
      const expected = version(body.version);
      const sourceId = uuid(rawId, 'candidate id');
      if (sourceId === targetId)
        throw invalid('A candidate cannot be merged into itself');
      const same = (c: FaqCandidate) =>
        c.status === 'merged' && c.mergedInto === targetId;
      const result = await deps.candidates.merge(
        sourceId,
        expected,
        targetId,
        actor.employeeId ?? '',
        key,
      );
      switch (result.kind) {
        case 'not_found':
          throw candidateNotFound();
        case 'target_not_found':
          throw new HelpdeskError(
            404,
            'CANDIDATE_NOT_FOUND',
            'The candidate to merge into was not found',
          );
        case 'target_closed':
          throw new HelpdeskError(
            409,
            'CANDIDATE_CLOSED',
            'You can only merge into a candidate that is still open',
          );
        case 'conflict':
          return {
            source: replayOrConflict(result.source, actor, key, same),
            target: await deps.candidates.get(targetId),
            replayed: true,
          };
        default:
          return {
            source: result.source,
            target: result.target,
            replayed: false,
          };
      }
    },

    /** 「转成 FAQ 候选」：从已解决的工单建一个候选（按工单幂等：已经转过 → 那一个，created:false）。 */
    async fromTicket(
      actor: FaqActor,
      rawTicketId: string,
    ): Promise<{
      candidate: FaqCandidate;
      created: boolean;
      similarCandidateId: string | null;
    }> {
      const ticketId = uuid(rawTicketId, 'ticket id');
      const existing = await deps.candidates.byTicket(ticketId);
      if (existing)
        return {
          candidate: existing,
          created: false,
          similarCandidateId: null,
        };
      const ticket: TicketDetail = await deps.portal.getTicket(ticketId);
      if (ticket.status !== 'CLOSED' || ticket.closeReason === 'cancelled')
        throw new HelpdeskError(
          409,
          'TICKET_NOT_RESOLVED',
          'Only a resolved ticket can become an FAQ candidate',
        );
      const publicMessages = ticket.messages.filter((m) => !m.internal);
      const question =
        publicMessages.find((m) => m.authorKind === 'learner')?.body.trim() ||
        ticket.subject.trim();
      if (!question)
        throw new HelpdeskError(
          409,
          'TICKET_NO_QUESTION',
          'This ticket has no question from the learner',
        );
      // 草稿来源只取客服解决了的工单（学员确认或到期自动确认）；学员自己关掉的，客服最后一句可能只是在追问
      const resolvedByAgent =
        ticket.closeReason === 'user_confirmed' ||
        ticket.closeReason === 'auto_confirmed';
      const reply = resolvedByAgent
        ? [...publicMessages]
            .reverse()
            .find((m) => m.authorKind === 'agent')
            ?.body.trim()
        : undefined;
      // 这位学员自己的姓名与邮箱（账号与联系邮箱）一并脱敏；只落脱敏后的文字
      const context = {
        names: [ticket.learner.name, ticket.student?.name ?? ''].filter(
          Boolean,
        ),
        emails: [
          ticket.learner.email,
          ticket.student?.accountEmail ?? '',
          ticket.student?.contactEmail ?? '',
          ticket.contactEmail ?? '',
        ].filter(Boolean),
      };
      const text = clip(
        scrubPii(question, context).replace(/\s+/g, ' ').trim(),
        INSIGHT_LIMITS.textMax,
      );
      const answerSources = reply
        ? [clip(scrubPii(reply, context).trim(), INSIGHT_LIMITS.agentReplyMax)]
        : [];
      const locale: PhrasingLocale = phrasingLocale(text, ticket.locale);
      const example: CandidateExample = {
        turnId: null,
        text,
        locale,
        reasons: ['ticket'],
      };
      const related = await nodeMatch(text);
      const labelled = await labeller.label({ locale, examples: [text] });
      const fallback = codeLabel([example]);
      const label = labelled.ok ? labelled.label : null;
      const at = (ticket.closedAt ?? ticket.updatedAt) || now().toISOString();
      const candidate = await deps.candidates.insertCandidate(
        {
          suggestion: related ? 'add_phrasing' : 'new_faq',
          origin: 'ticket',
          topic: label?.topic ?? fallback.topic,
          proposedQuestion: label?.question ?? fallback.question,
          labelSource: label ? 'model' : 'code',
          category: label?.category ?? faqCategoryFor(ticket.category),
          locale: ticket.locale,
          examples: [example],
          sourceMix: { ticket: 1 },
          answerSources,
          relatedNodeId: related?.nodeId ?? null,
          relatedScore: related?.score ?? null,
          parentNodeId: null,
          shownNodeId: null,
          ticketId,
          firstSeenAt: ticket.createdAt,
          lastSeenAt: at,
          turnCount: 1,
          createdBy: actor.employeeId,
        },
        [],
      );
      // 并发的另一个请求先建了 → 那一个
      if (!candidate) {
        const raced = await deps.candidates.byTicket(ticketId);
        if (!raced) throw changed();
        return { candidate: raced, created: false, similarCandidateId: null };
      }
      const open = await deps.candidates.openCandidates(
        new Date(
          now().getTime() - MINING_LIMITS.candidatesWindowDays * 86_400_000,
        ).toISOString(),
      );
      const others = open.filter((c) => c.id !== candidate.id);
      let similarCandidateId: string | null = null;
      if (others.length > 0) {
        const vectors = await similarity.embed([
          text,
          ...others.flatMap((c) => c.examples),
        ]);
        let offset = 1;
        let best: number = MINING_LIMITS.candidateThreshold;
        for (const other of others) {
          const own = vectors.slice(offset, offset + other.examples.length);
          offset += other.examples.length;
          if (own.length === 0) continue;
          const score = similarity.similarity(
            vectors[0],
            similarity.centroid(own),
          );
          if (score >= best) {
            best = score;
            similarCandidateId = other.id;
          }
        }
      }
      return { candidate, created: true, similarCandidateId };
    },

    /** 回归用例导出（JSON Lines：按节点 key，换库也认得；CI 的评测门读同样的形状）。 */
    async evalCasesJsonl(): Promise<string> {
      const cases = await deps.candidates.evalCases();
      return cases
        .filter((c) => c.faqKey)
        .map((c) =>
          JSON.stringify({ faqKey: c.faqKey, locale: c.locale, text: c.text }),
        )
        .join('\n');
    },
  };
}

export type FaqCandidateService = ReturnType<typeof createFaqCandidateService>;
