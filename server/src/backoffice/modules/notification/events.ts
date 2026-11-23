import { Logger } from '@nestjs/common';

import { createPortalNotificationsClient } from './portalNotificationsClient';

/**
 * Admin 侧事件 → Portal `/api/integration/notifications/events`（设计 §4）。
 *
 * 事件发送失败绝不能让主流程失败（publish / HelpDesk reply 已经提交）：这里只记
 * 告警日志。eventKey 决定幂等：同一课程版本 / 同一条回复只发一次。
 */

const logger = new Logger('NotificationEvents');

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
 * 发一条通知事件（经唯一的 Portal 客户端：地址、令牌、超时、错误映射都在那里）。
 * 返回是否被 Portal 接受；未配置、被拒或网络失败只记一条告警并返回 false（不抛）。
 * P0 事件是发了就不管：Portal 不可用时丢失的事件不会补发。
 */
export async function emitNotificationEvent(
  input: NotificationEventInput,
  options: NotificationEventOptions = {},
): Promise<boolean> {
  try {
    await createPortalNotificationsClient(options).send('POST', '/events', {
      ...input,
    });
    return true;
  } catch (error) {
    logger.warn(
      `Notification event ${input.eventType} was not delivered: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
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
