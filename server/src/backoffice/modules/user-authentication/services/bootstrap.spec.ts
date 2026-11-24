import { closePool, query } from '../../../lib/db';
import {
  createScratchDatabase,
  type ScratchDatabase,
} from '../../../../../test/helpers/migration-db';
import { bootstrapAdminFromEnv, initialiseSessionSecret } from './bootstrap';
import { hashPassword } from './password';
import { signIn } from './signIn';

/**
 * QA 3.1.1：迁移 20261023170000 先建了受保护占位管理员
 * admin@ilovelearningguide.com；旧启动逻辑「已有员工就跳过」会让
 * BOOTSTRAP_ADMIN_EMAIL/PASSWORD 永远无效，sandbox 部署按 env 配置的管理员无法登录。
 *
 * 每个用例都跑在迁移刚建好的临时库上（仓库既有的 migration-db 设施），
 * 用真实登录服务（signIn，含密码哈希校验）证明 env 管理员可登录。
 */
const PLACEHOLDER_EMAIL = 'admin@ilovelearningguide.com';
const ENV_EMAIL = 'sandbox-bootstrap@example.test';
const ENV_PASSWORD = 'sandbox-bootstrap-password-1';
const BASE_DATABASE_URL = process.env.DATABASE_URL?.trim() ?? '';
const describeDatabase = BASE_DATABASE_URL === '' ? describe.skip : describe;

jest.setTimeout(240_000);

type EmployeeRow = {
  employee_id: string;
  login_email: string;
  role: string;
  account_status: string;
  email_verification: string;
  password_hash: string | null;
  is_bootstrap_admin: boolean;
  updated_at: Date;
};

type AuditRow = {
  event_name: string;
  actor_employee_id: string | null;
  target_employee_id: string | null;
  action: string;
  old_value: string | null;
  new_value: string | null;
  result: string;
};

const EMPLOYEE_COLUMNS = `employee_id, login_email, role, account_status,
  email_verification, password_hash, is_bootstrap_admin, updated_at`;

describeDatabase('bootstrap admin from env on a fresh database', () => {
  const saved = {
    databaseUrl: process.env.DATABASE_URL,
    email: process.env.BOOTSTRAP_ADMIN_EMAIL,
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
  };
  let database: ScratchDatabase | null = null;

  function databaseUrlFor(name: string): string {
    const url = new URL(BASE_DATABASE_URL);
    url.pathname = `/${name}`;
    url.search = '';
    return url.toString();
  }

  /** 全新库 = 全部迁移（含 20261023170000 占位管理员），池指向该库。 */
  async function freshDatabase(): Promise<void> {
    await closePool();
    if (database) {
      await database.drop();
      database = null;
    }
    process.env.DATABASE_URL = BASE_DATABASE_URL;
    database = await createScratchDatabase();
    await database.applyMigrations();
    process.env.DATABASE_URL = databaseUrlFor(database.name);
    // 登录成功会签发会话，需要 HMAC 密钥（与真实启动顺序一致）。
    await initialiseSessionSecret();
  }

  async function employees(): Promise<EmployeeRow[]> {
    return query<EmployeeRow>(
      `SELECT ${EMPLOYEE_COLUMNS} FROM employees ORDER BY login_email`,
    );
  }

  async function rotationAudits(): Promise<AuditRow[]> {
    return query<AuditRow>(
      `SELECT event_name, actor_employee_id, target_employee_id, action,
              old_value, new_value, result
         FROM audit_events
        WHERE event_name = 'bootstrap_admin_rotated'
        ORDER BY event_id`,
    );
  }

  async function insertEmployee(input: {
    email: string;
    role: string;
    password: string;
  }): Promise<string> {
    const passwordHash = await hashPassword(input.password);
    await query(
      `INSERT INTO employees
         (login_email, role, account_status, email_verification, email_verified_at,
          password_hash)
       VALUES ($1, $2, 'ACTIVE', 'VERIFIED', now(), $3)`,
      [input.email, input.role, passwordHash],
    );
    return passwordHash;
  }

  function signInWith(email: string, password: string) {
    return signIn({
      rawEmail: email,
      password,
      ipAddress: null,
      userAgent: null,
    });
  }

  beforeEach(async () => {
    await freshDatabase();
    process.env.BOOTSTRAP_ADMIN_EMAIL = ENV_EMAIL;
    process.env.BOOTSTRAP_ADMIN_PASSWORD = ENV_PASSWORD;
  });

  afterEach(async () => {
    await closePool();
    if (database) {
      await database.drop();
      database = null;
    }
  });

  afterAll(async () => {
    await closePool();
    if (saved.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved.databaseUrl;
    if (saved.email === undefined) delete process.env.BOOTSTRAP_ADMIN_EMAIL;
    else process.env.BOOTSTRAP_ADMIN_EMAIL = saved.email;
    if (saved.password === undefined)
      delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
    else process.env.BOOTSTRAP_ADMIN_PASSWORD = saved.password;
  });

  it('has only the untouched placeholder after migrations', async () => {
    const rows = await employees();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      login_email: PLACEHOLDER_EMAIL,
      role: 'ADMIN',
      account_status: 'ACTIVE',
      email_verification: 'VERIFIED',
      is_bootstrap_admin: true,
    });
    expect(rows[0].password_hash).not.toBeNull();
  });

  it('rotates the placeholder to the env admin, who can then sign in, and audits from/to', async () => {
    const [placeholder] = await employees();

    await expect(bootstrapAdminFromEnv()).resolves.toBe('CREATED');

    const rows = await employees();
    expect(rows).toHaveLength(1);
    const rotated = rows[0];
    expect(rotated.employee_id).toBe(placeholder.employee_id);
    expect(rotated.login_email).toBe(ENV_EMAIL);
    // 保留受保护管理员的角色、状态、验证与标记。
    expect(rotated).toMatchObject({
      role: 'ADMIN',
      account_status: 'ACTIVE',
      email_verification: 'VERIFIED',
      is_bootstrap_admin: true,
    });
    expect(rotated.password_hash).not.toBe(placeholder.password_hash);

    // 登录服务真实校验密码（含 scrypt 哈希比对与会话签发）。
    const signedIn = await signInWith(ENV_EMAIL, ENV_PASSWORD);
    expect(signedIn.ok).toBe(true);
    if (signedIn.ok) {
      expect(signedIn.employee.employeeId).toBe(placeholder.employee_id);
      expect(signedIn.employee.loginEmail).toBe(ENV_EMAIL);
      expect(signedIn.employee.isBootstrapAdmin).toBe(true);
    }

    // 旧占位邮箱已不存在，不能再用 env 密码登录。
    const stale = await signInWith(PLACEHOLDER_EMAIL, ENV_PASSWORD);
    expect(stale.ok).toBe(false);

    const audits = await rotationAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      event_name: 'bootstrap_admin_rotated',
      actor_employee_id: null,
      target_employee_id: placeholder.employee_id,
      action: 'UPDATE_EMPLOYEE',
      old_value: PLACEHOLDER_EMAIL,
      new_value: ENV_EMAIL,
      result: 'SUCCESS',
    });
  });

  it('is idempotent: the next startup skips and the env admin keeps the same password', async () => {
    await expect(bootstrapAdminFromEnv()).resolves.toBe('CREATED');
    const [afterFirst] = await employees();
    const auditsAfterFirst = await rotationAudits();

    await expect(bootstrapAdminFromEnv()).resolves.toBe('SKIPPED');

    const [afterSecond] = await employees();
    expect(afterSecond).toEqual(afterFirst);
    expect(await rotationAudits()).toEqual(auditsAfterFirst);

    const signedIn = await signInWith(ENV_EMAIL, ENV_PASSWORD);
    expect(signedIn.ok).toBe(true);
  });

  it('never overwrites a real employee, and does not rotate the placeholder', async () => {
    const [placeholder] = await employees();
    const staffHash = await insertEmployee({
      email: 'real-staff@example.test',
      role: 'FINANCE',
      password: 'real-staff-password-1',
    });

    await expect(bootstrapAdminFromEnv()).resolves.toBe('SKIPPED');

    const rows = await employees();
    expect(rows).toHaveLength(2);
    const placeholderRow = rows.find(
      (row) => row.employee_id === placeholder.employee_id,
    );
    const staffRow = rows.find(
      (row) => row.login_email === 'real-staff@example.test',
    );
    expect(placeholderRow).toEqual(placeholder);
    expect(staffRow).toMatchObject({
      login_email: 'real-staff@example.test',
      role: 'FINANCE',
      is_bootstrap_admin: false,
      password_hash: staffHash,
    });

    // 真实员工的密码没被 env 密码替换，仍可登录。
    const staffSignIn = await signInWith(
      'real-staff@example.test',
      'real-staff-password-1',
    );
    expect(staffSignIn.ok).toBe(true);
    expect((await signInWith(ENV_EMAIL, ENV_PASSWORD)).ok).toBe(false);
    expect(await rotationAudits()).toHaveLength(0);
  });

  it('skips when an employee with the env email already exists', async () => {
    const [placeholder] = await employees();
    const existingHash = await insertEmployee({
      email: ENV_EMAIL,
      role: 'ADMIN',
      password: 'existing-staff-password-1',
    });

    await expect(bootstrapAdminFromEnv()).resolves.toBe('SKIPPED');

    const rows = await employees();
    const existing = rows.find((row) => row.login_email === ENV_EMAIL);
    expect(existing).toMatchObject({
      login_email: ENV_EMAIL,
      is_bootstrap_admin: false,
      password_hash: existingHash,
    });
    expect(rows.find((row) => row.login_email === PLACEHOLDER_EMAIL)).toEqual(
      placeholder,
    );

    // 已开通的账号保持原密码；env 密码没有被写进去。
    expect((await signInWith(ENV_EMAIL, 'existing-staff-password-1')).ok).toBe(
      true,
    );
    expect((await signInWith(ENV_EMAIL, ENV_PASSWORD)).ok).toBe(false);
    expect(await rotationAudits()).toHaveLength(0);
  });

  it('skips when BOOTSTRAP_ADMIN_* is missing or the credentials are invalid', async () => {
    const [placeholder] = await employees();

    delete process.env.BOOTSTRAP_ADMIN_EMAIL;
    delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
    await expect(bootstrapAdminFromEnv()).resolves.toBe('SKIPPED');

    process.env.BOOTSTRAP_ADMIN_EMAIL = ENV_EMAIL;
    process.env.BOOTSTRAP_ADMIN_PASSWORD = 'short';
    await expect(bootstrapAdminFromEnv()).resolves.toBe('SKIPPED');

    expect(await employees()).toEqual([placeholder]);
    expect(await rotationAudits()).toHaveLength(0);
  });

  it('still creates the first admin when the employees table is empty', async () => {
    // 模拟迁移前的空库：占位管理员受触发器保护，测试里临时关闭后删除。
    await query(
      `ALTER TABLE employees DISABLE TRIGGER employees_guard_bootstrap_admin`,
    );
    await query(`DELETE FROM employees`);
    await query(
      `ALTER TABLE employees ENABLE TRIGGER employees_guard_bootstrap_admin`,
    );

    await expect(bootstrapAdminFromEnv()).resolves.toBe('CREATED');

    const rows = await employees();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      login_email: ENV_EMAIL,
      role: 'ADMIN',
      account_status: 'ACTIVE',
      email_verification: 'VERIFIED',
      is_bootstrap_admin: true,
    });
    expect((await signInWith(ENV_EMAIL, ENV_PASSWORD)).ok).toBe(true);

    const created = await query<{ event_name: string }>(
      `SELECT event_name FROM audit_events WHERE event_name = 'bootstrap_admin_created'`,
    );
    expect(created).toHaveLength(1);
  });
});
