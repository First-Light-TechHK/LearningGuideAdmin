import {
  deriveDisplayStatus,
  displayNameFromEmail,
  isSignInEligible,
  type SessionEmployee,
} from '../../../contracts/employee';
import {
  SESSION_IDLE_MINUTES,
  SESSION_MAX_HOURS,
} from '../../../lib/securityPolicy';
import * as employeeRepository from '../../../repositories/employeeRepository';
import * as sessionRepository from '../../../repositories/sessionRepository';
import type { EmployeeRecord } from '../../../repositories/employeeRepository';
import { generateRawToken, hashToken } from './tokenHash';

export function toSessionEmployee(record: EmployeeRecord): SessionEmployee {
  return {
    employeeId: record.employeeId,
    loginEmail: record.loginEmail,
    role: record.role,
    displayName: displayNameFromEmail(record.loginEmail),
    accountStatus: record.accountStatus,
    emailVerification: record.emailVerification,
    displayStatus: deriveDisplayStatus(
      record.accountStatus,
      record.emailVerification,
    ),
    isBootstrapAdmin: record.isBootstrapAdmin,
  };
}

export async function issueSession(input: {
  employeeId: string;
  ipAddress: string | null;
  userAgent: string | null;
}): Promise<{ token: string; maxAgeSeconds: number }> {
  const token = generateRawToken();
  const maxAgeSeconds = SESSION_MAX_HOURS * 60 * 60;

  await sessionRepository.createSession({
    employeeId: input.employeeId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + maxAgeSeconds * 1000),
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  return { token, maxAgeSeconds };
}

/**
 * PRD §15.3 的服务端部分：
 * Session → Account Status → Email Verification；
 * 任一步不满足立即吊销会话，实现 BR-PORT-013 的"立即生效"。
 */
export async function resolveSession(
  rawToken: string | undefined,
): Promise<SessionEmployee | null> {
  if (!rawToken) return null;

  const idleCutoff = new Date(Date.now() - SESSION_IDLE_MINUTES * 60 * 1000);
  const session = await sessionRepository.findActiveSession(
    hashToken(rawToken),
    idleCutoff,
  );
  if (!session) return null;

  const employee = await employeeRepository.findById(session.employeeId);
  if (!employee) {
    await sessionRepository.revokeSession(session.sessionId);
    return null;
  }

  if (!isSignInEligible(employee.accountStatus, employee.emailVerification)) {
    await sessionRepository.revokeSession(session.sessionId);
    return null;
  }

  await sessionRepository.touchSession(session.sessionId);
  return toSessionEmployee(employee);
}

export async function destroySession(
  rawToken: string | undefined,
): Promise<void> {
  if (!rawToken) return;
  await sessionRepository.revokeByTokenHash(hashToken(rawToken));
}
