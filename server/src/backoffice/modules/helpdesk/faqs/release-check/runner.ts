import { createHash } from 'node:crypto';

import {
  addAskStats,
  emptyAskStats,
  type EvalAskStats,
  type EvalCacheMode,
} from '../../../../../contracts/helpdesk-eval-cache';
import type {
  ReleaseEvalAnswer,
  ReleaseEvalSession,
} from '../../../../../contracts/helpdesk-release-eval';
import {
  markRelabel,
  scoreModelAnswer,
  type EvalQuestion,
  type ModelEvalScore,
} from './questions';

/**
 * 发布前检查的跑题器（release check v2）：每题同时问候选版本与上线版本（逐题对比；上线版本的答案几乎
 * 全在缓存里，不再花钱），然后：
 * - 复问：比线上差的题——候选版本出了错卡而上线版本这题没错（新出的错），或上线版本答对而候选版本没答对
 *  （没出卡、追问、超时；2026-11-09 加：以前只数错卡，答对变成没答上不拦）→ 不用缓存再问 reaskTimes 次，
 *   至少 reaskConfirm 次（含第一次）仍然如此才算真的变差（模型偶尔抖一下不冤枉卡片）；
 * - 待重标：按标注是错卡、但出的是这一版新加的卡（fresh）→ 不算错、不复问，单独数（questions.ts markRelabel）；
 * - 漂移抽查：从命中缓存的题里按 (题号, 版本) 的哈希挑 driftSample 道，不读缓存重问一遍（写回新结果），
 *   结果和缓存给的不一样的超过 driftMax 道 → 缓存可能过期，这次检查不算数。
 * 花费到 budgetUsd 就停；被顶替（progress 返回 false / signal）就停。
 */
export type RunLimits = {
  concurrency: number;
  budgetUsd: number;
  reaskTimes: number;
  reaskConfirm: number;
  /** 至多复问这么多道（新出的错再多也是坏了，不必每道都确认）。 */
  reaskMax: number;
  driftSample: number;
  progressEvery: number;
};

export type AskRecord = {
  q: EvalQuestion;
  got: ReleaseEvalAnswer;
  score: ModelEvalScore;
};

export type QuestionResult = {
  q: EvalQuestion;
  candidate: AskRecord;
  live: AskRecord | null;
  /**
   * 比线上差的题复问的结果（含第一次）：几次出了错卡（wrong）、几次没答对（notRight）；没复问 = null。
   * 哪一种变差由 policy.ts 按两个版本第一次的判分分（newlyWrong / lostRight）。
   */
  reasked: { wrong: number; notRight: number; of: number } | null;
};

export type RunResult = {
  results: QuestionResult[];
  planned: number;
  stopped: null | 'budget' | 'replaced';
  spend: {
    total: number;
    model: number;
    rerank: number;
    embed: number;
    /** 候选版本 / 上线版本 / 复问与漂移抽查各花多少。 */
    candidate: number;
    live: number;
    checks: number;
  };
  unpricedCalls: number;
  cache: EvalAskStats;
  drift: { checked: number; changed: number; ids: string[] };
};

type Progress = (done: number, total: number) => Promise<boolean | void>;

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** 并发跑一串任务；shouldStop 为真就不再开新任务（已开的跑完）。 */
async function pool<T>(
  items: readonly T[],
  concurrency: number,
  shouldStop: () => boolean,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (!shouldStop() && next < items.length) await work(items[next++]);
  };
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, () => worker()),
  );
}

const sameAnswer = (a: ReleaseEvalAnswer, b: ReleaseEvalAnswer) =>
  a.kind === b.kind &&
  a.nodeId === b.nodeId &&
  (a.more ?? []).join() === (b.more ?? []).join();

const anyHit = (stats: EvalAskStats | undefined) =>
  stats !== undefined &&
  (stats.step.hits > 0 || stats.rerank.hits > 0 || stats.embed.hits > 0);

export async function runReleaseQuestions(input: {
  questions: readonly EvalQuestion[];
  candidate: ReleaseEvalSession;
  live: ReleaseEvalSession | null;
  /** 这一版有、上线版本没有的卡（节点 id）：出了它们而被判错的题记成待重标；不给 = 不适用。 */
  fresh?: ReadonlySet<string>;
  version: number;
  limits: RunLimits;
  signal?: AbortSignal;
  progress?: Progress;
}): Promise<RunResult> {
  const { limits } = input;
  const spend = {
    total: 0,
    model: 0,
    rerank: 0,
    embed: 0,
    candidate: 0,
    live: 0,
    checks: 0,
  };
  const cache = emptyAskStats();
  let unpricedCalls = 0;
  let stopped: RunResult['stopped'] = null;
  const shouldStop = () => {
    if (stopped) return true;
    if (input.signal?.aborted) stopped = 'replaced';
    else if (spend.total >= limits.budgetUsd) stopped = 'budget';
    return stopped !== null;
  };
  const ask = async (
    session: ReleaseEvalSession,
    q: EvalQuestion,
    mode: EvalCacheMode,
    bucket: 'candidate' | 'live' | 'checks',
  ): Promise<AskRecord> => {
    const got = await session.ask({
      message: q.message,
      locale: q.locale,
      signal: input.signal,
      cache: mode,
      ...(q.screen
        ? {
            screen: {
              nodeId: q.screen.nodeId,
              recentTurns: q.screen.recentTurns,
            },
          }
        : {}),
    });
    spend.total += got.costUsd;
    spend[bucket] += got.costUsd;
    spend.model += got.spend?.model ?? got.costUsd;
    spend.rerank += got.spend?.rerank ?? 0;
    spend.embed += got.spend?.embed ?? 0;
    unpricedCalls += got.unpricedCalls;
    if (got.cache) addAskStats(cache, got.cache);
    const score = scoreModelAnswer(q, got);
    return {
      q,
      got,
      score:
        bucket === 'live' || !input.fresh
          ? score
          : markRelabel(score, got, input.fresh),
    };
  };

  let total = input.questions.length;
  let done = 0;
  const tick = async () => {
    done += 1;
    if (done % limits.progressEvery === 0 || done === total) {
      const alive = await input.progress?.(done, total);
      if (alive === false) stopped = 'replaced';
    }
  };
  await input.progress?.(0, total);

  // 1. 每题问两个版本
  const results: QuestionResult[] = [];
  await pool(input.questions, limits.concurrency, shouldStop, async (q) => {
    const [candidate, live] = await Promise.all([
      ask(input.candidate, q, 'use', 'candidate'),
      input.live ? ask(input.live, q, 'use', 'live') : Promise.resolve(null),
    ]);
    results.push({ q, candidate, live, reasked: null });
    await tick();
  });

  // 2. 比线上差的题：不用缓存再问几次（新出的错在前：它一道就拦；至多 reaskMax 道）
  const comparable = (r: QuestionResult) =>
    r.live !== null && !r.live.score.error && !r.candidate.score.error;
  const newlyWrong = results.filter(
    (r) =>
      comparable(r) && r.candidate.score.wrongCard && !r.live!.score.wrongCard,
  );
  const lostRight = results.filter(
    (r) =>
      comparable(r) &&
      r.q.expect === 'answer' &&
      r.live!.score.right &&
      !r.candidate.score.right &&
      !r.candidate.score.relabel &&
      !newlyWrong.includes(r),
  );
  const worse = [...newlyWrong, ...lostRight].slice(0, limits.reaskMax);
  total += worse.length * limits.reaskTimes;
  await pool(worse, limits.concurrency, shouldStop, async (r) => {
    let wrong = r.candidate.score.wrongCard ? 1 : 0;
    let notRight = 1;
    for (let i = 0; i < limits.reaskTimes && !shouldStop(); i += 1) {
      const again = await ask(input.candidate, r.q, 'bypass', 'checks');
      if (again.score.wrongCard) wrong += 1;
      // 复问时检查自己出了错（限流等）不算学员没答上；超时算
      if (!again.score.right && !again.score.error) notRight += 1;
      await tick();
    }
    r.reasked = { wrong, notRight, of: 1 + limits.reaskTimes };
  });

  // 3. 漂移抽查：命中缓存的题里挑几道，不读缓存重问
  const drift = { checked: 0, changed: 0, ids: [] as string[] };
  const sample = results
    .filter((r) => !r.candidate.score.error && anyHit(r.candidate.got.cache))
    .sort((a, b) => {
      const x = sha(`${a.q.id}:${input.version}`);
      const y = sha(`${b.q.id}:${input.version}`);
      return x < y ? -1 : x > y ? 1 : 0;
    })
    .slice(0, limits.driftSample);
  total += sample.length;
  await pool(sample, limits.concurrency, shouldStop, async (r) => {
    const fresh = await ask(input.candidate, r.q, 'refresh', 'checks');
    if (!fresh.score.error) {
      drift.checked += 1;
      if (!sameAnswer(fresh.got, r.candidate.got)) {
        drift.changed += 1;
        drift.ids.push(r.q.id);
      }
    }
    await tick();
  });

  results.sort((a, b) => (a.q.id < b.q.id ? -1 : a.q.id > b.q.id ? 1 : 0));
  return {
    results,
    planned: input.questions.length,
    stopped,
    spend,
    unpricedCalls,
    cache,
    drift,
  };
}
