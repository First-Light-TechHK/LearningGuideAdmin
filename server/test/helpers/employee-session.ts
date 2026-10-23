import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';

import { query } from '../../src/backoffice/lib/db';
import { hashPassword } from '../../src/backoffice/modules/user-authentication/services/password';

export const E2E_PASSWORD = 'e2e-password-123';

/** 建（或复位）一个已激活的员工账号，返回登录邮箱。 */
export async function ensureEmployee(
  email: string,
  role: string,
): Promise<string> {
  const passwordHash = await hashPassword(E2E_PASSWORD);
  await query(
    `INSERT INTO employees
       (login_email, role, account_status, email_verification, email_verified_at, password_hash)
     VALUES ($1, $2, 'ACTIVE', 'VERIFIED', now(), $3)
     ON CONFLICT (login_email) DO UPDATE
       SET role = EXCLUDED.role, account_status = 'ACTIVE', email_verification = 'VERIFIED',
           email_verified_at = COALESCE(employees.email_verified_at, now()),
           password_hash = EXCLUDED.password_hash, updated_at = now()`,
    [email, role, passwordHash],
  );
  return email;
}

/** 登录限流是进程内存计数，e2e 同一进程里登录很多次，每次登录前清零。 */
export function resetRateLimits(): void {
  globalThis.__lgboRateBuckets?.clear();
}

/** 只清按 IP 计数的登录窗口，用来模拟攻击者不断换 IP。 */
export function resetIpBuckets(): void {
  for (const key of globalThis.__lgboRateBuckets?.keys() ?? []) {
    if (key.startsWith('sign-in:')) globalThis.__lgboRateBuckets?.delete(key);
  }
}

/** 以指定角色登录，返回带会话 Cookie 的 supertest agent。 */
export async function signInAs(app: INestApplication<App>, role = 'ADMIN') {
  const email = await ensureEmployee(
    `e2e-${role.toLowerCase().replace(/_/g, '-')}@example.com`,
    role,
  );
  resetRateLimits();
  const agent = request.agent(app.getHttpServer());
  await agent
    .post('/api/auth/sign-in')
    .send({ email, password: E2E_PASSWORD })
    .expect(200);
  return agent;
}
