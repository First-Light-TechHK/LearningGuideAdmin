import { query } from "@/lib/db";

export type SessionRecord = {
  sessionId: string;
  employeeId: string;
  expiresAt: Date;
};

type SessionRow = {
  session_id: string;
  employee_id: string;
  expires_at: Date;
  revoked_at: Date | null;
};

export async function createSession(input: {
  employeeId: string;
  tokenHash: string;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
}): Promise<SessionRecord> {
  const rows = await query<SessionRow>(
    `INSERT INTO employee_sessions (employee_id, token_hash, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING session_id, employee_id, expires_at, revoked_at`,
    [input.employeeId, input.tokenHash, input.expiresAt, input.ipAddress, input.userAgent]
  );
  const row = rows[0];
  if (!row) throw new Error("Failed to create employee session");
  return { sessionId: row.session_id, employeeId: row.employee_id, expiresAt: row.expires_at };
}

/** 只返回未吊销、未过期且未空闲超时的会话。 */
export async function findActiveSession(
  tokenHash: string,
  idleCutoff: Date
): Promise<{ sessionId: string; employeeId: string } | null> {
  const rows = await query<SessionRow>(
    `SELECT session_id, employee_id, expires_at, revoked_at
       FROM employee_sessions
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > now()
        AND last_seen_at > $2`,
    [tokenHash, idleCutoff]
  );
  const row = rows[0];
  return row ? { sessionId: row.session_id, employeeId: row.employee_id } : null;
}

export async function touchSession(sessionId: string): Promise<void> {
  await query(`UPDATE employee_sessions SET last_seen_at = now() WHERE session_id = $1`, [
    sessionId,
  ]);
}

export async function revokeSession(sessionId: string): Promise<void> {
  await query(
    `UPDATE employee_sessions SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL`,
    [sessionId]
  );
}

export async function revokeByTokenHash(tokenHash: string): Promise<void> {
  await query(
    `UPDATE employee_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash]
  );
}

/** PRD BR-PORT-013：停用员工立即吊销全部会话。 */
export async function revokeAllForEmployee(employeeId: string): Promise<number> {
  const rows = await query<{ session_id: string }>(
    `UPDATE employee_sessions
        SET revoked_at = now()
      WHERE employee_id = $1 AND revoked_at IS NULL
      RETURNING session_id`,
    [employeeId]
  );
  return rows.length;
}
