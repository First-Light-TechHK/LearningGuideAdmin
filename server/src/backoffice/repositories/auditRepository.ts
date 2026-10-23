import { query } from '../lib/db';

/** PRD §11.3：禁止写入明文密码、会话密钥与原始令牌。 */
export type AuditEventInput = {
  eventName: string;
  actorEmployeeId: string | null;
  targetEmployeeId: string | null;
  action: string;
  oldValue?: string | null;
  newValue?: string | null;
  result: 'SUCCESS' | 'FAILURE' | 'DENIED';
  ipAddress?: string | null;
  requestId?: string | null;
};

export async function recordAuditEvent(event: AuditEventInput): Promise<void> {
  await query(
    `INSERT INTO audit_events
       (event_name, actor_employee_id, target_employee_id, action,
        old_value, new_value, result, ip_address, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      event.eventName,
      event.actorEmployeeId,
      event.targetEmployeeId,
      event.action,
      event.oldValue ?? null,
      event.newValue ?? null,
      event.result,
      event.ipAddress ?? null,
      event.requestId ?? null,
    ],
  );
}

/** 审计失败不应让主流程失败（例如目标员工已被并发删除）。 */
export async function tryRecordAuditEvent(
  event: AuditEventInput,
): Promise<void> {
  try {
    await recordAuditEvent(event);
  } catch {
    // 故意吞掉：审计不可写时优先保证业务响应
  }
}
