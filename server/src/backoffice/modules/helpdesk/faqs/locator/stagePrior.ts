import type { LearnerState } from '../../../../../contracts/helpdesk-qa';

/**
 * 流程树的九个阶段（设计文档 3.1）。key 是稳定的：发布检查要求这里引用的每个阶段在发布的流程树里都存在。
 */
export const STAGES = [
  'account',
  'discover',
  'purchase',
  'learn',
  'tutor',
  'group',
  'manage',
  'settings',
  'help',
] as const;
export type StageKey = (typeof STAGES)[number];

/** 订阅快到期或刚结束的窗口（整天）：endsInDays 在这之间才算「管理订阅」阶段。 */
const PLAN_WINDOW = { before: 7, after: 30 } as const;
/** 最近一笔订单在几天之内才算「付款」阶段。 */
const ORDER_WINDOW_DAYS = 7;
/** 下一场直播在几小时之内才单独算「学习小组」阶段（已在小组里的不看这条）。 */
const SESSION_WINDOW_HOURS = 48;

/**
 * 学员状态 → 可能所在的阶段（设计文档 3.5）。只给先验，不做过滤：结果为空 = 状态说明不了什么。
 * 没有状态 → 空集：未登录和 Portal 没给状态在这里分不开，不能当成「匿名用户」去加权（设计文档 4.4）。
 * 例：试用中、明早有直播的学员 → {purchase, manage, group}，由消息决定是哪一个。
 */
export function stagePrior(
  state: LearnerState | null | undefined,
): Set<StageKey> {
  const stages = new Set<StageKey>();
  if (!state) return stages;
  if (state.emailVerified === false) stages.add('account');
  if (
    state.latestOrder &&
    state.latestOrder.daysAgo <= ORDER_WINDOW_DAYS &&
    (state.latestOrder.status === 'failed' ||
      state.latestOrder.status === 'pending')
  )
    stages.add('purchase');
  for (const plan of state.plans) {
    const live =
      plan.state === 'active' || plan.state === 'cancel_at_period_end';
    if (plan.source === 'trial' && live) {
      stages.add('purchase');
      stages.add('manage');
    }
    if (
      plan.state !== 'active' &&
      plan.endsInDays <= PLAN_WINDOW.before &&
      plan.endsInDays >= -PLAN_WINDOW.after
    )
      stages.add('manage');
  }
  if (
    state.courses.some((course) => course.status === 'in_progress') ||
    state.notStartedWithAccess > 0
  )
    stages.add('learn');
  const groups = state.studyGroups;
  if (
    groups.groups > 0 ||
    groups.hosting > 0 ||
    (groups.nextSessionInHours !== null &&
      groups.nextSessionInHours <= SESSION_WINDOW_HOURS)
  )
    stages.add('group');
  if (state.tickets.open > 0 || state.tickets.waitingOnUser > 0)
    stages.add('help');
  return stages;
}
