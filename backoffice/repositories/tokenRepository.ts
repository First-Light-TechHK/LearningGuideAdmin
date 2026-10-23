import { query, withTransaction } from "@/lib/db";

export type TokenPurpose = "ACTIVATION" | "PASSWORD_RESET";

export type TokenRecord = {
  tokenId: string;
  employeeId: string;
  purpose: TokenPurpose;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
};

type TokenRow = {
  token_id: string;
  employee_id: string;
  purpose: TokenPurpose;
  expires_at: Date;
  consumed_at: Date | null;
  revoked_at: Date | null;
};

function toRecord(row: TokenRow): TokenRecord {
  return {
    tokenId: row.token_id,
    employeeId: row.employee_id,
    purpose: row.purpose,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * 只保存令牌的 HMAC，原始令牌只出现在邮件链接里（PORT-SEC-006）。
 * 同用途的旧令牌在签发新令牌时立即吊销（PORT-ACT-004 / PORT-ACT-005）。
 */
export async function issueToken(input: {
  employeeId: string;
  purpose: TokenPurpose;
  tokenHash: string;
  expiresAt: Date;
}): Promise<TokenRecord> {
  return withTransaction(async (client) => {
    await client.query(
      `UPDATE verification_tokens
          SET revoked_at = now()
        WHERE employee_id = $1 AND purpose = $2
          AND consumed_at IS NULL AND revoked_at IS NULL`,
      [input.employeeId, input.purpose]
    );
    const result = await client.query<TokenRow>(
      `INSERT INTO verification_tokens (employee_id, purpose, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING token_id, employee_id, purpose, expires_at, consumed_at, revoked_at`,
      [input.employeeId, input.purpose, input.tokenHash, input.expiresAt]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Failed to issue verification token");
    return toRecord(row);
  });
}

/** 不论状态如何都返回，供服务层区分「不存在 / 已使用 / 已过期」。 */
export async function findByHash(
  tokenHash: string,
  purpose: TokenPurpose
): Promise<TokenRecord | null> {
  const rows = await query<TokenRow>(
    `SELECT token_id, employee_id, purpose, expires_at, consumed_at, revoked_at
       FROM verification_tokens
      WHERE token_hash = $1 AND purpose = $2
      LIMIT 1`,
    [tokenHash, purpose]
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function findUsableToken(
  tokenHash: string,
  purpose: TokenPurpose
): Promise<TokenRecord | null> {
  const rows = await query<TokenRow>(
    `SELECT token_id, employee_id, purpose, expires_at, consumed_at, revoked_at
       FROM verification_tokens
      WHERE token_hash = $1 AND purpose = $2
        AND consumed_at IS NULL AND revoked_at IS NULL
      LIMIT 1`,
    [tokenHash, purpose]
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

/**
 * 单次消费：只有真正把 consumed_at 由 NULL 改为 now() 的调用方拿到 true，
 * 并发请求里其余调用全部失败（INV-ONE-USE-TOKEN）。
 */
export async function consumeToken(tokenId: string): Promise<boolean> {
  const rows = await query<{ token_id: string }>(
    `UPDATE verification_tokens
        SET consumed_at = now()
      WHERE token_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL
      RETURNING token_id`,
    [tokenId]
  );
  return rows.length === 1;
}

export async function revokeOutstandingTokens(
  employeeId: string,
  purpose?: TokenPurpose
): Promise<void> {
  if (purpose) {
    await query(
      `UPDATE verification_tokens SET revoked_at = now()
        WHERE employee_id = $1 AND purpose = $2
          AND consumed_at IS NULL AND revoked_at IS NULL`,
      [employeeId, purpose]
    );
    return;
  }
  await query(
    `UPDATE verification_tokens SET revoked_at = now()
      WHERE employee_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`,
    [employeeId]
  );
}
