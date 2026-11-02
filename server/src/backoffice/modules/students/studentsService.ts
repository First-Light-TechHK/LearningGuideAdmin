import type { SessionEmployee } from '../../contracts/employee';
import type { AuditEventInput } from '../../repositories/auditRepository';
import {
  FEATURE_KEYS,
  OVERRIDE_VALUES,
  SPECIAL_ACCESS_FILTERS,
  STUDENT_ACTIONS,
  STUDENT_PAGE_SIZE_MAX,
  STUDENT_REASON_MAX,
  STUDENT_REFERENCE_MAX,
  STUDENT_STATUS_FILTERS,
  SUBSCRIPTION_FILTERS,
  type FeatureKey,
  type OverrideValue,
  type StaffActor,
} from './contracts';
import {
  StudentsError,
  type PortalStudentsClient,
} from './portalStudentsClient';

/**
 * 学生管理（PRD §3–§7）：只做输入校验、注入操作人、写 BackOffice 审计，数据与判定全在 Portal。
 * 权限由全局守卫按菜单校验（读 = VIEW；写 = FULL，只有 Admin / Operation Admin），这里不再判断角色。
 */
export type StudentsService = ReturnType<typeof createStudentsService>;

function invalid(message: string): StudentsError {
  return new StudentsError(400, 'INVALID_INPUT', message);
}

function record(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function text(
  raw: unknown,
  field: string,
  max: number,
  required = true,
): string {
  if (raw === undefined || raw === null) {
    if (required) throw invalid(`${field} is required`);
    return '';
  }
  if (typeof raw !== 'string') throw invalid(`${field} must be text`);
  const value = raw.trim();
  if (required && value === '') throw invalid(`${field} is required`);
  if (value.length > max) throw invalid(`${field} is too long`);
  return value;
}

function oneOf<T extends string>(
  values: readonly T[],
  raw: unknown,
  field: string,
): T {
  if (typeof raw === 'string' && (values as readonly string[]).includes(raw))
    return raw as T;
  throw invalid(`${field} is not valid`);
}

/** 查询参数原样（unknown）交进来：重复参数（数组）或非文本一律 400。 */
function queryValue(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string') throw invalid(`${field} is not valid`);
  return raw;
}

const STUDENT_ID = /^[A-Za-z0-9_-]{1,80}$/;

function studentId(raw: string): string {
  if (!STUDENT_ID.test(raw))
    throw new StudentsError(404, 'STUDENT_NOT_FOUND', 'Student not found');
  return raw;
}

function actorOf(employee: SessionEmployee): StaffActor {
  return {
    id: employee.employeeId,
    name: employee.displayName || employee.loginEmail,
    role: employee.role,
  };
}

export function createStudentsService(deps: {
  portal: PortalStudentsClient;
  audit: (event: AuditEventInput) => Promise<void>;
}) {
  const { portal } = deps;

  async function audit(
    employee: SessionEmployee,
    eventName: string,
    action: string,
    values: { old?: unknown; new?: unknown },
    result: AuditEventInput['result'] = 'SUCCESS',
  ) {
    await deps.audit({
      eventName,
      actorEmployeeId: employee.employeeId,
      targetEmployeeId: null,
      action,
      oldValue: values.old === undefined ? null : JSON.stringify(values.old),
      newValue: values.new === undefined ? null : JSON.stringify(values.new),
      result,
    });
  }

  /** 失败也记一笔（被拒的敏感操作同样要可追溯），再把原错误抛回给员工。 */
  async function audited<T>(
    employee: SessionEmployee,
    eventName: string,
    action: string,
    request: unknown,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await work();
      await audit(employee, eventName, action, { new: request });
      return result;
    } catch (error) {
      if (error instanceof StudentsError && error.status < 500)
        await audit(
          employee,
          eventName,
          action,
          { new: { request, error: error.code } },
          'FAILURE',
        );
      throw error;
    }
  }

  return {
    async list(query: Record<string, unknown>) {
      const params = new URLSearchParams();
      const q = queryValue(query.q, 'q');
      if (q !== undefined) params.set('q', text(q, 'q', 120, false));
      const status = queryValue(query.status, 'status');
      if (status && status !== 'all')
        params.set('status', oneOf(STUDENT_STATUS_FILTERS, status, 'status'));
      const subscription = queryValue(query.subscription, 'subscription');
      if (subscription && subscription !== 'all')
        params.set(
          'subscription',
          oneOf(SUBSCRIPTION_FILTERS, subscription, 'subscription'),
        );
      const special = queryValue(query.special, 'special');
      if (special && special !== 'all')
        params.set(
          'special',
          oneOf(SPECIAL_ACCESS_FILTERS, special, 'special'),
        );
      const page = Number(queryValue(query.page, 'page') ?? '1');
      const pageSize = Number(queryValue(query.pageSize, 'pageSize') ?? '10');
      if (!Number.isInteger(page) || page < 1)
        throw invalid('page is not valid');
      if (
        !Number.isInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > STUDENT_PAGE_SIZE_MAX
      )
        throw invalid('pageSize is not valid');
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      return portal.get(`/students?${params.toString()}`);
    },

    async detail(rawId: string) {
      return portal.get(`/students/${encodeURIComponent(studentId(rawId))}`);
    },

    async saveOverrides(
      employee: SessionEmployee,
      rawId: string,
      rawBody: unknown,
    ) {
      const id = studentId(rawId);
      const body = record(rawBody);
      const raw = record(body.overrides);
      const overrides: Partial<Record<FeatureKey, OverrideValue>> = {};
      for (const [key, value] of Object.entries(raw)) {
        overrides[oneOf(FEATURE_KEYS, key, 'feature')] = oneOf(
          OVERRIDE_VALUES,
          value,
          'override',
        );
      }
      if (Object.keys(overrides).length === 0)
        throw invalid('Change at least one feature');
      const payload = {
        reason: text(body.reason, 'reason', STUDENT_REASON_MAX),
        expectedVersion: text(body.expectedVersion, 'expectedVersion', 64),
        overrides,
      };
      return audited(
        employee,
        'student_feature_override_changed',
        `student:${id}`,
        payload,
        () =>
          portal.write(
            'PUT',
            `/students/${encodeURIComponent(id)}/feature-overrides`,
            payload,
            actorOf(employee),
          ),
      );
    },

    async act(employee: SessionEmployee, rawId: string, rawBody: unknown) {
      const id = studentId(rawId);
      const body = record(rawBody);
      const action = oneOf(STUDENT_ACTIONS, body.action, 'action');
      let payload: Record<string, unknown>;
      if (action === 'deactivate' || action === 'activate') {
        payload = {
          action,
          reason: text(body.reason, 'reason', STUDENT_REASON_MAX),
        };
      } else if (action === 'change_email') {
        const exemption =
          body.exemption === undefined || body.exemption === null
            ? null
            : record(body.exemption);
        payload = {
          action,
          email: text(body.email, 'email', 254).toLowerCase(),
          reason: text(body.reason, 'reason', STUDENT_REASON_MAX),
          exemption: exemption
            ? {
                reference: text(
                  exemption.reference,
                  'exemption.reference',
                  STUDENT_REFERENCE_MAX,
                ),
              }
            : null,
        };
      } else {
        payload = { action };
      }
      return audited(
        employee,
        `student_${action}`,
        `student:${id}`,
        payload,
        () =>
          portal.write(
            'POST',
            `/students/${encodeURIComponent(id)}/actions`,
            payload,
            actorOf(employee),
          ),
      );
    },

    async settings() {
      return portal.get('/feature-access');
    },

    async saveSettings(employee: SessionEmployee, rawBody: unknown) {
      const body = record(rawBody);
      const raw = record(body.features);
      const features: Partial<Record<FeatureKey, { enabled: boolean }>> = {};
      for (const [key, value] of Object.entries(raw)) {
        const enabled = record(value).enabled;
        if (typeof enabled !== 'boolean')
          throw invalid('enabled must be true or false');
        features[oneOf(FEATURE_KEYS, key, 'feature')] = { enabled };
      }
      if (Object.keys(features).length === 0)
        throw invalid('Change at least one feature');
      const payload = {
        reason: text(body.reason, 'reason', STUDENT_REASON_MAX, false),
        expectedVersion: text(body.expectedVersion, 'expectedVersion', 64),
        features,
      };
      return audited(
        employee,
        'feature_global_changed',
        'feature-access',
        payload,
        () =>
          portal.write('PUT', '/feature-access', payload, actorOf(employee)),
      );
    },

    async emergency(employee: SessionEmployee, rawBody: unknown) {
      const body = record(rawBody);
      if (typeof body.off !== 'boolean')
        throw invalid('off must be true or false');
      const payload = {
        feature: oneOf(FEATURE_KEYS, body.feature, 'feature'),
        off: body.off,
        reason: text(body.reason, 'reason', STUDENT_REASON_MAX),
      };
      return audited(
        employee,
        body.off ? 'feature_emergency_off' : 'feature_emergency_resumed',
        'feature-access',
        payload,
        () =>
          portal.write(
            'POST',
            '/feature-access/emergency',
            payload,
            actorOf(employee),
          ),
      );
    },
  };
}
