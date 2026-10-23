import { appEnvName, isDevRuntime } from '../../../lib/env';

export type EmailDeliveryResult = 'SENT' | 'FAILED' | 'NOT_CONFIGURED';

/**
 * 非生产环境没有接入邮件服务时，把一次性链接交给发起操作的 Admin 手工转交，
 * 否则 DEV/SIT 上新建的员工永远无法激活。生产环境绝不返回链接。
 */
export function manualLinkFor(
  delivery: EmailDeliveryResult,
  link: string,
): string | null {
  return delivery !== 'SENT' && appEnvName() !== 'PROD' ? link : null;
}

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
};

/**
 * 通知适配器。开发态把链接打到服务端日志（console adapter），
 * 生产态必须接入真实投递服务，未配置时返回 NOT_CONFIGURED，
 * 绝不把未投递的邮件报成成功（PRD PORT-ADM-002）。
 */
export function deliver(message: EmailMessage): Promise<EmailDeliveryResult> {
  const provider = process.env.SES_FROM_EMAIL?.trim() ?? '';

  if (provider === '') {
    if (isDevRuntime()) {
      console.info(
        `[notification:console] to=${message.to} subject="${message.subject}"\n${message.text}`,
      );
      return Promise.resolve('SENT');
    }
    console.error(
      `[notification] no email provider configured, dropped message to ${message.to}`,
    );
    return Promise.resolve('NOT_CONFIGURED');
  }

  // 生产投递实现（SES/SMTP）在切片 2 接入；在此之前明确失败而不是伪装成功。
  console.error(
    `[notification] provider configured but adapter not implemented: ${provider}`,
  );
  return Promise.resolve('NOT_CONFIGURED');
}

export async function sendActivationEmail(input: {
  to: string;
  link: string;
  locale: string;
}): Promise<EmailDeliveryResult> {
  const zh = input.locale === 'zh-CN';
  return deliver({
    to: input.to,
    subject: zh
      ? '激活您的 Learning Guide BackOffice 账号'
      : 'Activate your Learning Guide BackOffice account',
    text: zh
      ? `请在 48 小时内通过以下链接设置初始密码并激活账号：\n${input.link}\n\n如果链接已过期，请联系管理员重新发送。`
      : `Set your initial password within 48 hours using the link below:\n${input.link}\n\nIf the link has expired, please contact an administrator for a new one.`,
  });
}

export async function sendPasswordResetEmail(input: {
  to: string;
  link: string;
  locale: string;
}): Promise<EmailDeliveryResult> {
  const zh = input.locale === 'zh-CN';
  return deliver({
    to: input.to,
    subject: zh
      ? '重置您的 Learning Guide BackOffice 密码'
      : 'Reset your Learning Guide BackOffice password',
    text: zh
      ? `请使用以下链接设置新密码（仅可使用一次）：\n${input.link}\n\n如非本人操作，请忽略本邮件并联系管理员。`
      : `Use the single-use link below to set a new password:\n${input.link}\n\nIf you did not request this, ignore this email and contact an administrator.`,
  });
}

export async function sendPasswordChangedEmail(input: {
  to: string;
  locale: string;
}): Promise<EmailDeliveryResult> {
  const zh = input.locale === 'zh-CN';
  return deliver({
    to: input.to,
    subject: zh
      ? '您的 Learning Guide BackOffice 密码已变更'
      : 'Your Learning Guide BackOffice password changed',
    text: zh
      ? '您的账号密码刚刚被修改或重置。如非本人操作，请立即联系管理员。'
      : 'The password for your account has just been changed or reset. If this was not you, contact an administrator immediately.',
  });
}
