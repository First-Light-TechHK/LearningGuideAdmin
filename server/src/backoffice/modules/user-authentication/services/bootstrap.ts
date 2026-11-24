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
 * 迁移 20261023170000_backoffice_default_admin 写入的受保护占位管理员邮箱。
 * 只有 login_email 仍是这个值、且 is_bootstrap_admin=true 的「未被动过」占位行
 * 才允许在启动时被 env 管理员轮换；改过的行按真实账号对待。
 */
const PLACEHOLDER_ADMIN_EMAIL = 'admin@ilovelearningguide.com';

/** createFirstAdmin 与占位管理员轮换共用的事务级 lock：并发启动只有一个能写员工表。 */
const FIRST_ADMIN_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext('backoffice_first_admin'))`;

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
    await client.query(FIRST_ADMIN_LOCK_SQL);
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

type PlaceholderRotation = { employeeId: string; fromEmail: string };

/**
 * 把「迁移留下的、未被动过的占位管理员」一次性轮换成 env 管理员。
 * 返回 null 表示不该/不能轮换：env 邮箱已开通（含轮换后的再次启动，幂等）、
 * 除占位行外还有员工（不覆盖真实账号）、或占位行已被改过。
 * 与 createFirstAdmin 共用同一把 advisory lock；轮换只改 login_email/password_hash，
 * role/account_status/email_verification/is_bootstrap_admin 原样保留（触发器兜底）。
 */
async function rotateUntouchedPlaceholder(
  email: string,
  passwordHash: string,
): Promise<PlaceholderRotation | null> {
  return withTransaction(async (client) => {
    await client.query(FIRST_ADMIN_LOCK_SQL);
    const result = await client.query<{
      employee_id: string;
      login_email: string;
      is_bootstrap_admin: boolean;
    }>(
      `SELECT employee_id, login_email, is_bootstrap_admin
         FROM employees
        FOR UPDATE`,
    );
    const existing = result.rows;
    // env 邮箱已开通：跳过（轮换成功后再次启动也走这里，保持幂等）。
    if (existing.some((row) => row.login_email === email)) return null;
    // 占位管理员之外还有员工：真实账号在用，绝不覆盖。
    if (existing.length !== 1) return null;
    const only = existing[0];
    // login_email 已改过 = 占位账号被动过，不再视为可轮换的占位行。
    if (
      !only.is_bootstrap_admin ||
      only.login_email !== PLACEHOLDER_ADMIN_EMAIL
    )
      return null;

    await client.query(
      `UPDATE employees
          SET login_email = $1, password_hash = $2, updated_at = now()
        WHERE employee_id = $3`,
      [email, passwordHash, only.employee_id],
    );
    return { employeeId: only.employee_id, fromEmail: only.login_email };
  });
}

/**
 * 部署时用环境变量建首个管理员（BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD）。
 *
 * QA 3.1.1：迁移 20261023170000 会先建受保护的占位管理员；旧规则「已有员工就跳过」
 * 让 sandbox 部署按 env 配置的管理员永远无法登录。启动路径的规则：
 * - 没有员工：照旧用 createFirstAdmin 建号；
 * - 唯一员工仍是未被动过的占位管理员（is_bootstrap_admin=true、login_email 未变）：
 *   一次性轮换成 env 邮箱 + 新密码哈希（保留 ADMIN/ACTIVE/VERIFIED/is_bootstrap_admin），
 *   并写审计事件 bootstrap_admin_rotated（old/new 为 from/to 邮箱）；
 * - env 邮箱已存在（含轮换后的再次启动）：跳过，幂等；
 * - 除占位管理员外还有员工：跳过，不覆盖真实账号；
 * - env 未配置或凭据不合法：跳过。
 * createFirstAdmin（页面 /api/auth/setup）的行为不变，本函数只服务服务启动路径。
 */
export async function bootstrapAdminFromEnv(): Promise<'CREATED' | 'SKIPPED'> {
  const rawEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim() ?? '';
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '';
  if (rawEmail === '' || password === '') return 'SKIPPED';

  const email = normaliseEmail(rawEmail);
  // 与 createFirstAdmin 相同的凭据门槛：不合格的 env 凭据不能轮换占位管理员。
  if (!isValidEmail(email) || !isPasswordAcceptable(password)) return 'SKIPPED';

  if ((await employeeCount()) === 0) {
    const outcome = await createFirstAdmin({
      rawEmail: email,
      password,
      confirmPassword: password,
      ipAddress: null,
    });
    return outcome.ok ? 'CREATED' : 'SKIPPED';
  }

  const rotation = await rotateUntouchedPlaceholder(
    email,
    await hashPassword(password),
  );
  if (!rotation) return 'SKIPPED';
  await tryRecordAuditEvent({
    eventName: 'bootstrap_admin_rotated',
    actorEmployeeId: null,
    targetEmployeeId: rotation.employeeId,
    action: 'UPDATE_EMPLOYEE',
    oldValue: rotation.fromEmail,
    newValue: email,
    result: 'SUCCESS',
    ipAddress: null,
  });
  // 轮换后 env 管理员已可用，对启动方按 CREATED 报告；轮换语义由审计事件保留。
  return 'CREATED';
}
