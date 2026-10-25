import { createTransport } from 'nodemailer';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

import { isDevRuntime } from '../../../lib/env';

export type EmailDeliveryResult = 'SENT' | 'FAILED' | 'NOT_CONFIGURED';

/**
 * Admin 触发的激活/重置操作始终把一次性链接回传给页面：
 * 邮件正常发出时也保留，方便 Admin 直接复制转交（员工邮箱收不到时也能完成激活/重置）。
 * 链接本身仍是单次使用、带有效期的；自助「忘记密码」不经过这里，因此不会暴露链接。
 */
export function manualLinkFor(link: string): string {
  return link;
}

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

/**
 * 通知适配器（取值约定与 LearningGuidePortal services/emailService.ts 一致）：
 * 1. SMTP_HOST + SMTP_USER + SMTP_PASS 齐全 → SMTP 投递（线上 163：smtp.163.com:465）
 * 2. 只配 SES_FROM_EMAIL → AWS SESv2（默认 ap-southeast-1，实例角色授权）
 * 3. 都没有：DEV 打到服务端日志（console adapter），其它环境返回 NOT_CONFIGURED
 *
 * 绝不把未投递的邮件报成成功（PRD PORT-ADM-002 / §8.5）。
 */
const DEFAULT_SES_REGION = 'ap-southeast-1';

let sesClient: SESv2Client | null = null;

function smtpConfigured(): boolean {
  return (
    (process.env.SMTP_HOST?.trim() ?? '') !== '' &&
    (process.env.SMTP_USER?.trim() ?? '') !== '' &&
    (process.env.SMTP_PASS?.trim() ?? '') !== ''
  );
}

function sesConfigured(): boolean {
  return (process.env.SES_FROM_EMAIL?.trim() ?? '') !== '';
}

function fromAddress(): string {
  return (
    process.env.SMTP_FROM?.trim() ||
    process.env.SES_FROM_EMAIL?.trim() ||
    process.env.SMTP_USER?.trim() ||
    ''
  );
}

async function sendViaSmtp(message: EmailMessage): Promise<void> {
  const from = fromAddress();
  if (from === '') throw new Error('SMTP_FROM / SES_FROM_EMAIL is not configured');

  const port = Number(process.env.SMTP_PORT?.trim() || '465');
  const transport = createTransport({
    host: process.env.SMTP_HOST?.trim(),
    port,
    secure: process.env.SMTP_SECURE?.trim() !== '0' && port === 465,
    auth: {
      user: process.env.SMTP_USER?.trim(),
      pass: process.env.SMTP_PASS?.trim(),
    },
  });

  await transport.sendMail({
    from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
}

async function sendViaSes(message: EmailMessage): Promise<void> {
  const from = fromAddress();
  if (from === '') throw new Error('SES_FROM_EMAIL is not configured');

  if (!sesClient) {
    sesClient = new SESv2Client({
      region: process.env.AWS_REGION?.trim() || DEFAULT_SES_REGION,
    });
  }

  await sesClient.send(
    new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [message.to] },
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: 'UTF-8' },
          Body: {
            Text: { Data: message.text, Charset: 'UTF-8' },
            Html: { Data: message.html, Charset: 'UTF-8' },
          },
        },
      },
    }),
  );
}

export async function deliver(
  message: EmailMessage,
): Promise<EmailDeliveryResult> {
  const mode = (process.env.EMAIL_DELIVERY ?? '').trim().toLowerCase();
  if (mode === 'discard') return 'SENT';
  if (mode === 'fail') return 'FAILED';

  try {
    if (smtpConfigured()) {
      await sendViaSmtp(message);
      return 'SENT';
    }
    if (sesConfigured()) {
      await sendViaSes(message);
      return 'SENT';
    }
  } catch (error) {
    console.error(
      `[notification] delivery failed for ${message.to}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 'FAILED';
  }

  if (isDevRuntime()) {
    console.info(
      `[notification:console] to=${message.to} subject="${message.subject}"\n${message.text}`,
    );
    return 'SENT';
  }

  console.error(
    `[notification] no email provider configured, dropped message to ${message.to}`,
  );
  return 'NOT_CONFIGURED';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function paragraphs(lines: string[]): string {
  return lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('');
}

export async function sendActivationEmail(input: {
  to: string;
  link: string;
  locale: string;
}): Promise<EmailDeliveryResult> {
  const zh = input.locale === 'zh-CN';
  const safeLink = escapeHtml(input.link);
  return deliver({
    to: input.to,
    subject: zh
      ? '激活您的 Learning Guide BackOffice 账号'
      : 'Activate your Learning Guide BackOffice account',
    text: zh
      ? `请在 48 小时内通过以下链接设置初始密码并激活账号：\n${input.link}\n\n如果链接已过期，请联系管理员重新发送。`
      : `Set your initial password within 48 hours using the link below:\n${input.link}\n\nIf the link has expired, please contact an administrator for a new one.`,
    html: zh
      ? `${paragraphs([
          '请点击下面的链接设置初始密码并激活您的 Learning Guide BackOffice 账号，链接 48 小时内有效。',
        ])}<p><a href="${safeLink}">设置密码并激活</a></p>${paragraphs([
          '如果链接已过期，请联系管理员重新发送。',
        ])}`
      : `${paragraphs([
          'Set your initial password and activate your Learning Guide BackOffice account with the link below. It expires in 48 hours.',
        ])}<p><a href="${safeLink}">Set password and activate</a></p>${paragraphs([
          'If the link has expired, please contact an administrator for a new one.',
        ])}`,
  });
}

export async function sendPasswordResetEmail(input: {
  to: string;
  link: string;
  locale: string;
}): Promise<EmailDeliveryResult> {
  const zh = input.locale === 'zh-CN';
  const safeLink = escapeHtml(input.link);
  return deliver({
    to: input.to,
    subject: zh
      ? '重置您的 Learning Guide BackOffice 密码'
      : 'Reset your Learning Guide BackOffice password',
    text: zh
      ? `请使用以下链接设置新密码（仅可使用一次）：\n${input.link}\n\n如非本人操作，请忽略本邮件并联系管理员。`
      : `Use the single-use link below to set a new password:\n${input.link}\n\nIf you did not request this, ignore this email and contact an administrator.`,
    html: zh
      ? `${paragraphs(['请点击下面的链接设置新密码，链接仅可使用一次。'])}<p><a href="${safeLink}">重置密码</a></p>${paragraphs(
          ['如非本人操作，请忽略本邮件并联系管理员。'],
        )}`
      : `${paragraphs(['Use the single-use link below to set a new password.'])}<p><a href="${safeLink}">Reset password</a></p>${paragraphs(
          ['If you did not request this, ignore this email and contact an administrator.'],
        )}`,
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
    html: zh
      ? paragraphs(['您的账号密码刚刚被修改或重置。如非本人操作，请立即联系管理员。'])
      : paragraphs([
          'The password for your account has just been changed or reset. If this was not you, contact an administrator immediately.',
        ]),
  });
}
