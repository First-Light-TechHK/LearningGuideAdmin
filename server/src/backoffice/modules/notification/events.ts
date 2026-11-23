import { Logger } from '@nestjs/common';

import { portalNotificationsConfig } from './portalNotificationsClient';

/**
 * Admin 侧事件 → Portal `/api/integration/notifications/events`（设计 §4）。
 *
 * 事件发送失败绝不能让主流程失败（publish / HelpDesk reply 已经提交）：这里只记
 * 告警日志。eventKey 决定幂等：同一课程版本 / 同一条回复只发一次。
 */

const logger = new Logger('NotificationEvents');
const TIMEOUT_MS = 5_000;

export type NotificationEventInput = {
  eventType: 'COURSE_NEW_LAUNCH' | 'HELPDESK_TICKET_REPLIED';
  eventKey: string;
  userId?: string;
  email?: string;
  params?: Record<string, unknown>;
};

export type NotificationEventOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/** 课程首次发布：eventKey = course + version（PRD / design §4）。 */
export function courseLaunchEventKey(
  courseId: string,
  versionId: string,
): string {
  return `course:${courseId}:${versionId}`;
}

/** 学员可见回复：eventKey = ticket + reply。 */
export function ticketReplyEventKey(ticketId: string, replyId: string): string {
  return `ticket:${ticketId}:${replyId}`;
}

/**
 * 发一条通知事件。返回是否被 Portal 接受；未配置或网络失败返回 false（不抛）。
 * 供事件钩子使用，也供单测注入 fetch。
 */
export async function emitNotificationEvent(
  input: NotificationEventInput,
  options: NotificationEventOptions = {},
): Promise<boolean> {
  const config = portalNotificationsConfig();
  if (!config) {
    logger.warn(
      `Notification event ${input.eventType} skipped: notifications are not configured`,
    );
    return false;
  }
  const fetchImpl: typeof fetch =
    options.fetchImpl ?? ((request, init) => fetch(request, init));
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  try {
    const response = await fetchImpl(
      `${config.baseUrl}/api/integration/notifications/events`,
      {
        method: 'POST',
        headers: {
          'x-notifications-token': config.token,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      },
    );
    if (!response.ok) {
      logger.warn(
        `Notification event ${input.eventType} rejected (${response.status})`,
      );
      return false;
    }
    return true;
  } catch {
    logger.warn(`Notification event ${input.eventType} could not be delivered`);
    return false;
  }
}

/** 课程首次发布 → COURSE_NEW_LAUNCH。失败只记录，不影响发布。 */
export async function notifyCourseNewLaunch(
  input: {
    courseId: string;
    versionId: string;
    courseTitle: string;
    categoryName: string;
    courseLink: string;
  },
  options?: NotificationEventOptions,
): Promise<void> {
  await emitNotificationEvent(
    {
      eventType: 'COURSE_NEW_LAUNCH',
      eventKey: courseLaunchEventKey(input.courseId, input.versionId),
      params: {
        course_title: input.courseTitle,
        category_name: input.categoryName,
        course_link: input.courseLink,
      },
    },
    options,
  );
}

/** HelpDesk 学员可见回复 → HELPDESK_TICKET_REPLIED。失败只记录，不影响回复。 */
export async function notifyHelpdeskReply(
  input: {
    ticketId: string;
    replyId: string;
    ticketSubject: string;
    ticketLink: string;
    email: string;
  },
  options?: NotificationEventOptions,
): Promise<void> {
  await emitNotificationEvent(
    {
      eventType: 'HELPDESK_TICKET_REPLIED',
      eventKey: ticketReplyEventKey(input.ticketId, input.replyId),
      email: input.email,
      params: {
        ticket_subject: input.ticketSubject,
        ticket_link: input.ticketLink,
      },
    },
    options,
  );
}
