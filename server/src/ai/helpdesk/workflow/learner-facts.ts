import type {
  LearnerPlanState,
  LearnerState,
} from '../../../contracts/helpdesk-qa';

/**
 * v7 学员状态给模型的规则：只在 Portal 给了状态时接在 PICK_FAQ_V5_SYSTEM 后面（没有状态时提示与之前逐字相同，
 * 基准照旧有效）。
 */
export const LEARNER_STATE_RULE =
  '"user" (when given) lists facts about the learner from the site\'s own records. Use them only to choose between candidates written for different situations (a free trial or a paid plan, an active or an ended plan, a course not started yet); the message still decides what they need. Never pick a card only because of these facts, and never mention them in reply.';

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;
const ago = (days: number) =>
  days === 0 ? 'today' : `${plural(days, 'day')} ago`;
const within = (days: number) =>
  days === 0 ? 'within a day' : `in ${plural(days, 'day')}`;

const REACH: Record<LearnerPlanState['scope'], string> = {
  course: 'one course',
  category: 'one course category',
  everything: 'all courses',
};
const DEVICE = { pc: 'on a computer', mobile: 'on a phone' } as const;

function planFact(plan: LearnerPlanState): string {
  const what = plan.source === 'trial' ? 'free trial' : 'paid plan';
  const where = [REACH[plan.scope], plan.device ? DEVICE[plan.device] : null]
    .filter(Boolean)
    .join(', ');
  // endsInDays 是向下取整的整天：-1 = 一天内刚结束
  const ended = Math.max(0, -plan.endsInDays - 1);
  const left = Math.max(0, plan.endsInDays);
  const status = {
    active:
      plan.source === 'trial'
        ? `active, ends ${within(left)}`
        : `active, renews ${within(left)}`,
    cancel_at_period_end: `cancelled, access ends ${within(left)}`,
    grace: `payment failed, access kept ${within(left).replace(/^in /, 'for ')}`,
    expired: `ended ${ago(ended)}`,
    trial_canceled: `cancelled ${ago(ended)}`,
  }[plan.state];
  return `${what} (${where}): ${status}`;
}

/**
 * v7：学员状态写成几条短的英文事实，由代码写、给 pick_faq（模型只拿来在不同情境的卡片之间选）。
 * 只有契约里的粗数字与枚举，外加员工写的课程名；不含任何学员原文。
 */
export function learnerFacts(state: LearnerState): string[] {
  const facts = [
    state.accountAgeDays === 0
      ? 'account registered today'
      : `account registered ${ago(state.accountAgeDays)}`,
  ];
  if (state.emailVerified === false) facts.push('email not verified');
  if (state.emailVerified === null) facts.push('no email on the account');
  if (state.plans.length === 0) facts.push('never had a plan or a free trial');
  for (const plan of state.plans) facts.push(planFact(plan));
  for (const course of state.courses) {
    const status =
      course.status === 'in_progress'
        ? [
            'in progress',
            `${course.progress}% done`,
            `${plural(course.minutes, 'minute')} studied`,
            ...(course.lastStudiedDaysAgo === null
              ? []
              : [`last studied ${ago(course.lastStudiedDaysAgo)}`]),
          ].join(', ')
        : course.status === 'completed'
          ? 'completed'
          : 'not started';
    facts.push(
      `course "${course.title}": ${status}${course.hasAccess ? '' : ', no access now'}`,
    );
  }
  if (!state.courses.some((course) => course.status !== 'not_started'))
    facts.push('has not studied any course yet');
  if (state.notStartedWithAccess > 0)
    facts.push(
      `${plural(state.notStartedWithAccess, 'course')} they can open and have not started`,
    );
  const groups = state.studyGroups;
  if (groups.groups > 0)
    facts.push(
      `in ${plural(groups.groups, 'study group')}${groups.hosting ? ` (hosts ${groups.hosting})` : ''}; ${
        groups.nextSessionInHours === null
          ? 'no upcoming live session'
          : groups.nextSessionInHours === 0
            ? 'next live session within the hour'
            : `next live session in ${plural(groups.nextSessionInHours, 'hour')}`
      }`,
    );
  if (state.latestOrder)
    facts.push(
      `latest order: ${state.latestOrder.status}, ${ago(state.latestOrder.daysAgo)}`,
    );
  if (state.tickets.open > 0)
    facts.push(
      `${plural(state.tickets.open, 'open enquiry', 'open enquiries')}${
        state.tickets.waitingOnUser
          ? `, ${state.tickets.waitingOnUser} waiting for their reply`
          : ''
      }`,
    );
  return facts;
}
