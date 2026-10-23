import { isDevRuntime } from "@/lib/env";

export type EmailDeliveryResult = "SENT" | "FAILED" | "NOT_CONFIGURED";

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
export async function deliver(message: EmailMessage): Promise<EmailDeliveryResult> {
  const provider = process.env.SES_FROM_EMAIL?.trim() ?? "";

  if (provider === "") {
    if (isDevRuntime()) {
      console.info(
        `[notification:console] to=${message.to} subject="${message.subject}"\n${message.text}`
      );
      return "SENT";
    }
    console.error(`[notification] no email provider configured, dropped message to ${message.to}`);
    return "NOT_CONFIGURED";
  }

  // 生产投递实现（SES/SMTP）在切片 2 接入；在此之前明确失败而不是伪装成功。
  console.error(`[notification] provider configured but adapter not implemented: ${provider}`);
  return "NOT_CONFIGURED";
}

export async function sendActivationEmail(input: {
  to: string;
  link: string;
  locale: string;
}): Promise<EmailDeliveryResult> {
  const zh = input.locale === "zh-CN";
  return deliver({
    to: input.to,
    subject: zh
      ? "激活您的 Learning Guide BackOffice 账号"
      : "Activate your Learning Guide BackOffice account",
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
  const zh = input.locale === "zh-CN";
  return deliver({
    to: input.to,
    subject: zh ? "重置您的 Learning Guide BackOffice 密码" : "Reset your Learning Guide BackOffice password",
    text: zh
      ? `请使用以下链接设置新密码（仅可使用一次）：\n${input.link}\n\n如非本人操作，请忽略本邮件并联系管理员。`
      : `Use the single-use link below to set a new password:\n${input.link}\n\nIf you did not request this, ignore this email and contact an administrator.`,
  });
}

export async function sendPasswordChangedEmail(input: {
  to: string;
  locale: string;
}): Promise<EmailDeliveryResult> {
  const zh = input.locale === "zh-CN";
  return deliver({
    to: input.to,
    subject: zh ? "您的 Learning Guide BackOffice 密码已变更" : "Your Learning Guide BackOffice password changed",
    text: zh
      ? "您的账号密码刚刚被修改或重置。如非本人操作，请立即联系管理员。"
      : "The password for your account has just been changed or reset. If this was not you, contact an administrator immediately.",
  });
}
