import type { ErrorCode } from "@/contracts/envelope";
import { isValidEmail, normaliseEmail, type SessionEmployee } from "@/contracts/employee";
import { isPasswordAcceptable } from "@/lib/securityPolicy";
import { tryRecordAuditEvent } from "@/repositories/auditRepository";
import * as employeeRepository from "@/repositories/employeeRepository";
import * as sessionRepository from "@/repositories/sessionRepository";
import {
  isDelivered,
  sendActivationEmail as sendActivationEmail_,
  sendPasswordChangedEmail as sendPasswordChanged,
  sendPasswordResetEmail as sendPasswordReset,
} from "@/modules/notification/services/email";
import { hashPassword, verifyPassword } from "@/modules/user-authentication/services/password";
import {
  activationLink,
  consumeOnce,
  inspectToken,
  issueActivationToken,
  issueResetToken,
  resetLink,
  revokeTokensForEmployee,
  tokenStateToErrorCode,
} from "@/modules/user-authentication/services/verificationTokens";

export type FlowOutcome = { ok: true } | { ok: false; code: ErrorCode };

function validateNewPassword(password: string, confirmPassword: string): ErrorCode | null {
  if (password !== confirmPassword) return "PASSWORD_MISMATCH";
  if (!isPasswordAcceptable(password)) return "PASSWORD_TOO_WEAK";
  return null;
}

/** PRD PORT-ACT-002 / PORT-ACT-003：激活链接设置初始密码并完成验证。 */
export async function activateWithToken(input: {
  rawToken: string;
  password: string;
  confirmPassword: string;
  ipAddress: string | null;
  locale: string;
}): Promise<FlowOutcome> {
  const invalid = validateNewPassword(input.password, input.confirmPassword);
  if (invalid) return { ok: false, code: invalid };

  const inspected = await inspectToken(input.rawToken, "ACTIVATION");
  if (inspected.state !== "USABLE" || !inspected.tokenId || !inspected.employeeId) {
    // PORT-ACT-003：区分过期与已使用，页面据此显示专用提示
    return { ok: false, code: tokenStateToErrorCode(inspected.state) };
  }

  const consumed = await consumeOnce(inspected.tokenId);
  if (!consumed) return { ok: false, code: "INVALID_TOKEN" };

  const passwordHash = await hashPassword(input.password);
  await employeeRepository.setPasswordAndVerify(inspected.employeeId, passwordHash);

  // 验证只改变 Verification，不改 Account Status（PRD BR-PORT-012 同理）
  const employee = await employeeRepository.findById(inspected.employeeId);
  await tryRecordAuditEvent({
    eventName: "activation_completed",
    actorEmployeeId: inspected.employeeId,
    targetEmployeeId: inspected.employeeId,
    action: "ACTIVATE",
    result: "SUCCESS",
    ipAddress: input.ipAddress,
  });

  if (employee) {
    await sendPasswordChanged({ to: employee.loginEmail, locale: input.locale });
  }

  return { ok: true };
}

/**
 * PRD PORT-PWD-001：只有 Active + Verified 才真正发信，
 * 但对外始终返回一致结果，避免账号枚举。
 */
export async function requestPasswordReset(input: {
  rawEmail: string;
  ipAddress: string | null;
  locale: string;
}): Promise<FlowOutcome> {
  const email = normaliseEmail(input.rawEmail);
  if (!isValidEmail(email)) return { ok: true };

  const employee = await employeeRepository.findByLoginEmail(email);
  const eligible =
    employee !== null &&
    employee.accountStatus === "ACTIVE" &&
    employee.emailVerification === "VERIFIED";

  if (!employee || !eligible) {
    await tryRecordAuditEvent({
      eventName: "password_reset_sent",
      actorEmployeeId: employee?.employeeId ?? null,
      targetEmployeeId: employee?.employeeId ?? null,
      action: "SELF_SERVICE_RESET",
      result: "DENIED",
      ipAddress: input.ipAddress,
    });
    return { ok: true };
  }

  const rawToken = await issueResetToken(employee.employeeId);
  const result = await sendPasswordReset({
    to: employee.loginEmail,
    link: resetLink(input.locale, rawToken),
    locale: input.locale,
  });

  await tryRecordAuditEvent({
    eventName: "password_reset_sent",
    actorEmployeeId: employee.employeeId,
    targetEmployeeId: employee.employeeId,
    action: "SELF_SERVICE_RESET",
    newValue: result,
    result: isDelivered(result) ? "SUCCESS" : "FAILURE",
    ipAddress: input.ipAddress,
  });

  return { ok: true };
}

/** PRD PORT-PWD-002 / PORT-PWD-004。 */
export async function resetWithToken(input: {
  rawToken: string;
  password: string;
  confirmPassword: string;
  ipAddress: string | null;
  locale: string;
}): Promise<FlowOutcome> {
  const invalid = validateNewPassword(input.password, input.confirmPassword);
  if (invalid) return { ok: false, code: invalid };

  const inspected = await inspectToken(input.rawToken, "PASSWORD_RESET");
  if (inspected.state !== "USABLE" || !inspected.tokenId || !inspected.employeeId) {
    return { ok: false, code: tokenStateToErrorCode(inspected.state) };
  }

  const consumed = await consumeOnce(inspected.tokenId);
  if (!consumed) return { ok: false, code: "INVALID_TOKEN" };

  const passwordHash = await hashPassword(input.password);
  await employeeRepository.setPasswordAndVerify(inspected.employeeId, passwordHash);

  // 重置后旧会话全部失效（PRD PORT-SES-003）
  await sessionRepository.revokeAllForEmployee(inspected.employeeId);

  const employee = await employeeRepository.findById(inspected.employeeId);
  await tryRecordAuditEvent({
    eventName: "password_reset_completed",
    actorEmployeeId: inspected.employeeId,
    targetEmployeeId: inspected.employeeId,
    action: "RESET_PASSWORD",
    result: "SUCCESS",
    ipAddress: input.ipAddress,
  });

  if (employee) {
    await sendPasswordChanged({ to: employee.loginEmail, locale: input.locale });
  }

  return { ok: true };
}

/** PRD PORT-PWD-005 / PORT-PWD-006：改密成功后强制重新登录。 */
export async function changeOwnPassword(input: {
  employee: SessionEmployee;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
  ipAddress: string | null;
  locale: string;
}): Promise<FlowOutcome> {
  const invalid = validateNewPassword(input.newPassword, input.confirmPassword);
  if (invalid) return { ok: false, code: invalid };

  const record = await employeeRepository.findById(input.employee.employeeId);
  if (!record?.passwordHash) return { ok: false, code: "INVALID_CREDENTIALS" };

  if (!(await verifyPassword(input.currentPassword, record.passwordHash))) {
    await tryRecordAuditEvent({
      eventName: "employee_password_changed",
      actorEmployeeId: record.employeeId,
      targetEmployeeId: record.employeeId,
      action: "CHANGE_PASSWORD",
      result: "FAILURE",
      ipAddress: input.ipAddress,
    });
    return { ok: false, code: "INVALID_CREDENTIALS" };
  }

  const passwordHash = await hashPassword(input.newPassword);
  await employeeRepository.setPasswordAndVerify(record.employeeId, passwordHash);
  await revokeTokensForEmployee(record.employeeId);
  await sessionRepository.revokeAllForEmployee(record.employeeId);

  await tryRecordAuditEvent({
    eventName: "employee_password_changed",
    actorEmployeeId: record.employeeId,
    targetEmployeeId: record.employeeId,
    action: "CHANGE_PASSWORD",
    result: "SUCCESS",
    ipAddress: input.ipAddress,
  });

  await sendPasswordChanged({ to: record.loginEmail, locale: input.locale });

  return { ok: true };
}

/** 管理员触发重发激活邮件（PORT-ACT-004）。 */
export async function reissueActivation(input: {
  employeeId: string;
  locale: string;
  ipAddress: string | null;
  actorEmployeeId: string;
}): Promise<{ ok: true; delivery: string } | { ok: false; code: ErrorCode }> {
  const employee = await employeeRepository.findById(input.employeeId);
  if (!employee) return { ok: false, code: "INVALID_INPUT" };
  if (employee.emailVerification === "VERIFIED") return { ok: false, code: "INVALID_INPUT" };

  const rawToken = await issueActivationToken(employee.employeeId);
  const delivery = await sendActivationEmail_({
    to: employee.loginEmail,
    link: activationLink(input.locale, rawToken),
    locale: input.locale,
  });

  await tryRecordAuditEvent({
    eventName: "activation_sent",
    actorEmployeeId: input.actorEmployeeId,
    targetEmployeeId: employee.employeeId,
    action: "RESEND_ACTIVATION",
    newValue: delivery,
    result: isDelivered(delivery) ? "SUCCESS" : "FAILURE",
    ipAddress: input.ipAddress,
  });

  return { ok: true, delivery };
}
