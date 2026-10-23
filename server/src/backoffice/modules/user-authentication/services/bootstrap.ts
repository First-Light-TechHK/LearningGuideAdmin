import type { ErrorCode } from '../../../contracts/envelope';
import { isValidEmail, normaliseEmail } from '../../../contracts/employee';
import { query, withTransaction } from '../../../lib/db';
import {
  configuredSessionSecret,
  generateSecret,
  usePersistedSessionSecret,
} from '../../../lib/env';
import { isPasswordAcceptable } from '../../../lib/securityPolicy';
import { tryRecordAuditEvent } from '../../../repositories/auditRepository';
import { hashPassword } from './password';

const SESSION_SECRET_KEY = 'session_secret';

/**
 * 会话/令牌 HMAC 密钥：配置了 SESSION_SECRET 就用它；
 * 否则首次启动生成一份随机密钥存进 backoffice_settings，多实例共享且重启不变。
 */
export async function initialiseSessionSecret(): Promise<void> {
  if (configuredSessionSecret()) return;
  await query(
    `INSERT INTO backoffice_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
    [SESSION_SECRET_KEY, generateSecret()],
  );
  const rows = await query<{ value: string }>(
    `SELECT value FROM backoffice_settings WHERE key = $1`,
    [SESSION_SECRET_KEY],
  );
  const secret = rows[0]?.value;
  if (!secret)
    throw new Error('Unable to initialise the BackOffice session secret');
  usePersistedSessionSecret(secret);
}

export async function employeeCount(): Promise<number> {
  const rows = await query<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM employees`,
  );
  return Number(rows[0]?.total ?? '0');
}

export type SetupOutcome = { ok: true } | { ok: false; code: ErrorCode };

/**
 * 首个受保护管理员（PRD PORT-BOOT）。只在一个员工都没有时可用；
 * 加事务级 advisory lock，并发提交只有一个成功。
 */
export async function createFirstAdmin(input: {
  rawEmail: string;
  password: string;
  confirmPassword: string;
  ipAddress: string | null;
}): Promise<SetupOutcome> {
  const email = normaliseEmail(input.rawEmail);
  if (!isValidEmail(email)) return { ok: false, code: 'INVALID_INPUT' };
  if (input.password !== input.confirmPassword)
    return { ok: false, code: 'PASSWORD_MISMATCH' };
  if (!isPasswordAcceptable(input.password))
    return { ok: false, code: 'PASSWORD_TOO_WEAK' };

  const passwordHash = await hashPassword(input.password);
  const created = await withTransaction(async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('backoffice_first_admin'))`,
    );
    const existing = await client.query(`SELECT 1 FROM employees LIMIT 1`);
    if ((existing.rowCount ?? 0) > 0) return null;
    const result = await client.query<{ employee_id: string }>(
      `INSERT INTO employees
         (login_email, role, account_status, email_verification, email_verified_at,
          password_hash, is_bootstrap_admin)
       VALUES ($1, 'ADMIN', 'ACTIVE', 'VERIFIED', now(), $2, true)
       RETURNING employee_id`,
      [email, passwordHash],
    );
    return result.rows[0]?.employee_id ?? null;
  });

  if (!created) return { ok: false, code: 'NOT_AUTHORISED' };
  await tryRecordAuditEvent({
    eventName: 'bootstrap_admin_created',
    actorEmployeeId: created,
    targetEmployeeId: created,
    action: 'SETUP',
    result: 'SUCCESS',
    ipAddress: input.ipAddress,
  });
  return { ok: true };
}

/**
 * 部署时用环境变量建首个管理员（BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD），
 * 已有员工则不做任何事，不会覆盖现有账号。
 */
export async function bootstrapAdminFromEnv(): Promise<'CREATED' | 'SKIPPED'> {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim() ?? '';
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '';
  if (email === '' || password === '') return 'SKIPPED';
  const outcome = await createFirstAdmin({
    rawEmail: email,
    password,
    confirmPassword: password,
    ipAddress: null,
  });
  return outcome.ok ? 'CREATED' : 'SKIPPED';
}
