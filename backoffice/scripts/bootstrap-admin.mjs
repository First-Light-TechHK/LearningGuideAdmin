import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";

import pg from "pg";

import { loadEnv, requireEnv } from "./env.mjs";

const scrypt = promisify(scryptCallback);

loadEnv();

/** 与 modules/user-authentication/services/password.ts 保持同一存储格式。 */
async function hashPassword(plain) {
  const salt = randomBytes(16);
  const derived = await scrypt(plain, salt, 64);
  return ["scrypt", 16384, 8, 1, salt.toString("base64"), derived.toString("base64")].join("$");
}

async function main() {
  const email = requireEnv("BOOTSTRAP_ADMIN_EMAIL").trim().toLowerCase();
  const password = requireEnv("BOOTSTRAP_ADMIN_PASSWORD");

  if (password.length < 12) {
    throw new Error("BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters");
  }

  const client = new pg.Client({ connectionString: requireEnv("DATABASE_URL") });
  await client.connect();

  try {
    const passwordHash = await hashPassword(password);
    const existing = await client.query(
      "SELECT employee_id, is_bootstrap_admin FROM employees WHERE login_email = $1",
      [email]
    );

    if (existing.rowCount === 0) {
      await client.query(
        `INSERT INTO employees
           (login_email, role, account_status, email_verification, email_verified_at,
            password_hash, is_bootstrap_admin)
         VALUES ($1, 'ADMIN', 'ACTIVE', 'VERIFIED', now(), $2, true)`,
        [email, passwordHash]
      );
      console.log(`bootstrap admin created: ${email}`);
    } else {
      const row = existing.rows[0];
      if (!row.is_bootstrap_admin) {
        throw new Error(
          `${email} already exists and is not a bootstrap admin. Refusing to overwrite.`
        );
      }
      await client.query(
        `UPDATE employees
            SET password_hash = $2,
                account_status = 'ACTIVE',
                email_verification = 'VERIFIED',
                email_verified_at = COALESCE(email_verified_at, now()),
                updated_at = now()
          WHERE employee_id = $1`,
        [row.employee_id, passwordHash]
      );
      console.log(`bootstrap admin password rotated: ${email}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
