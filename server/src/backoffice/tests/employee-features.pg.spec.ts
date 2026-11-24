import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

import { parseEnabledCapabilities } from '../../common/capabilities';
import * as db from '../lib/db';
import {
  getEmployeeFeatures,
  saveEmployeeFeatures,
} from '../modules/rbac/employeeFeatures';
import { updateEmployee } from '../modules/employee-account/services/employeeAccount';
import {
  effectiveModuleLevel,
  type FeatureGrantMap,
  type FeatureKey,
} from '../modules/rbac/features';
import * as featureGrantRepository from '../repositories/featureGrantRepository';

/**
 * 账号级功能开关的数据层（owner 2026-11-20）：真实 PostgreSQL，独立 schema，
 * 只跑员工身份与功能开关两个迁移。覆盖读/写/清空、输入校验、审计 before/after、
 * 以及「最后一个可用 Admin 的账号管理不能被关掉」的保护。
 * 需要 HELPDESK_TEST_DATABASE_URL（本地临时库）；CI 里必须有。
 */
const url = process.env.HELPDESK_TEST_DATABASE_URL;
if (!url && process.env.CI === 'true')
  throw new Error('HELPDESK_TEST_DATABASE_URL is required when CI=true');
const describeDb = url ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '../../../prisma/migrations');
const ALL = parseEnabledCapabilities(undefined);

const ADMIN_A = '0192cccc-0000-7000-8000-000000000001';
const ADMIN_B = '0192cccc-0000-7000-8000-000000000002';
const FINANCE_C = '0192cccc-0000-7000-8000-000000000003';

describeDb('employee feature grants (PostgreSQL)', () => {
  const schema = `effeatures_${process.pid}_${Date.now()}`;
  const saved = { url: process.env.DATABASE_URL };
  let admin: Pool;

  async function insertEmployee(
    employeeId: string,
    email: string,
    role: string,
    status = 'ACTIVE',
    verification = 'VERIFIED',
  ): Promise<void> {
    await db.query(
      `INSERT INTO employees
         (employee_id, login_email, role, account_status, email_verification,
          email_verified_at, password_hash)
       VALUES ($1, $2, $3, $4, $5, now(), 'scrypt$x')`,
      [employeeId, email, role, status, verification],
    );
  }

  async function grantRows(): Promise<
    Array<{ feature: string; allowed: boolean }>
  > {
    return db.query<{ feature: string; allowed: boolean }>(
      `SELECT feature, allowed FROM employee_feature_grants
        WHERE employee_id = $1 ORDER BY feature`,
      [ADMIN_A],
    );
  }

  async function latestAudit(): Promise<{
    event_name: string;
    actor_employee_id: string;
    target_employee_id: string;
    old_value: string;
    new_value: string;
    result: string;
  } | null> {
    const rows = await db.query<{
      event_name: string;
      actor_employee_id: string;
      target_employee_id: string;
      old_value: string;
      new_value: string;
      result: string;
    }>(
      `SELECT event_name, actor_employee_id, target_employee_id, old_value, new_value, result
         FROM audit_events
        WHERE event_name = 'EMPLOYEE_FEATURES_CHANGED' AND target_employee_id = $1
        ORDER BY event_id DESC LIMIT 1`,
      [ADMIN_A],
    );
    return rows[0] ?? null;
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url as string);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    await db.closePool();
    process.env.DATABASE_URL = scoped.toString();
    await db.query(
      readdirSync(MIGRATIONS)
        .filter(
          (dir) =>
            dir.endsWith('backoffice_employees') ||
            dir.endsWith('employee_feature_grants'),
        )
        .sort()
        .map((dir) =>
          readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8'),
        )
        .join('\n'),
    );
  }, 60_000);

  afterAll(async () => {
    await db.closePool();
    process.env.DATABASE_URL = saved.url;
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await db.query(
      `TRUNCATE employee_feature_grants, audit_events, employees CASCADE`,
    );
    await insertEmployee(ADMIN_A, 'admin.a@example.com', 'ADMIN');
    await insertEmployee(ADMIN_B, 'admin.b@example.com', 'ADMIN');
    await insertEmployee(FINANCE_C, 'finance.c@example.com', 'FINANCE');
  });

  describe('repository', () => {
    it('reads, replaces and clears the explicit switches', async () => {
      await featureGrantRepository.replaceForEmployee(
        ADMIN_A,
        [
          { feature: 'module.knowledge', allowed: true },
          { feature: 'course.publish', allowed: false },
        ],
        ADMIN_B,
      );
      let map: FeatureGrantMap =
        await featureGrantRepository.mapForEmployee(ADMIN_A);
      expect(map.get('module.knowledge')).toBe(true);
      expect(map.get('course.publish')).toBe(false);
      expect(map.size).toBe(2);

      const rows = await db.query<{ updated_by: string | null }>(
        `SELECT updated_by FROM employee_feature_grants WHERE employee_id = $1`,
        [ADMIN_A],
      );
      expect(rows.every((row) => row.updated_by === ADMIN_B)).toBe(true);

      // PUT 是全量语义：第二次只提交发布开关，此前的 knowledge 行被清掉
      await featureGrantRepository.replaceForEmployee(
        ADMIN_A,
        [{ feature: 'course.publish', allowed: true }],
        ADMIN_A,
      );
      map = await featureGrantRepository.mapForEmployee(ADMIN_A);
      expect(map.size).toBe(1);
      expect(map.has('module.knowledge')).toBe(false);
      expect(map.get('course.publish')).toBe(true);

      // 幂等：同样内容再写一次结果不变
      await featureGrantRepository.replaceForEmployee(
        ADMIN_A,
        [{ feature: 'course.publish', allowed: true }],
        ADMIN_A,
      );
      expect((await grantRows()).length).toBe(1);

      await featureGrantRepository.clearForEmployee(ADMIN_A);
      expect(await grantRows()).toEqual([]);
    });

    it('counts only other usable Admins whose accounts switch is not off', async () => {
      expect(
        await featureGrantRepository.countOtherAccountsCapableAdmins(ADMIN_A),
      ).toBe(1);
      await featureGrantRepository.replaceForEmployee(
        ADMIN_B,
        [{ feature: 'module.accounts', allowed: false }],
        ADMIN_A,
      );
      expect(
        await featureGrantRepository.countOtherAccountsCapableAdmins(ADMIN_A),
      ).toBe(0);
      // 非 Admin 不算
      await featureGrantRepository.clearForEmployee(ADMIN_B);
      await featureGrantRepository.replaceForEmployee(
        FINANCE_C,
        [{ feature: 'module.accounts', allowed: true }],
        ADMIN_A,
      );
      expect(
        await featureGrantRepository.countOtherAccountsCapableAdmins(ADMIN_A),
      ).toBe(1);
    });
  });

  describe('service', () => {
    it('returns the full catalogue plus explicit grants and effective result', async () => {
      await featureGrantRepository.replaceForEmployee(
        FINANCE_C,
        [
          { feature: 'module.knowledge', allowed: true },
          { feature: 'course.publish', allowed: true },
        ],
        ADMIN_A,
      );
      const view = await getEmployeeFeatures(FINANCE_C, ALL);
      expect(view).not.toBeNull();
      // 10 module + 5 课程动作（新建/删除不在账号级目录里）
      expect(view?.catalog.length).toBe(15);
      expect(view?.catalog.map((entry) => entry.key)).not.toContain(
        'course.create',
      );
      expect(view?.catalog.map((entry) => entry.key)).not.toContain(
        'course.delete',
      );
      expect(view?.grants.map((row) => row.feature)).toEqual([
        'module.knowledge',
        'course.publish',
      ]);
      const byKey = new Map(
        (view?.effective ?? []).map((entry) => [entry.key, entry]),
      );
      expect(byKey.get('module.knowledge')?.allowed).toBe(true);
      expect(byKey.get('module.knowledge')?.level).toBe('VIEW');
      expect(byKey.get('course.publish')?.allowed).toBe(true);
      expect(byKey.get('course.import')?.allowed).toBe(false);
      expect(byKey.get('module.accounts')?.level).toBe('NONE');
    });

    it('returns null for an unknown employee', async () => {
      expect(
        await getEmployeeFeatures('0192cccc-0000-7000-8000-00000000ffff', ALL),
      ).toBeNull();
    });

    it('rejects unknown keys, duplicates and non-boolean switches', async () => {
      for (const grants of [
        [{ feature: 'module.unknown', allowed: true }],
        // 新建/删除已从账号级功能目录移除：PUT 不能再写入它们
        [{ feature: 'course.create', allowed: true }],
        [{ feature: 'course.delete', allowed: true }],
        [{ feature: 'course.publish', allowed: 'yes' }],
        [
          { feature: 'course.publish', allowed: true },
          { feature: 'course.publish', allowed: false },
        ],
        'nope',
        {},
        [null],
      ]) {
        const outcome = await saveEmployeeFeatures({
          employeeId: ADMIN_A,
          grants,
          actorEmployeeId: ADMIN_B,
          ipAddress: '127.0.0.1',
          enabledCapabilities: ALL,
        });
        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && outcome.code).toBe('INVALID_INPUT');
      }
      expect(await grantRows()).toEqual([]);
    });

    it('ignores stale rows for keys removed from the catalogue (idempotent on read)', async () => {
      // 升级前的存量行：功能目录里已经没有 course.create / course.delete。
      await db.query(
        `INSERT INTO employee_feature_grants
           (employee_id, feature, allowed, updated_by)
         VALUES ($1, 'course.create', true, $2),
                ($1, 'course.delete', true, $2),
                ($1, 'course.publish', true, $2)`,
        [FINANCE_C, ADMIN_A],
      );

      // 读取：未知 key 按"继承角色"处理，不出现在 grants / effective / catalog。
      const map = await featureGrantRepository.mapForEmployee(FINANCE_C);
      expect(map.has('course.create' as unknown as FeatureKey)).toBe(false);
      expect(map.has('course.delete' as unknown as FeatureKey)).toBe(false);
      expect(map.get('course.publish')).toBe(true);

      const view = await getEmployeeFeatures(FINANCE_C, ALL);
      expect(view?.grants.map((row) => row.feature)).toEqual([
        'course.publish',
      ]);
      const effectiveKeys = (view?.effective ?? []).map((entry) => entry.key);
      expect(effectiveKeys).not.toContain('course.create');
      expect(effectiveKeys).not.toContain('course.delete');

      // 再保存一次（全量替换）会把存量行清掉，展示结果保持一致（幂等）。
      const saved = await saveEmployeeFeatures({
        employeeId: FINANCE_C,
        grants: [{ feature: 'course.publish', allowed: true }],
        actorEmployeeId: ADMIN_A,
        ipAddress: null,
        enabledCapabilities: ALL,
      });
      expect(saved.ok).toBe(true);
      const rows = await db.query<{ feature: string }>(
        `SELECT feature FROM employee_feature_grants
          WHERE employee_id = $1 ORDER BY feature`,
        [FINANCE_C],
      );
      expect(rows.map((row) => row.feature)).toEqual(['course.publish']);
      const after = await getEmployeeFeatures(FINANCE_C, ALL);
      const shape = (grants: typeof view) =>
        grants?.grants.map(({ feature, allowed }) => ({ feature, allowed }));
      expect(shape(after)).toEqual(shape(view));
      expect(after?.effective).toEqual(view?.effective);
    });

    it('rejects a nonexistent employee', async () => {
      const outcome = await saveEmployeeFeatures({
        employeeId: '0192cccc-0000-7000-8000-00000000ffff',
        grants: [],
        actorEmployeeId: ADMIN_A,
        ipAddress: null,
        enabledCapabilities: ALL,
      });
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.code).toBe('INVALID_INPUT');
    });

    it('writes the audit row with before and after values', async () => {
      const outcome = await saveEmployeeFeatures({
        employeeId: ADMIN_A,
        grants: [
          { feature: 'module.knowledge', allowed: false },
          { feature: 'course.publish', allowed: true },
        ],
        actorEmployeeId: ADMIN_B,
        ipAddress: '10.0.0.9',
        enabledCapabilities: ALL,
      });
      expect(outcome.ok).toBe(true);
      const map = await featureGrantRepository.mapForEmployee(ADMIN_A);
      expect(map.get('module.knowledge')).toBe(false);
      expect(map.get('course.publish')).toBe(true);

      const audit = await latestAudit();
      expect(audit).not.toBeNull();
      expect(audit?.actor_employee_id).toBe(ADMIN_B);
      expect(audit?.target_employee_id).toBe(ADMIN_A);
      expect(audit?.result).toBe('SUCCESS');
      expect(JSON.parse(audit!.old_value)).toEqual([]);
      expect(JSON.parse(audit!.new_value)).toEqual([
        { feature: 'module.knowledge', allowed: false },
        { feature: 'course.publish', allowed: true },
      ]);

      // 第二次修改的 before 是上一次的状态
      await saveEmployeeFeatures({
        employeeId: ADMIN_A,
        grants: [{ feature: 'module.knowledge', allowed: true }],
        actorEmployeeId: ADMIN_B,
        ipAddress: null,
        enabledCapabilities: ALL,
      });
      const second = await latestAudit();
      expect(JSON.parse(second!.old_value)).toEqual([
        { feature: 'module.knowledge', allowed: false },
        { feature: 'course.publish', allowed: true },
      ]);
      expect(JSON.parse(second!.new_value)).toEqual([
        { feature: 'module.knowledge', allowed: true },
      ]);
    });

    it('refuses to turn off the last usable Admin account management', async () => {
      await db.query(`DELETE FROM employees WHERE employee_id = $1`, [ADMIN_B]);
      const outcome = await saveEmployeeFeatures({
        employeeId: ADMIN_A,
        grants: [{ feature: 'module.accounts', allowed: false }],
        actorEmployeeId: ADMIN_A,
        ipAddress: null,
        enabledCapabilities: ALL,
      });
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.code).toBe(
        'PROTECTED_ADMIN_ACCOUNT',
      );
      expect(await grantRows()).toEqual([]);
    });

    it('allows turning off one Admin while another usable Admin remains', async () => {
      const outcome = await saveEmployeeFeatures({
        employeeId: ADMIN_A,
        grants: [{ feature: 'module.accounts', allowed: false }],
        actorEmployeeId: ADMIN_A,
        ipAddress: null,
        enabledCapabilities: ALL,
      });
      expect(outcome.ok).toBe(true);
      const map = await featureGrantRepository.mapForEmployee(ADMIN_A);
      expect(map.get('module.accounts')).toBe(false);
    });

    it('does not count Admins who already have accounts switched off', async () => {
      await featureGrantRepository.replaceForEmployee(
        ADMIN_B,
        [{ feature: 'module.accounts', allowed: false }],
        ADMIN_A,
      );
      const outcome = await saveEmployeeFeatures({
        employeeId: ADMIN_A,
        grants: [{ feature: 'module.accounts', allowed: false }],
        actorEmployeeId: ADMIN_A,
        ipAddress: null,
        enabledCapabilities: ALL,
      });
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.code).toBe(
        'PROTECTED_ADMIN_ACCOUNT',
      );
    });

    it('never lets an account switch exceed the environment capability', async () => {
      const restricted = parseEnabledCapabilities('course,accounts');
      const outcome = await saveEmployeeFeatures({
        employeeId: FINANCE_C,
        grants: [
          { feature: 'module.knowledge', allowed: true },
          { feature: 'course.publish', allowed: true },
        ],
        actorEmployeeId: ADMIN_A,
        ipAddress: null,
        enabledCapabilities: restricted,
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        const byKey = new Map(
          outcome.view.effective.map((entry) => [entry.key, entry]),
        );
        expect(byKey.get('module.knowledge')?.allowed).toBe(false);
        // 环境没开 knowledge：即便账号开关允许，也不生效
        expect(byKey.get('module.knowledge')?.level).toBe('NONE');
        // course 能力开着，动作开关照常生效
        expect(byKey.get('course.publish')?.allowed).toBe(true);
      }

      const noAccounts = parseEnabledCapabilities('course');
      expect(
        effectiveModuleLevel(
          'ADMIN',
          'module.accounts',
          new Map([['module.accounts', true]]),
          noAccounts,
        ),
      ).toBe('NONE');
    });
  });

  describe('last usable Admin — role/status and concurrency', () => {
    it('refuses to demote or deactivate the last usable Admin (self-lockout)', async () => {
      await db.query(`DELETE FROM employees WHERE employee_id = $1`, [ADMIN_B]);
      const demote = await updateEmployee({
        employeeId: ADMIN_A,
        role: 'FINANCE',
        actorEmployeeId: ADMIN_A,
        locale: 'en-GB',
        appUrl: 'http://localhost',
        ipAddress: null,
      });
      expect(demote.ok).toBe(false);
      expect(demote.ok === false && demote.code).toBe(
        'PROTECTED_ADMIN_ACCOUNT',
      );
      const inactive = await updateEmployee({
        employeeId: ADMIN_A,
        accountStatus: 'INACTIVE',
        actorEmployeeId: ADMIN_A,
        locale: 'en-GB',
        appUrl: 'http://localhost',
        ipAddress: null,
      });
      expect(inactive.ok).toBe(false);
      expect(inactive.ok === false && inactive.code).toBe(
        'PROTECTED_ADMIN_ACCOUNT',
      );
      const rows = await db.query<{ role: string; account_status: string }>(
        `SELECT role, account_status FROM employees WHERE employee_id = $1`,
        [ADMIN_A],
      );
      expect(rows[0]).toEqual({ role: 'ADMIN', account_status: 'ACTIVE' });
    });

    it('allows demotion when another usable Admin remains', async () => {
      const outcome = await updateEmployee({
        employeeId: ADMIN_A,
        role: 'FINANCE',
        actorEmployeeId: ADMIN_A,
        locale: 'en-GB',
        appUrl: 'http://localhost',
        ipAddress: null,
      });
      expect(outcome.ok).toBe(true);
    });

    it('serializes concurrent account-management shutoffs (no 0-admin outcome)', async () => {
      const [a, b] = await Promise.all([
        saveEmployeeFeatures({
          employeeId: ADMIN_A,
          grants: [{ feature: 'module.accounts', allowed: false }],
          actorEmployeeId: ADMIN_A,
          ipAddress: null,
          enabledCapabilities: ALL,
        }),
        saveEmployeeFeatures({
          employeeId: ADMIN_B,
          grants: [{ feature: 'module.accounts', allowed: false }],
          actorEmployeeId: ADMIN_B,
          ipAddress: null,
          enabledCapabilities: ALL,
        }),
      ]);
      const successes = [a, b].filter((outcome) => outcome.ok).length;
      expect(successes).toBe(1);
      const capable = await db.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM employees e
          WHERE e.role = 'ADMIN' AND e.account_status = 'ACTIVE'
            AND e.email_verification = 'VERIFIED'
            AND NOT EXISTS (
              SELECT 1 FROM employee_feature_grants g
               WHERE g.employee_id = e.employee_id
                 AND g.feature = 'module.accounts' AND g.allowed = false
            )`,
      );
      expect(capable[0]?.count).toBe(1);
    });
  });
});
