import { createHash } from 'node:crypto';

import type { SqlDb } from '../../../src/backoffice/modules/helpdesk/faqs/faqRepository';

/**
 * Helpdesk 演示数据（owner 2026-10-31：「做一些测试数据，方便测试和产品观瞻全部效果」）。
 *
 * 只写「演示行」：id 一律以 de000000- 开头（DEMO_PREFIX），一条命令就能全部删掉；真实数据一行不碰。
 * - 求助记录（helpdesk_insight_turns）：最近 28 天，每天 40 到 80 轮，中英繁三种语言；有答对的、没帮上的、没找到卡的、
 *   追问、闲聊、转人工、看完开工单、打分。数字有走势（AI 解决率慢慢变好，中间有一天变差），数据页的折线图才有东西看。
 * - FAQ 候选（helpdesk_faq_candidates + 例句关联 + 历史）：五种建议各至少一张（新卡、加问法、加追问、改卡、下线），
 *   外加已接受、已驳回、已合并、来自工单的各一张。例句就是上面的求助记录，审核页「当时 AI 怎么处理」有真数据。
 * - 缺口挖掘的运行（helpdesk_flywheel_runs）：最近 14 天每天一次，其中一次失败。和真的运行撞同一天时跳过（不覆盖）。
 * - 卡片审核（helpdesk_faq_reviews）：在真实的卡上记几条「没问题」和「需要改」（带备注），全表逐张审核页有三种状态可看。
 *   审核人用库里已有的员工（没有就空着，界面写「员工」）。
 *
 * 幂等：id 由内容算出（同一天、同一条），ON CONFLICT DO NOTHING；隔天再跑会补上新的一天，旧的不变。
 * 删除：removeDemoRows。审核表和候选历史表只追加（触发器拦 DELETE），删除时在同一个事务里临时关掉这两个触发器，
 * 只删演示行，然后马上打开。测试人员在演示候选上点「接受」时加到真卡上的问法、新建的卡不算演示数据，不会被删。
 */
export const DEMO_PREFIX = 'de000000-';

/** 演示行的 id：de000000- 开头的合法 UUID（版本位 4，变体位 8），由 (类别, 键) 算出，重跑得到同一个 id。 */
export function demoId(kind: string, key: string | number): string {
  const hex = createHash('sha1').update(`${kind}:${key}`).digest('hex');
  return `de000000-${hex.slice(0, 4)}-4${hex.slice(4, 7)}-8${hex.slice(7, 10)}-${hex.slice(10, 22)}`;
}

/** 可复现的伪随机（mulberry32）。 */
function random(seed: string): () => number {
  let a = parseInt(
    createHash('sha1').update(seed).digest('hex').slice(0, 8),
    16,
  );
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Locale = 'zh-CN' | 'en-GB' | 'zh-TW';
type Ask = Record<Locale, string[]>;

/** 答得上的问题：卡的 key → 用户会怎么问（三种语言）。key 不在库里就跳过。 */
const ANSWERED: Record<string, Ask> = {
  'create-account': {
    'zh-CN': ['怎么注册账号', '我想注册一个新账号', '注册在哪里'],
    'en-GB': ['how do i sign up', 'create an account', 'where do I register'],
    'zh-TW': ['點樣註冊帳號'],
  },
  'google-sign-in': {
    'zh-CN': ['能用谷歌账号登录吗', 'Google 登录怎么用'],
    'en-GB': ['can I log in with google', 'sign in with Google account'],
    'zh-TW': ['可以用 Google 登入嗎'],
  },
  'invoice-receipt': {
    'zh-CN': ['发票在哪里下载', '我要收据', '付款后怎么开发票'],
    'en-GB': ['where is my invoice', 'need a receipt for my payment'],
    'zh-TW': ['收據喺邊度'],
  },
  'cancel-study-group': {
    'zh-CN': ['怎么取消学习小组', '学习小组不想办了'],
    'en-GB': ['how do I cancel a study group', 'cancel my study group session'],
    'zh-TW': ['點樣取消學習小組'],
  },
  'auto-renewal-off-meaning': {
    'zh-CN': ['显示已取消自动续订是什么意思', '自动续订关了还能用吗'],
    'en-GB': [
      'auto renewal off what does it mean',
      'is my plan cancelled if auto-renew is off',
    ],
    'zh-TW': ['取消咗自動續訂即係點'],
  },
  'live-mic-camera': {
    'zh-CN': ['直播课麦克风没声音', '摄像头打不开'],
    'en-GB': [
      'my mic does not work in the live class',
      'camera not working in live session',
    ],
    'zh-TW': ['直播課咪冇聲'],
  },
  'course-lesson-length': {
    'zh-CN': ['一门课要学多久', '每节课多长时间'],
    'en-GB': ['how long is each lesson', 'how long does a course take'],
    'zh-TW': ['一堂課幾耐'],
  },
  'page-broken-or-old-browser': {
    'zh-CN': ['页面显示乱了', '按钮点了没反应'],
    'en-GB': ['the page looks broken', 'buttons do nothing when I click'],
    'zh-TW': ['頁面亂晒'],
  },
  'everything-includes': {
    'zh-CN': ['全部课程方案包含哪些课', '买了全部课程能学什么'],
    'en-GB': [
      'what is included in the everything plan',
      'which courses come with all courses plan',
    ],
    'zh-TW': ['全部課程包括咩'],
  },
  'plan-to-attend-reserve': {
    'zh-CN': ['点了计划参加会帮我留位置吗'],
    'en-GB': ['does plan to attend keep my seat'],
    'zh-TW': ['計劃參加會唔會留位'],
  },
};

/** 没找到卡的问题（缺口），按话题分组：候选的例句从这里来。 */
const GAPS: Record<string, Ask> = {
  'change-device': {
    'zh-CN': [
      '换了新手机登不上原来的账号',
      '新电脑怎么登录以前的账号',
      '换手机后账号没了',
    ],
    'en-GB': [
      'new phone cannot log into my old account',
      'changed laptop how do I sign in',
    ],
    'zh-TW': ['換咗新電話點樣登入'],
  },
  'reschedule-group': {
    'zh-CN': ['学习小组能改时间吗', '小组开课时间想往后推'],
    'en-GB': [
      'can I move my study group to another time',
      'reschedule a study group',
    ],
    'zh-TW': ['學習小組可唔可以改時間'],
  },
  'refund-after-cancel': {
    'zh-CN': ['取消续订以后还能退款吗', '关掉自动续订之后剩下的钱退不退'],
    'en-GB': [
      'refund after turning off auto renew',
      'will I get money back after cancelling renewal',
    ],
    'zh-TW': ['取消續訂之後可唔可以退錢'],
  },
  'payment-failed': {
    'zh-CN': ['扣款失败是什么原因', '银行卡一直扣款失败', '付款失败了怎么办'],
    'en-GB': ['payment failed why', 'my card keeps getting declined'],
    'zh-TW': ['扣款失敗點算'],
  },
  'receipt-download': {
    'zh-CN': ['收据能下载成 PDF 吗', '收据怎么保存下来'],
    'en-GB': ['download receipt as pdf', 'save my receipt'],
    'zh-TW': ['收據可唔可以下載'],
  },
  jobs: {
    'zh-CN': ['你们招聘老师吗', '我想去你们公司上班'],
    'en-GB': ['are you hiring tutors', 'job openings'],
    'zh-TW': ['你哋請唔請人'],
  },
};

const SMALLTALK: Ask = {
  'zh-CN': ['你好', '谢谢', '好的明白了'],
  'en-GB': ['hello', 'thanks', 'ok got it'],
  'zh-TW': ['你好', '唔該'],
};

const CLARIFY: Ask = {
  'zh-CN': ['我付款有问题', '账号出问题了', '课程打不开'],
  'en-GB': [
    'problem with payment',
    'my account has an issue',
    'course will not open',
  ],
  'zh-TW': ['俾錢有問題'],
};

const HANDOVER: Ask = {
  'zh-CN': ['我要找人工客服', '转人工'],
  'en-GB': ['talk to a person', 'I want a human'],
  'zh-TW': ['我想搵真人'],
};

function pick<T>(rand: () => number, list: readonly T[]): T {
  return list[Math.floor(rand() * list.length) % list.length];
}

function pickLocale(rand: () => number): Locale {
  const r = rand();
  return r < 0.55 ? 'zh-CN' : r < 0.9 ? 'en-GB' : 'zh-TW';
}

export type DemoTurn = {
  id: string;
  createdAt: Date;
  checkedAt: Date;
  source: 'submit' | 'chat' | 'chip';
  locale: Locale;
  text: string;
  sessionId: string;
  turnIndex: number;
  kind: 'answer' | 'smalltalk' | 'clarify' | 'no_match' | 'handover';
  guard: string | null;
  faqKey: string | null;
  gap: string | null;
  answered: boolean;
  vote: 'helpful' | 'not_helpful' | 'solved' | null;
  rating: number | null;
  covered: boolean | null;
  handover: boolean;
  ticketAfterChat: boolean;
};

const DAY = 86_400_000;

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * 最近 28 天的求助记录（纯函数，好测）。走势：越近 AI 解决得越好、没找到卡的越少；倒数第 9 天变差（演示「哪天出了问题」）。
 * faqKeys：库里真有的卡（没有的 key 不用）。
 */
export function demoTurns(now: Date, faqKeys: ReadonlySet<string>): DemoTurn[] {
  const answered = Object.keys(ANSWERED).filter((key) => faqKeys.has(key));
  const gaps = Object.keys(GAPS);
  const turns: DemoTurn[] = [];
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  for (let back = 27; back >= 0; back -= 1) {
    const dayStart = today - back * DAY;
    const day = utcDay(new Date(dayStart));
    const rand = random(`day:${day}`);
    const progress = (27 - back) / 27;
    const badDay = back === 9;
    const weekend = [0, 6].includes(new Date(dayStart).getUTCDay());
    const count = Math.round((weekend ? 40 : 60) + rand() * 20);
    let session = '';
    let turnIndex = 0;
    for (let n = 0; n < count; n += 1) {
      // 今天：只到现在为止
      const minute = Math.floor(rand() * 1440);
      const createdAt = new Date(
        dayStart + minute * 60_000 + Math.floor(rand() * 60) * 1000,
      );
      if (createdAt.getTime() > now.getTime()) continue;
      if (turnIndex === 0 || rand() < 0.4) {
        session = demoId('session', `${day}:${n}`);
        turnIndex = 0;
      }
      const locale = pickLocale(rand);
      const r = rand();
      const noMatch = badDay ? 0.2 : 0.14 - 0.07 * progress;
      const clarify = 0.08;
      const smalltalk = 0.07;
      const handover = badDay ? 0.09 : 0.05;
      let turn: Omit<
        DemoTurn,
        | 'id'
        | 'createdAt'
        | 'checkedAt'
        | 'source'
        | 'locale'
        | 'sessionId'
        | 'turnIndex'
      >;
      if (r < noMatch) {
        const gap = pick(rand, gaps);
        turn = {
          kind: 'no_match',
          text: pick(rand, GAPS[gap][locale]),
          guard: 'passed',
          faqKey: null,
          gap,
          answered: false,
          vote: null,
          rating: rand() < 0.2 ? 2 : null,
          covered: null,
          handover: false,
          ticketAfterChat: rand() < 0.25,
        };
      } else if (r < noMatch + clarify) {
        turn = {
          kind: 'clarify',
          text: pick(rand, CLARIFY[locale]),
          guard: 'passed',
          faqKey: null,
          gap: null,
          answered: false,
          vote: null,
          rating: null,
          covered: rand() < 0.78,
          handover: false,
          ticketAfterChat: false,
        };
      } else if (r < noMatch + clarify + smalltalk) {
        turn = {
          kind: 'smalltalk',
          text: pick(rand, SMALLTALK[locale]),
          guard: null,
          faqKey: null,
          gap: null,
          answered: false,
          vote: null,
          rating: null,
          covered: null,
          handover: false,
          ticketAfterChat: false,
        };
      } else if (r < noMatch + clarify + smalltalk + handover) {
        turn = {
          kind: 'handover',
          text: pick(rand, HANDOVER[locale]),
          guard: null,
          faqKey: null,
          gap: null,
          answered: false,
          vote: null,
          rating: rand() < 0.5 ? 3 : null,
          covered: null,
          handover: true,
          ticketAfterChat: rand() < 0.6,
        };
      } else {
        // 答了一张卡：越近越常被评「有帮助」；偶尔「没帮上」或看完开工单（这些也是缺口）
        const key = answered.length > 0 ? pick(rand, answered) : null;
        const goodRate = badDay ? 0.45 : 0.55 + 0.2 * progress;
        const v = rand();
        const vote =
          v < goodRate * 0.5
            ? 'helpful'
            : v < goodRate * 0.5 + 0.06
              ? 'solved'
              : v < goodRate * 0.5 + 0.06 + (badDay ? 0.14 : 0.07)
                ? 'not_helpful'
                : null;
        turn = {
          kind: 'answer',
          text: key
            ? pick(rand, ANSWERED[key][locale])
            : pick(rand, CLARIFY[locale]),
          guard: rand() < 0.03 ? 'fallback' : 'passed',
          faqKey: key,
          gap:
            vote === 'not_helpful' && key === 'auto-renewal-off-meaning'
              ? 'refund-after-cancel'
              : null,
          answered: true,
          vote,
          rating: rand() < 0.15 ? (vote === 'not_helpful' ? 1 : 5) : null,
          covered: null,
          handover: false,
          ticketAfterChat: rand() < (badDay ? 0.1 : 0.05 - 0.02 * progress),
        };
      }
      const s = rand();
      turns.push({
        ...turn,
        id: demoId('turn', `${day}:${n}`),
        createdAt,
        // 24 小时之后才算「AI 解决了」：旧的记录已经过了观察期
        checkedAt: new Date(
          Math.min(now.getTime(), createdAt.getTime() + 25 * 3_600_000),
        ),
        source: s < 0.3 ? 'submit' : s < 0.85 ? 'chat' : 'chip',
        locale,
        sessionId: session,
        turnIndex,
      });
      turnIndex += 1;
    }
  }
  return turns.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

type CandidateSpec = {
  key: string;
  suggestion:
    'new_faq' | 'add_phrasing' | 'follow_up' | 'update_faq' | 'retire_faq';
  gap: string | null;
  topic: string;
  question: string;
  category:
    | 'account_technical'
    | 'courses_learning'
    | 'payments_subscriptions'
    | 'other';
  related?: string;
  parent?: string;
  shown?: string;
  status?: 'accepted' | 'dismissed' | 'merged';
  reason?: string;
  mergedInto?: string;
  origin?: 'mining' | 'ticket';
  /** 和 gap 无关的固定例句（下线建议、工单转来的）。 */
  examples?: { text: string; locale: Locale; reasons: string[] }[];
};

/** 演示候选：五种建议都有，外加已接受 / 已驳回 / 已合并 / 来自工单。key 不在库里的卡对应的候选会跳过。 */
export const DEMO_CANDIDATES: CandidateSpec[] = [
  {
    key: 'change-device',
    suggestion: 'new_faq',
    gap: 'change-device',
    topic: '换设备后登录',
    question: '换了新手机或电脑，怎么登录原来的账号？',
    category: 'account_technical',
  },
  {
    key: 'reschedule-group',
    suggestion: 'new_faq',
    gap: 'reschedule-group',
    topic: '学习小组改时间',
    question: '学习小组可以改开课时间吗？',
    category: 'courses_learning',
  },
  {
    key: 'receipt-download',
    suggestion: 'add_phrasing',
    gap: 'receipt-download',
    topic: '下载收据',
    question: '收据能下载成 PDF 吗？',
    category: 'payments_subscriptions',
    related: 'invoice-receipt',
  },
  {
    key: 'refund-after-cancel',
    suggestion: 'follow_up',
    gap: 'refund-after-cancel',
    topic: '取消续订后退款',
    question: '取消自动续订以后，剩下的时间能退款吗？',
    category: 'payments_subscriptions',
    parent: 'auto-renewal-off-meaning',
    related: 'auto-renewal-off-meaning',
    shown: 'auto-renewal-off-meaning',
  },
  {
    key: 'payment-failed',
    suggestion: 'update_faq',
    gap: 'payment-failed',
    topic: '扣款失败的原因',
    question: '扣款失败一般是什么原因？',
    category: 'payments_subscriptions',
    related: 'payment-failed-why',
    shown: 'payment-failed-why',
  },
  {
    key: 'retire-stay-signed-in',
    suggestion: 'retire_faq',
    gap: null,
    topic: '重复的「保持登录」卡',
    question: '勾选保持登录后会登录多久？',
    category: 'account_technical',
    related: 'stay-signed-in--how-long',
    examples: [
      { text: '保持登录能登录多久', locale: 'zh-CN', reasons: ['not_helpful'] },
      {
        text: 'how long does stay signed in last',
        locale: 'en-GB',
        reasons: ['not_helpful'],
      },
    ],
  },
  {
    key: 'google-accepted',
    suggestion: 'add_phrasing',
    gap: null,
    topic: '谷歌账号登录',
    question: '能用谷歌账号登录吗？',
    category: 'account_technical',
    related: 'google-sign-in',
    status: 'accepted',
    examples: [
      { text: '能用谷歌账号登录吗', locale: 'zh-CN', reasons: ['no_match'] },
    ],
  },
  {
    key: 'jobs',
    suggestion: 'new_faq',
    gap: 'jobs',
    topic: '招聘',
    question: '你们招聘老师吗？',
    category: 'other',
    status: 'dismissed',
    reason: 'out_of_scope',
  },
  {
    key: 'change-device-dup',
    suggestion: 'new_faq',
    gap: null,
    topic: '新手机登录',
    question: '新手机怎么登录？',
    category: 'account_technical',
    status: 'merged',
    mergedInto: 'change-device',
    examples: [
      { text: '新手机怎么登录', locale: 'zh-CN', reasons: ['no_match'] },
    ],
  },
  {
    key: 'ticket-certificate',
    suggestion: 'new_faq',
    gap: null,
    origin: 'ticket',
    topic: '课程证书',
    question: '学完课程有证书吗？',
    category: 'courses_learning',
    examples: [
      {
        text: '学完以后能拿到证书吗？我需要给学校看。',
        locale: 'zh-CN',
        reasons: ['ticket'],
      },
    ],
  },
];

export type DemoReport = {
  turns: number;
  candidates: number;
  skippedCandidates: string[];
  runs: number;
  reviews: number;
};

type Faq = {
  id: string;
  key: string;
  version: number;
  entry: boolean;
  updatedAt: number;
};

/** 写演示行（不含 FAQ 库；FAQ 库由 seedFaqLibrary 先导入）。全部在一个事务里。 */
export async function seedDemoRows(
  db: SqlDb,
  now = new Date(),
): Promise<DemoReport> {
  const faqRows = await db.query(
    `SELECT id, key, version, entry, updated_at FROM helpdesk_faqs WHERE status = 'published' AND node_type = 'answer' ORDER BY key`,
  );
  const faqs = new Map<string, Faq>(
    faqRows.map((row) => [
      String(row.key),
      {
        id: String(row.id),
        key: String(row.key),
        version: Number(row.version),
        entry: row.entry !== false,
        updatedAt: new Date(row.updated_at as string).getTime(),
      },
    ]),
  );
  let employees: string[] = [];
  try {
    employees = (
      await db.query(
        `SELECT employee_id FROM employees ORDER BY created_at LIMIT 3`,
      )
    ).map((row) => String(row.employee_id));
  } catch {
    // 只有 Helpdesk 表的库（测试）没有员工表
  }
  const turns = demoTurns(now, new Set(faqs.keys()));
  const report: DemoReport = {
    turns: 0,
    candidates: 0,
    skippedCandidates: [],
    runs: 0,
    reviews: 0,
  };

  return db.withTransaction(async (client) => {
    // 1. 求助记录
    for (const turn of turns) {
      const faq = turn.faqKey ? faqs.get(turn.faqKey) : undefined;
      const { rowCount } = await client.query(
        `INSERT INTO helpdesk_insight_turns
           (id, created_at, source, locale, text, session_id, turn_index, kind, guard, faq_id, node_id, answered, vote,
            rating, covered, handover, ticket_after_chat, checked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT (id) DO NOTHING`,
        [
          turn.id,
          turn.createdAt,
          turn.source,
          turn.locale,
          turn.text,
          turn.sessionId,
          turn.turnIndex,
          turn.kind,
          turn.guard,
          faq?.id ?? null,
          turn.answered,
          turn.vote,
          turn.rating,
          turn.covered,
          turn.handover,
          turn.ticketAfterChat,
          turn.checkedAt,
        ],
      );
      report.turns += rowCount ?? 0;
    }

    // 2. 候选：例句取这个话题最近的 5 轮，所有这个话题的轮都关联上（一轮至多归一个候选）
    const ids = new Map(
      DEMO_CANDIDATES.map((spec) => [spec.key, demoId('candidate', spec.key)]),
    );
    const ordered = [...DEMO_CANDIDATES].sort(
      (a, b) => Number(Boolean(a.mergedInto)) - Number(Boolean(b.mergedInto)),
    );
    for (const spec of ordered) {
      const needed = [spec.related, spec.parent, spec.shown].filter(
        (key): key is string => Boolean(key),
      );
      if (needed.some((key) => !faqs.has(key))) {
        report.skippedCandidates.push(spec.key);
        continue;
      }
      const mine = spec.gap
        ? turns.filter((turn) => turn.gap === spec.gap)
        : [];
      const reasonsOf = (turn: DemoTurn): string[] => [
        ...(turn.kind === 'no_match' ? ['no_match'] : []),
        ...(turn.vote === 'not_helpful' ? ['not_helpful'] : []),
        ...(turn.handover ? ['handover'] : []),
        ...(turn.ticketAfterChat ? ['ticket_after_chat'] : []),
        ...(turn.rating !== null && turn.rating <= 2 ? ['low_rating'] : []),
      ];
      const examples =
        spec.examples?.map((example) => ({ turnId: null, ...example })) ??
        mine
          .slice(-5)
          .reverse()
          .map((turn) => ({
            turnId: turn.id,
            text: turn.text,
            locale: turn.locale,
            reasons: reasonsOf(turn),
          }));
      const sourceMix: Record<string, number> = {};
      for (const turn of mine)
        for (const reason of reasonsOf(turn))
          sourceMix[reason] = (sourceMix[reason] ?? 0) + 1;
      if (spec.examples)
        for (const example of spec.examples)
          for (const reason of example.reasons)
            sourceMix[reason] = (sourceMix[reason] ?? 0) + 1;
      const first = mine[0]?.createdAt ?? new Date(now.getTime() - 6 * DAY);
      const last = mine.at(-1)?.createdAt ?? new Date(now.getTime() - DAY);
      const id = ids.get(spec.key) as string;
      const status = spec.status ?? 'new';
      const decidedAt =
        status === 'new' ? null : new Date(now.getTime() - 2 * DAY);
      const related = spec.related ? (faqs.get(spec.related) as Faq) : null;
      const { rowCount } = await client.query(
        `INSERT INTO helpdesk_faq_candidates
           (id, status, suggestion, origin, topic, proposed_question, label_source, category, locale, turn_count, examples,
            source_mix, related_node_id, related_score, parent_node_id, shown_node_id, ticket_id, first_seen_at, last_seen_at,
            reason, accepted_as, accepted_faq_id, merged_into, decided_by, decided_at, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'model', $7, 'zh-CN', $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15, $16, $17,
                 $18, $19, $20, $21, $22, $23, $24, $16, $25)
         ON CONFLICT (id) DO NOTHING`,
        [
          id,
          status,
          spec.suggestion,
          spec.origin ?? 'mining',
          spec.topic,
          spec.question,
          spec.category,
          Math.max(mine.length, examples.length),
          JSON.stringify(examples),
          JSON.stringify(sourceMix),
          related?.id ?? null,
          related ? 0.84 : null,
          spec.parent ? (faqs.get(spec.parent) as Faq).id : null,
          spec.shown ? (faqs.get(spec.shown) as Faq).id : null,
          spec.origin === 'ticket' ? `demo-${spec.key}` : null,
          first,
          last,
          spec.reason ?? null,
          status === 'accepted' ? spec.suggestion : null,
          status === 'accepted' ? (related?.id ?? null) : null,
          spec.mergedInto ? ids.get(spec.mergedInto) : null,
          status === 'new' ? null : (employees[0] ?? null),
          decidedAt,
          status === 'new' ? 1 : 2,
          decidedAt ?? last,
        ],
      );
      if (!rowCount) continue;
      report.candidates += 1;
      for (const turn of mine)
        await client.query(
          `INSERT INTO helpdesk_faq_candidate_turns (turn_id, candidate_id, added_at) VALUES ($1, $2, $3) ON CONFLICT (turn_id) DO NOTHING`,
          [turn.id, id, turn.createdAt],
        );
      await client.query(
        `INSERT INTO helpdesk_faq_candidate_revisions (id, candidate_id, action, before, after, employee_id, employee_name, at)
         VALUES ($1, $2, 'create', NULL, $3::jsonb, NULL, NULL, $4) ON CONFLICT (id) DO NOTHING`,
        [
          demoId('candidate-revision', `${spec.key}:create`),
          id,
          JSON.stringify({ topic: spec.topic, suggestion: spec.suggestion }),
          first,
        ],
      );
      if (status !== 'new') {
        const action =
          status === 'accepted'
            ? 'accept'
            : status === 'dismissed'
              ? 'dismiss'
              : 'merge';
        await client.query(
          `INSERT INTO helpdesk_faq_candidate_revisions (id, candidate_id, action, before, after, employee_id, employee_name, at)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
          [
            demoId('candidate-revision', `${spec.key}:${action}`),
            id,
            action,
            JSON.stringify({ status: 'new' }),
            JSON.stringify({ status, reason: spec.reason ?? null }),
            employees[0] ?? null,
            null,
            decidedAt,
          ],
        );
      }
    }

    // 3. 每晚的缺口挖掘：最近 14 天，倒数第 5 天失败；和真的运行同一天就跳过
    const today = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    for (let back = 13; back >= 0; back -= 1) {
      const dayStart = today - back * DAY;
      const started = new Date(dayStart + 2 * 3_600_000);
      if (started.getTime() > now.getTime()) continue;
      const day = utcDay(new Date(dayStart));
      const previous = turns.filter(
        (turn) =>
          turn.createdAt.getTime() < dayStart &&
          turn.createdAt.getTime() >= dayStart - DAY,
      );
      const failed = back === 5;
      const { rowCount } = await client.query(
        `INSERT INTO helpdesk_flywheel_runs
           (id, job, run_day, trigger, status, attempts, instance, started_at, heartbeat_at, finished_at, stats, error_code)
         VALUES ($1, 'gap_mining', $2, 'schedule', $3, $4, 'demo', $5, $6, $6, $7::jsonb, $8)
         ON CONFLICT DO NOTHING`,
        [
          demoId('run', day),
          day,
          failed ? 'failed' : 'succeeded',
          failed ? 3 : 1,
          started,
          new Date(started.getTime() + (failed ? 90_000 : 42_000)),
          JSON.stringify(
            failed
              ? { pull: { status: 'error' } }
              : {
                  pull: { status: 'ok', received: previous.length },
                  mine: {
                    created: back % 4 === 0 ? 1 : 0,
                    grown: Math.min(3, previous.filter((t) => t.gap).length),
                  },
                },
          ),
          failed ? 'PORTAL_UNAVAILABLE' : null,
        ],
      );
      report.runs += rowCount ?? 0;
    }

    // 4. 卡片审核：入口卡里取一些，大多「没问题」，几张「需要改」
    const NOTES = [
      '截图里的按钮名字和现在的页面不一样了',
      '英文答案少了第 3 步',
      '价格说法要和定价页对齐',
      '链接指向旧的帮助页',
      '语气太生硬，换个说法',
    ];
    const entries = [...faqs.values()].filter((faq) => faq.entry);
    const rand = random('reviews');
    let reviewed = 0;
    for (const faq of entries) {
      if (reviewed >= 40) break;
      if (rand() > 0.25) continue;
      const needs = reviewed % 7 === 3;
      const { rowCount } = await client.query(
        `INSERT INTO helpdesk_faq_reviews (id, faq_id, faq_version, status, note, employee_id, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
        [
          demoId('review', faq.key),
          faq.id,
          faq.version,
          needs ? 'needs_change' : 'ok',
          needs ? NOTES[reviewed % NOTES.length] : null,
          employees.length > 0 ? employees[reviewed % employees.length] : null,
          reviewTime(faq.updatedAt, now.getTime(), rand()),
        ],
      );
      report.reviews += rowCount ?? 0;
      reviewed += 1;
    }
    return report;
  });
}

/** 审核时间落在卡最后一次改动之后、现在之前（最多往前 6 天），改动记录里先有卡再有审核。 */
export function reviewTime(updatedAt: number, now: number, r: number): Date {
  const from = Math.max(updatedAt, now - 6 * DAY);
  return new Date(
    Math.min(
      now,
      from + 60_000 + Math.floor(r * Math.max(0, now - from - 120_000)),
    ),
  );
}

export type RemoveReport = Record<
  | 'reviews'
  | 'candidateRevisions'
  | 'evalCases'
  | 'candidateTurns'
  | 'candidates'
  | 'turns'
  | 'runs',
  number
>;

const DEMO = `id::text LIKE '${DEMO_PREFIX}%'`;

/**
 * 删掉全部演示行，一个事务。候选包括：演示的候选，和夜间挖掘拿演示记录建的候选（它关联的轮次是演示的）。
 * 两个只追加的表（审核、候选历史）临时关掉触发器，只删演示的行，事务结束前打开。
 */
export function removeDemoRows(db: SqlDb): Promise<RemoveReport> {
  return db.withTransaction(async (client) => {
    const count = async (sql: string) =>
      (await client.query(sql)).rowCount ?? 0;
    const candidates = `SELECT id FROM helpdesk_faq_candidates WHERE ${DEMO}
        OR id IN (SELECT candidate_id FROM helpdesk_faq_candidate_turns WHERE turn_id::text LIKE '${DEMO_PREFIX}%')`;
    await client.query(
      'ALTER TABLE helpdesk_faq_reviews DISABLE TRIGGER helpdesk_faq_reviews_append_only',
    );
    const reviews = await count(
      `DELETE FROM helpdesk_faq_reviews WHERE ${DEMO}`,
    );
    await client.query(
      'ALTER TABLE helpdesk_faq_reviews ENABLE TRIGGER helpdesk_faq_reviews_append_only',
    );
    await client.query(
      'CREATE TEMP TABLE demo_candidates ON COMMIT DROP AS ' + candidates,
    );
    await client.query(
      'ALTER TABLE helpdesk_faq_candidate_revisions DISABLE TRIGGER helpdesk_faq_candidate_revisions_append_only',
    );
    const candidateRevisions = await count(
      'DELETE FROM helpdesk_faq_candidate_revisions WHERE candidate_id IN (SELECT id FROM demo_candidates)',
    );
    await client.query(
      'ALTER TABLE helpdesk_faq_candidate_revisions ENABLE TRIGGER helpdesk_faq_candidate_revisions_append_only',
    );
    const evalCases = await count(
      'DELETE FROM helpdesk_faq_eval_cases WHERE candidate_id IN (SELECT id FROM demo_candidates)',
    );
    const candidateTurns = await count(
      `DELETE FROM helpdesk_faq_candidate_turns WHERE candidate_id IN (SELECT id FROM demo_candidates) OR turn_id::text LIKE '${DEMO_PREFIX}%'`,
    );
    // 合并过去的先删（merged_into 指向别的候选，ON DELETE RESTRICT）
    let candidatesDeleted = await count(
      'DELETE FROM helpdesk_faq_candidates WHERE merged_into IS NOT NULL AND id IN (SELECT id FROM demo_candidates)',
    );
    candidatesDeleted += await count(
      'DELETE FROM helpdesk_faq_candidates WHERE id IN (SELECT id FROM demo_candidates)',
    );
    const turns = await count(
      `DELETE FROM helpdesk_insight_turns WHERE ${DEMO}`,
    );
    const runs = await count(
      `DELETE FROM helpdesk_flywheel_runs WHERE ${DEMO}`,
    );
    return {
      reviews,
      candidateRevisions,
      evalCases,
      candidateTurns,
      candidates: candidatesDeleted,
      turns,
      runs,
    };
  });
}

/** 演示数据默认只进本机数据库（localhost / 127.0.0.1 / ::1 / unix socket）。 */
export function isLocalDatabase(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return (
    host === '' ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host === '::1'
  );
}
