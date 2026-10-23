import type { ErrorCode } from "@/contracts/envelope";
import {
  isSignInEligible,
  isValidEmail,
  normaliseEmail,
  type SessionEmployee,
} from "@/contracts/employee";
import { tryRecordAuditEvent } from "@/repositories/auditRepository";
import * as employeeRepository from "@/repositories/employeeRepository";
import { issueSession, toSessionEmployee } from "@/modules/user-authentication/services/session";
import { verifyPassword } from "@/modules/user-authentication/services/password";

export type EmailCheckResult = {
  exists: boolean;
  eligible: boolean;
  displayStatus: string | null;
};

/**
 * PRD PORT-LOG-002 / BR-PORT-006：
 * 只有 Active + Verified 才返回可登录；其余状态不给绿勾。
 */
export async function checkEmployeeEmail(rawEmail: string): Promise<EmailCheckResult> {
  if (!isValidEmail(rawEmail)) return { exists: false, eligible: false, displayStatus: null };

  const employee = await employeeRepository.findByLoginEmail(normaliseEmail(rawEmail));
  if (!employee) return { exists: false, eligible: false, displayStatus: null };

  return {
    exists: employee.emailVerification === "VERIFIED",
    eligible: isSignInEligible(employee.accountStatus, employee.emailVerification),
    displayStatus:
      employee.accountStatus === "INACTIVE"
        ? "Inactive"
        : employee.emailVerification === "VERIFIED"
          ? "Active"
          : "Pending",
  };
}

export type SignInOutcome =
  | { ok: true; employee: SessionEmployee; token: string; maxAgeSeconds: number }
  | { ok: false; code: ErrorCode };

/** PRD PORT-LOG-004 / BR-PORT-005。 */
export async function signIn(input: {
  rawEmail: string;
  password: string;
  ipAddress: string | null;
  userAgent: string | null;
}): Promise<SignInOutcome> {
  const email = normaliseEmail(input.rawEmail);

  if (!isValidEmail(email) || input.password.length === 0) {
    await tryRecordAuditEvent({
      eventName: "employee_login_attempt",
      actorEmployeeId: null,
      targetEmployeeId: null,
      action: "SIGN_IN",
      result: "FAILURE",
      ipAddress: input.ipAddress,
    });
    return { ok: false, code: "INVALID_INPUT" };
  }

  const employee = await employeeRepository.findByLoginEmail(email);
  if (!employee) {
    await tryRecordAuditEvent({
      eventName: "employee_login_attempt",
      actorEmployeeId: null,
      targetEmployeeId: null,
      action: "SIGN_IN",
      result: "FAILURE",
      ipAddress: input.ipAddress,
    });
    return { ok: false, code: "INVALID_EMPLOYEE_ACCOUNT" };
  }

  const auditBase = {
    eventName: "employee_login_attempt",
    actorEmployeeId: employee.employeeId,
    targetEmployeeId: employee.employeeId,
    action: "SIGN_IN",
    ipAddress: input.ipAddress,
  };

  if (employee.accountStatus !== "ACTIVE") {
    await tryRecordAuditEvent({ ...auditBase, result: "DENIED" });
    return { ok: false, code: "ACCOUNT_NOT_ACTIVE" };
  }

  if (employee.emailVerification !== "VERIFIED") {
    await tryRecordAuditEvent({ ...auditBase, result: "DENIED" });
    return { ok: false, code: "EMAIL_NOT_VERIFIED" };
  }

  if (!employee.passwordHash || !(await verifyPassword(input.password, employee.passwordHash))) {
    await tryRecordAuditEvent({ ...auditBase, result: "FAILURE" });
    return { ok: false, code: "INVALID_CREDENTIALS" };
  }

  const session = await issueSession({
    employeeId: employee.employeeId,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  await employeeRepository.touchLastLogin(employee.employeeId);
  await tryRecordAuditEvent({ ...auditBase, result: "SUCCESS" });

  return {
    ok: true,
    employee: toSessionEmployee(employee),
    token: session.token,
    maxAgeSeconds: session.maxAgeSeconds,
  };
}
