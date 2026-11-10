import type { FaqEvalSuiteResult } from '../faqReleaseGate';
import { scoreAsks } from './questions';
import type { QuestionResult, RunResult } from './runner';
import { rate, wilson } from './stats';

/**
 * 发布前检查的判定（release check v2，owner 2026-11-05 选 A、2026-11-06 批准；门的规则 2026-11-09 按
 * Fable 5.2 评审 A1 / A2 / A4 / A5 / A6 改过，owner 同日批准）。题按「套件」分，每个套件是 gate（不过就不能
 * 发布）或 track（只看不拦，但「新出的错」照样拦）：
 * 绝对的线只画在 s650 上（按卡写的题，标的卡由出题方式决定）；盲测只和上线版本逐题比：
 * - s650：错卡率 95% 置信区间上界 ≤ wrongRateMax（2%）；它的语言 / 写法切片，题数 ≥ sliceMin 的按点估计
 *   ≤ wrongRateMax 拦；它里面库里没卡的题出了卡的 ≤ cardWhenNoneMax（3%；目标 0.3%，见 doc）；
 * - blind（盲出题）：和上线版本逐题比，两个方向都比——不能有新出的错，答对率也不能掉。它的绝对数只报不拦：
 *   盲测的 AI 标注自己就有约 3% 的错，拿它卡 2% 的线，结果由标注决定。2026-11-09 真模型实跑（线上流程、
 *   聊天期限 8 秒）：s650 1.07%（上界 1.76%），盲测 8.4%，合起来 2.27%（上界 3.10%）——合在一起卡，每一版都
 *   发不出去，门只会被整个关掉；
 * - blindNone（盲测里库里没卡的题）：单列，只看。实跑 21 道里 5 道给了最近的卡（s650 的 78 道里 0 道）：合在
 *   一起算是 5.1%，问题被 s650 的简单题冲淡，分开才看得见；它要靠补卡解决，阈值压不下去；
 * - combined（全部单问）：只报不拦（它 = s650 + blind + 回归，各有自己的门）；界面上的主数字还是它；
 * - regression：员工接受过的真实用户原话；
 * - 不比线上差（所有套件）：和上线版本逐题比，候选版本新出的错、复问后仍错（reaskConfirm 次）→ 不通过；
 * - 答对率不比线上低（gate 套件，配对题 ≥ sliceMin 道的）：上线版本答对、候选版本没答对（没出卡、追问、超时、
 *   错卡），复问后仍然如此的算丢了；丢的减去新答对的，超过 rightDropMax（1 个点）→ 不通过。以前门只数错卡，
 *   答对率从 93% 掉到 70% 也照样过；
 * - 超时 = 学员没拿到答案：不算错卡，算没答上（答对率的分母里有它）；超时的题超过 timeoutRateMax → 不通过
 *  （以前超时的题直接离开错卡率的分母，错题超时了反而帮着过门）；
 * - 待重标：按标注是错卡、但出的是这一版新加的卡（员工给库外问题补了卡、或拆出了更具体的卡）→ 不计分、
 *   不算新出的错，单独数；它和跳过的题（标的卡没了）、泄漏的题（原句就是金卡的问法）合起来超过
 *   staleRateMax → 不通过：题集该重标了，覆盖不能悄悄缩小；
 * - 检查不算数：没得到回答（不含超时）超过 errorRateMax；漂移抽查变了超过 driftMax 道；检索降级（向量或
 *   精排该生效却没生效）的题超过 degradedRateMax——那样问的就不是线上那条流程。
 * - 追问（B5，屏幕上开着父卡）：自成一个套件，track（还没有基线，到了 2% 再改 gate），不进全部题、语言与
 *   写法切片（那些是单问的数）；「不比线上差」照样拦。
 * - 旧卡在屏问新问题（screen，A6）：开发集单问抽样，屏幕上配一张不相干的卡再问；track，另报和不带卡时
 *   相比变了几道、丢了几道。
 * - 一句多问（owner 2026-11-06）：一句问了几件事的单问，track；另报逐件的数（每件事出没出它的卡、
 *   多给的错卡、顺序、没卡时说没说），逐件的标签还是 AI 标的，先只看不拦。
 */
export type PolicyLimits = {
  wrongRateMax: number;
  cardWhenNoneMax: number;
  errorRateMax: number;
  sliceMin: number;
  driftMax: number;
  reaskConfirm: number;
  /** 超时（学员没拿到答案）占问了的题的比例上限。 */
  timeoutRateMax: number;
  /** 答对率比上线版本低多少算变差（逐题配对、复问确认之后）。 */
  rightDropMax: number;
  /** 跳过 + 泄漏 + 待重标的题占比上限：超过 = 题集该重标了。 */
  staleRateMax: number;
  /** 检索降级的题占比上限：超过 = 问的不是线上流程，检查不算数。 */
  degradedRateMax: number;
};

/** 没进判分的题（questions.ts planQuestions 数的）：标的卡这一版没有的、原句就是金卡问法的。 */
export type PlanCoverage = { skipped: number; leakedDev: number };

type Slice = {
  id: string;
  label: string;
  status: 'gate' | 'track';
  rule: 'interval' | 'point' | 'paired';
  /** 这个套件里库里没卡的题出了卡的比例也有上限（cardWhenNoneMax）。 */
  noneCap?: boolean;
  pick: (r: QuestionResult) => boolean;
  /** 这个套件另报的数（进 metrics）；all = 这次检查的全部题。 */
  extra?: (
    rows: readonly QuestionResult[],
    all: readonly QuestionResult[],
  ) => Record<string, number>;
};

export type Judgement = {
  passed: boolean;
  /** 检查本身不算数（没得到回答太多、缓存漂移）。 */
  invalid: boolean;
  reasons: string[];
  suites: FaqEvalSuiteResult[];
  /** 全部单问（不含追问）：错卡率门槛与界面上的主数字。 */
  combined: SuiteNumbers;
  /** 真的问了的全部题（含追问）：没得到回答的比例与「新出的错」按它数。 */
  everything: SuiteNumbers;
  /** 确认变差的题（复问后仍错）。 */
  regressed: QuestionResult[];
};

export type SuiteNumbers = {
  n: number;
  scored: number;
  wrong: number;
  wrongRate: number;
  wrongHigh: number;
  answerable: number;
  right: number;
  rightRate: number;
  viaEntry: number;
  noneExpected: number;
  cardWhenNone: number;
  cardWhenNoneRate: number;
  extraCards: number;
  timeouts: number;
  errors: number;
  newlyWrong: number;
  confirmedWorse: number;
  fixed: number;
  liveWrongRate: number | null;
  /** 待重标（不计分）。 */
  relabel: number;
  /** 检索降级的题。 */
  degraded: number;
  /** 和上线版本配对的、期望出卡的题（两边都得到了回答）。 */
  pairedAnswerable: number;
  /** 配对题上：上线版本的答对率、候选版本的（复问后又答对的算答对）、差（正数 = 掉了）。 */
  liveRightRate: number | null;
  pairedRightRate: number | null;
  rightDrop: number;
  /** 上线版本答对、候选版本复问后仍没答对的；上线版本没答对、候选版本答对的。 */
  lostRight: number;
  gainedRight: number;
};

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

/** 能和上线版本逐题比：两边都问了，检查自己都没出错。 */
const comparable = (r: QuestionResult) =>
  r.live !== null && !r.live.score.error && !r.candidate.score.error;

/** 新出的错：候选版本出了错卡，上线版本这题没错。 */
export function newlyWrong(r: QuestionResult): boolean {
  return (
    comparable(r) && r.candidate.score.wrongCard && !r.live!.score.wrongCard
  );
}

/** 新出的错复问后仍错（至少 confirm 次，含第一次）。 */
export function confirmedWorse(r: QuestionResult, confirm: number): boolean {
  return newlyWrong(r) && r.reasked !== null && r.reasked.wrong >= confirm;
}

/** 候选版本答对了；第一次没答对但复问后又答对的（抖了一下）也算。 */
const rightAfterReask = (r: QuestionResult, confirm: number) =>
  r.candidate.score.right ||
  (r.reasked !== null && r.reasked.notRight < confirm);

/** 丢了的：上线版本答对，候选版本没答对，复问后仍然如此（没复问的也算，保守）。 */
export function lostRight(r: QuestionResult, confirm: number): boolean {
  return (
    comparable(r) &&
    r.q.expect === 'answer' &&
    !r.candidate.score.relabel &&
    r.live!.score.right &&
    !rightAfterReask(r, confirm)
  );
}

export function suiteNumbers(
  rows: readonly QuestionResult[],
  confirm: number,
): SuiteNumbers {
  // 待重标的题不计分（标注还没跟上这一版新加的卡），超时与检查出错的不进错卡率
  const scored = rows.filter(
    (r) =>
      !r.candidate.score.error &&
      !r.candidate.score.timeout &&
      !r.candidate.score.relabel,
  );
  const wrong = scored.filter((r) => r.candidate.score.wrongCard).length;
  // 答对率：期望出卡的题里出了对的卡；超时算没答上，检查出错与待重标的不计
  const answerable = rows.filter(
    (r) =>
      r.q.expect === 'answer' &&
      !r.candidate.score.error &&
      !r.candidate.score.relabel,
  );
  const right = answerable.filter((r) => r.candidate.score.right).length;
  const none = scored.filter((r) => r.q.expect === 'no_match');
  const cardWhenNone = none.filter(
    (r) => r.candidate.score.cardWhenNone,
  ).length;
  const paired = rows.filter(
    (r) => r.live !== null && !r.live.score.error && !r.live.score.timeout,
  );
  const liveWrong = paired.filter((r) => r.live!.score.wrongCard).length;
  const pairedAnswerable = answerable.filter(comparable);
  const liveRight = pairedAnswerable.filter((r) => r.live!.score.right).length;
  const stillRight = pairedAnswerable.filter((r) =>
    rightAfterReask(r, confirm),
  ).length;
  const has = pairedAnswerable.length > 0;
  return {
    n: rows.length,
    scored: scored.length,
    wrong,
    wrongRate: rate(wrong, scored.length),
    wrongHigh: Number(wilson(wrong, scored.length).high.toFixed(4)),
    answerable: answerable.length,
    right,
    rightRate: rate(right, answerable.length),
    viaEntry: scored.filter((r) => r.candidate.score.viaEntry).length,
    noneExpected: none.length,
    cardWhenNone,
    cardWhenNoneRate: rate(cardWhenNone, none.length),
    extraCards: scored.filter((r) => r.candidate.score.extraCard).length,
    timeouts: rows.filter((r) => r.candidate.score.timeout).length,
    errors: rows.filter((r) => r.candidate.score.error).length,
    newlyWrong: rows.filter(newlyWrong).length,
    confirmedWorse: rows.filter((r) => confirmedWorse(r, confirm)).length,
    fixed: paired.filter(
      (r) => r.live!.score.wrongCard && !r.candidate.score.wrongCard,
    ).length,
    liveWrongRate: paired.length > 0 ? rate(liveWrong, paired.length) : null,
    relabel: rows.filter((r) => r.candidate.score.relabel).length,
    degraded: rows.filter((r) => (r.candidate.got.degraded?.length ?? 0) > 0)
      .length,
    pairedAnswerable: pairedAnswerable.length,
    liveRightRate: has ? rate(liveRight, pairedAnswerable.length) : null,
    pairedRightRate: has ? rate(stillRight, pairedAnswerable.length) : null,
    rightDrop: has
      ? Number(((liveRight - stillRight) / pairedAnswerable.length).toFixed(4))
      : 0,
    lostRight: pairedAnswerable.filter((r) => lostRight(r, confirm)).length,
    gainedRight: pairedAnswerable.filter(
      (r) => !r.live!.score.right && r.candidate.score.right,
    ).length,
  };
}

/** 单问（屏幕上没有卡）：全部题、语言与写法切片只数它。 */
const single = (r: QuestionResult) => r.q.screen === null;

const sameShown = (a: QuestionResult, b: QuestionResult) =>
  a.candidate.got.kind === b.candidate.got.kind &&
  a.candidate.got.nodeId === b.candidate.got.nodeId;

/**
 * 「旧卡在屏问新问题」另报的数：同一道题不带卡时（bare）的结果在这次检查里也有，逐题对照——
 * screenChanged = 带上旧卡后回答变了的；screenLost = 不带卡答对、带卡没答对的；bareRight = 不带卡答对的。
 */
export function screenNumbers(
  rows: readonly QuestionResult[],
  all: readonly QuestionResult[],
): Record<string, number> {
  const byId = new Map(all.map((r) => [r.q.id, r]));
  const pairs = rows.flatMap((r) => {
    const bare = byId.get(r.q.id.replace(/^screen:/, ''));
    return bare && !bare.candidate.score.error && !r.candidate.score.error
      ? [{ r, bare }]
      : [];
  });
  return {
    screenPairs: pairs.length,
    screenChanged: pairs.filter(({ r, bare }) => !sameShown(r, bare)).length,
    bareRight: pairs.filter(({ bare }) => bare.candidate.score.right).length,
    screenLost: pairs.filter(
      ({ r, bare }) => bare.candidate.score.right && !r.candidate.score.right,
    ).length,
  };
}

/**
 * 一句多问逐件的数（候选版本）：超时算这几件事都没出卡（学员没拿到答案），检查出错的题不计。
 * askCoverage = 库里有卡的事里出了它的卡的比例；allCovered = 有卡的事全出了的题；strayCards = 哪件事都
 * 不对应的卡；inOrder / ordered = 出了两件以上的题里按问的顺序出的；missedSaid / noCardAsks = 回复说了没现成
 * 答案的件数 / 库里没卡的件数。
 */
export function askNumbers(
  rows: readonly QuestionResult[],
): Record<string, number> {
  const scores = rows
    .filter((r) => !r.candidate.score.error)
    .map((r) => scoreAsks(r.q, r.candidate.got))
    .filter((score) => score !== null);
  const sum = (pick: (s: (typeof scores)[number]) => number) =>
    scores.reduce((total, s) => total + pick(s), 0);
  const asks = sum((s) => s.asks);
  const covered = sum((s) => s.covered);
  return {
    asks,
    asksCovered: covered,
    askCoverage: rate(covered, asks),
    allCovered: scores.filter((s) => s.asks > 0 && s.covered >= s.asks).length,
    strayCards: sum((s) => s.stray),
    ordered: scores.filter((s) => s.inOrder !== null).length,
    inOrder: scores.filter((s) => s.inOrder === true).length,
    noCardAsks: sum((s) => s.noCard),
    missedSaid: sum((s) => s.missedSaid),
  };
}

function slices(results: readonly QuestionResult[]): Slice[] {
  const fixed: Slice[] = [
    {
      id: 'combined',
      label: 'All questions',
      status: 'track',
      rule: 'interval',
      pick: single,
    },
    {
      id: 's650',
      label: 'S650 (written per card)',
      status: 'gate',
      rule: 'interval',
      noneCap: true,
      pick: (r) => r.q.set === 's650',
    },
    {
      id: 'blind',
      label: 'Blind (written without seeing cards)',
      status: 'gate',
      rule: 'paired',
      pick: (r) => r.q.set === 'blind',
    },
    {
      id: 'blindNone',
      label: 'Blind questions the library has no card for',
      status: 'track',
      rule: 'paired',
      pick: (r) => r.q.set === 'blind' && r.q.expect === 'no_match',
    },
    {
      id: 'regression',
      label: 'Regression (accepted user wording)',
      status: 'gate',
      rule: 'paired',
      pick: (r) => r.q.set === 'regression',
    },
    {
      id: 'followup',
      label: 'Follow-ups (parent card on screen)',
      status: 'track',
      rule: 'paired',
      pick: (r) => r.q.set === 'followup',
    },
    {
      id: 'screen',
      label: 'New question with another card on screen',
      status: 'track',
      rule: 'paired',
      pick: (r) => r.q.set === 'screen',
      extra: screenNumbers,
    },
    {
      id: 'changed',
      label: 'Questions on changed cards',
      status: 'track',
      rule: 'paired',
      pick: (r) => single(r) && r.q.changed,
    },
    {
      id: 'multi',
      label: 'Several asks in one message',
      status: 'track',
      rule: 'paired',
      pick: (r) => single(r) && r.q.asks !== null,
      extra: askNumbers,
    },
  ];
  // 语言 / 写法切片只切 s650（绝对的线不画在盲测上，见文件头）
  const s650 = results.filter((r) => r.q.set === 's650');
  const languages = [...new Set(s650.map((r) => r.q.language))].sort();
  const styles = [
    ...new Set(s650.map((r) => r.q.style).filter((s) => s !== null)),
  ].sort();
  return [
    ...fixed,
    ...languages.map((language): Slice => ({
      id: `language:${language}`,
      label: `Language ${language}`,
      status: 'gate',
      rule: 'point',
      pick: (r) => r.q.set === 's650' && r.q.language === language,
    })),
    ...styles.map((style): Slice => ({
      id: `style:${style}`,
      label: `Style ${style}`,
      status: 'gate',
      rule: 'point',
      pick: (r) => r.q.set === 's650' && r.q.style === style,
    })),
  ];
}

export function judgeRelease(
  run: Pick<RunResult, 'results' | 'drift'>,
  limits: PolicyLimits,
  coverage: PlanCoverage = { skipped: 0, leakedDev: 0 },
): Judgement {
  const { results } = run;
  const reasons: string[] = [];
  const combined = suiteNumbers(results.filter(single), limits.reaskConfirm);
  const everything = suiteNumbers(results, limits.reaskConfirm);
  const suites: FaqEvalSuiteResult[] = [];
  for (const slice of slices(results)) {
    const rows = results.filter(slice.pick);
    if (rows.length === 0) continue;
    const numbers = suiteNumbers(rows, limits.reaskConfirm);
    /** 这个套件自己的门（gate 才拦）。 */
    const own: string[] = [];
    // 太小的切片只看不拦（点估计在几十道题上没有意义）
    const small = slice.rule === 'point' && numbers.scored < limits.sliceMin;
    if (slice.rule === 'interval' && numbers.wrongHigh > limits.wrongRateMax)
      own.push(
        `wrong card ${pct(numbers.wrongRate)} (95% upper ${pct(numbers.wrongHigh)}) > ${pct(limits.wrongRateMax)}`,
      );
    if (
      slice.rule === 'point' &&
      !small &&
      numbers.wrongRate > limits.wrongRateMax
    )
      own.push(
        `wrong card ${pct(numbers.wrongRate)} > ${pct(limits.wrongRateMax)} over ${numbers.scored}`,
      );
    const noneOver =
      slice.noneCap === true &&
      numbers.cardWhenNoneRate > limits.cardWhenNoneMax;
    if (noneOver)
      own.push(
        `a card was shown for ${pct(numbers.cardWhenNoneRate)} of questions the library has no card for > ${pct(limits.cardWhenNoneMax)}`,
      );
    // 答对率不比线上低：配对题够多才判（几十道题上 1 个点不到一道题）
    const rightDropped =
      numbers.pairedAnswerable >= limits.sliceMin &&
      numbers.rightDrop > limits.rightDropMax;
    if (rightDropped)
      own.push(
        `right answers fell from ${pct(numbers.liveRightRate ?? 0)} to ${pct(numbers.pairedRightRate ?? 0)} against the live version (${numbers.lostRight} lost, ${numbers.gainedRight} gained) > ${pct(limits.rightDropMax)}`,
      );
    const status = small ? 'track' : slice.status;
    if (status === 'gate' && own.length > 0)
      reasons.push(`${slice.label}: ${own.join('; ')}`);
    // 新出的错在任何套件都拦，下面合起来只说一次；这里照样列在套件自己的原因里
    const worse =
      numbers.confirmedWorse > 0
        ? [
            `${numbers.confirmedWorse} question(s) newly wrong against the live version`,
          ]
        : [];
    suites.push({
      id: slice.id,
      label: slice.label,
      status,
      rule: slice.rule,
      passed: own.length === 0 && worse.length === 0,
      n: numbers.n,
      metrics: {
        scored: numbers.scored,
        wrongCards: numbers.wrong,
        wrongRate: numbers.wrongRate,
        wrongRateHigh: numbers.wrongHigh,
        rightRate: numbers.rightRate,
        viaEntry: numbers.viaEntry,
        cardWhenNone: numbers.cardWhenNone,
        cardWhenNoneRate: numbers.cardWhenNoneRate,
        extraCards: numbers.extraCards,
        timeouts: numbers.timeouts,
        errors: numbers.errors,
        newlyWrong: numbers.newlyWrong,
        confirmedWorse: numbers.confirmedWorse,
        fixed: numbers.fixed,
        relabel: numbers.relabel,
        noneExpected: numbers.noneExpected,
        ...(noneOver ? { cardWhenNoneOver: 1 } : {}),
        ...(numbers.liveWrongRate === null
          ? {}
          : { liveWrongRate: numbers.liveWrongRate }),
        ...(numbers.liveRightRate === null || numbers.pairedRightRate === null
          ? {}
          : {
              pairedAnswerable: numbers.pairedAnswerable,
              liveRightRate: numbers.liveRightRate,
              pairedRightRate: numbers.pairedRightRate,
              rightDrop: numbers.rightDrop,
              lostRight: numbers.lostRight,
              gainedRight: numbers.gainedRight,
              rightDropped: rightDropped ? 1 : 0,
            }),
        ...(slice.extra?.(rows, results) ?? {}),
      },
      reasons: [...own, ...worse],
    });
  }
  // 新出的错在任何套件（含追问、旧卡在屏）都拦
  if (everything.confirmedWorse > 0)
    reasons.push(
      `${everything.confirmedWorse} question(s) newly wrong against the live version`,
    );
  if (rate(everything.timeouts, everything.n) > limits.timeoutRateMax)
    reasons.push(
      `${everything.timeouts} of ${everything.n} questions timed out (${pct(rate(everything.timeouts, everything.n))} > ${pct(limits.timeoutRateMax)}): those learners would get no answer`,
    );
  const stale = coverage.skipped + coverage.leakedDev + everything.relabel;
  const labelled = everything.n + coverage.skipped + coverage.leakedDev;
  if (rate(stale, labelled) > limits.staleRateMax)
    reasons.push(
      `${stale} of ${labelled} labelled questions could not be scored (${coverage.skipped} whose card is gone, ${coverage.leakedDev} that are their own card's wording, ${everything.relabel} answered by a card new in this release) > ${pct(limits.staleRateMax)}: the question set needs relabelling`,
    );
  const invalid: string[] = [];
  const errorRate = rate(everything.errors, everything.n);
  if (errorRate > limits.errorRateMax)
    invalid.push(
      `${everything.errors} of ${everything.n} questions got no answer (model or balance problem), so the check does not count`,
    );
  if (rate(everything.degraded, everything.n) > limits.degradedRateMax)
    invalid.push(
      `${everything.degraded} of ${everything.n} questions were answered without the vector search or the reranker (it failed), so the check does not count`,
    );
  if (run.drift.changed > limits.driftMax)
    invalid.push(
      `${run.drift.changed} of ${run.drift.checked} cached answers changed when asked again (the cache may be stale), so the check does not count`,
    );
  return {
    passed: reasons.length === 0 && invalid.length === 0,
    invalid: invalid.length > 0,
    reasons: [...invalid, ...reasons],
    suites,
    combined,
    everything,
    regressed: results.filter((r) => confirmedWorse(r, limits.reaskConfirm)),
  };
}
